import { CATEGORY_LABELS, PAYMENT_LABELS, PRODUCTION_LABELS } from "./types";
import type { AdminOrder, Expense, FullReport } from "./admin-types";
import { EXPENSE_CATEGORIES } from "./admin-types";
import { wibDateTime } from "./time";

export type Cell = string | number | null | undefined;

/**
 * Semicolon-separated + UTF-8 BOM: opens correctly in Excel with Indonesian
 * regional settings. Numbers are written as plain integers (no "Rp", no
 * thousands dots) so Excel can sum them.
 */
const SEP = ";";

function esc(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v).replace(/\r?\n/g, " ");
  // CSV-injection guard: customer-typed text must never be read as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows: Cell[][]): string {
  return "\uFEFF" + rows.map((r) => r.map(esc).join(SEP)).join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, rows: Cell[][]) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "acara";
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : 0);
const STATUS_ACARA = { active: "Berlangsung", completed: "Selesai", archived: "Diarsipkan" } as const;

export function buildReportRows(r: FullReport, printedAt: string): Cell[][] {
  const t = r.totals;
  const rows: Cell[][] = [];
  const blank = () => rows.push([]);

  rows.push(["LAPORAN PENJUALAN"]);
  rows.push(["Acara", r.event.name]);
  rows.push([
    "Periode",
    r.period.first_order_at ? `${wibDateTime(r.period.first_order_at)} s/d ${wibDateTime(r.period.last_order_at)} WIB` : "-",
  ]);
  rows.push(["Status acara", STATUS_ACARA[r.event.status]]);
  rows.push(["Dicetak", printedAt]);
  blank();

  rows.push(["A. RINGKASAN PENJUALAN"]);
  rows.push(["Jumlah pesanan", t.active_orders]);
  rows.push(["Pesanan dibatalkan", t.cancelled_orders]);
  rows.push(["Item terjual", t.items_sold]);
  rows.push(["Penjualan kotor (Rp)", t.active_revenue]);
  rows.push(["Rata-rata nilai pesanan (Rp)", r.profit.avg_order]);
  blank();

  rows.push(["B. PENERIMAAN"]);
  rows.push(["Sudah dibayar (Rp)", t.paid_total]);
  rows.push(["Belum dibayar / piutang (Rp)", t.debt_total]);
  rows.push(["Terkumpul (%)", r.profit.paid_pct]);
  rows.push(["Pemeriksaan data", r.reconciliation.reconciled ? "SESUAI" : "ADA SELISIH"]);
  blank();

  rows.push(["C. LABA RUGI"]);
  rows.push(["Pendapatan diterima (Rp)", t.paid_total]);
  rows.push(["Total modal (Rp)", r.expenses.total_modal]);
  rows.push(["Laba bersih (Rp)", r.profit.net]);
  rows.push(["Margin laba (%)", r.profit.margin_pct]);
  blank();

  rows.push(["D. PENJUALAN PER KATEGORI"]);
  rows.push(["Kategori", "Item", "Pendapatan (Rp)", "Kontribusi (%)"]);
  for (const c of r.by_category) {
    rows.push([CATEGORY_LABELS[c.category] ?? c.category, c.items, c.revenue, pct(c.revenue, t.active_revenue)]);
  }
  blank();

  rows.push(["E. PENJUALAN PER PRODUK"]);
  rows.push(["Peringkat", "Produk", "Item", "Pendapatan (Rp)", "Kontribusi (%)"]);
  [...r.products]
    .sort((a, b) => b.revenue - a.revenue || a.product_name.localeCompare(b.product_name))
    .forEach((p, i) => rows.push([i + 1, p.product_name, p.quantity, p.revenue, pct(p.revenue, t.active_revenue)]));
  blank();

  rows.push(["F. PENJUALAN PER JAM (WIB)"]);
  rows.push(["Jam", "Pesanan", "Pendapatan (Rp)"]);
  for (const h of r.by_hour) rows.push([h.hour, h.orders, h.revenue]);
  blank();

  rows.push(["G. PEMBATALAN"]);
  rows.push(["Jumlah", t.cancelled_orders]);
  rows.push(["Nilai (Rp)", t.cancelled_value]);
  rows.push(["Alasan", r.cancel_reasons.map((x) => `${x.reason} (${x.count})`).join(", ") || "-"]);
  blank();

  rows.push(["H. MODAL PER PEKERJA"]);
  rows.push(["Pekerja", "Total modal (Rp)", "Sudah diganti (Rp)", "Sisa diganti (Rp)"]);
  for (const w of r.expenses.by_worker) rows.push([w.worker_name, w.total, w.reimbursed, w.remaining]);
  rows.push(["TOTAL", r.expenses.total_modal, r.expenses.reimbursed_total, r.expenses.remaining_total]);
  blank();

  if (r.cash) {
    rows.push(["I. KAS AKHIR"]);
    rows.push(["Kas menurut sistem (Rp)", r.cash.system_amount]);
    rows.push(["Kas hasil hitung (Rp)", r.cash.counted_amount]);
    rows.push(["Selisih (Rp)", r.cash.difference]);
    if (r.cash.note) rows.push(["Catatan", r.cash.note]);
    blank();
  }

  if (r.reversals.length > 0) {
    rows.push(["J. PEMBATALAN PEMBAYARAN"]);
    rows.push(["No. Antrian", "Jumlah (Rp)", "Catatan", "Waktu (WIB)"]);
    for (const v of r.reversals) rows.push([v.queue_number, v.amount, v.note, wibDateTime(v.created_at)]);
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

export function buildOrdersRows(orders: AdminOrder[]): Cell[][] {
  const rows: Cell[][] = [
    ["No. Antrian", "Nama", "Kelas", "Pesanan", "Total (Rp)", "Pembayaran", "Status", "Waktu pesan (WIB)", "Waktu bayar (WIB)", "Alasan batal"],
  ];
  for (const o of [...orders].sort((a, b) => a.queue_number.localeCompare(b.queue_number))) {
    rows.push([
      o.queue_number,
      o.customer_name,
      o.customer_class,
      o.items.map((i) => `${i.product_name} x${i.quantity}`).join(", "),
      o.total_amount,
      PAYMENT_LABELS[o.payment_status],
      PRODUCTION_LABELS[o.production_status],
      wibDateTime(o.created_at),
      wibDateTime(o.paid_at),
      o.cancel_reason ?? "",
    ]);
  }
  return rows;
}

export function buildExpensesRows(list: Expense[]): Cell[][] {
  const rows: Cell[][] = [
    ["Tanggal", "Pekerja", "Barang", "Kategori", "Jumlah (Rp)", "No. Nota", "Status ganti", "Tanggal ganti (WIB)", "Status entri", "Alasan dibatalkan"],
  ];
  const label = (c: string) => EXPENSE_CATEGORIES.find((x) => x.value === c)?.label ?? c;
  for (const e of [...list].sort((a, b) => a.spent_on.localeCompare(b.spent_on))) {
    rows.push([
      e.spent_on,
      e.worker_name,
      e.item,
      label(e.category),
      e.amount,
      e.receipt_no ?? "",
      e.reimbursed ? "Sudah diganti" : "Belum diganti",
      wibDateTime(e.reimbursed_at),
      e.voided ? "Dibatalkan" : "Berlaku",
      e.void_reason ?? "",
    ]);
  }
  return rows;
}

export function buildProductsRows(r: FullReport): Cell[][] {
  const rows: Cell[][] = [["Peringkat", "Produk", "Terjual", "Pendapatan (Rp)", "Kontribusi (%)"]];
  [...r.products]
    .sort((a, b) => b.revenue - a.revenue || a.product_name.localeCompare(b.product_name))
    .forEach((p, i) => rows.push([i + 1, p.product_name, p.quantity, p.revenue, pct(p.revenue, r.totals.active_revenue)]));
  return rows;
}
