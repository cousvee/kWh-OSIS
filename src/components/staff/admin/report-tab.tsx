"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { wibDateTime, wibReadable } from "@/lib/kwh/time";
import { CATEGORY_LABELS } from "@/lib/kwh/types";
import { buildExpensesRows, buildOrdersRows, buildProductsRows, buildReportRows, downloadCsv, safeFilename } from "@/lib/kwh/csv";
import type { AdminOrder, Expense, FullReport } from "@/lib/kwh/admin-types";
import { ErrorBanner, btnGhost, btnPrimary, digits, inputClass } from "./ui";

const STATUS = { active: "Berlangsung", completed: "Selesai", archived: "Diarsipkan" } as const;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : 0);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="break-inside-avoid">
      <h3 className="mb-2 border-b pb-1 text-base font-extrabold">{title}</h3>
      {children}
    </section>
  );
}
function KV({ rows }: { rows: [string, string | number | null][] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt>{k}</dt>
          <dd className="text-right font-semibold tabular-nums">{v ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}
function Table({ head, rows, foot }: { head: string[]; rows: (string | number)[][]; foot?: (string | number)[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr className="text-muted-foreground">{head.map((h, i) => <th key={h} className={cn("py-1", i > 0 && "text-right")}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t">{r.map((c, i) => <td key={i} className={cn("py-1.5", i > 0 && "text-right tabular-nums")}>{c}</td>)}</tr>
          ))}
          {foot && <tr className="border-t-2 font-extrabold">{foot.map((c, i) => <td key={i} className={cn("py-1.5", i > 0 && "text-right tabular-nums")}>{c}</td>)}</tr>}
        </tbody>
      </table>
    </div>
  );
}

export function ReportTab({ report, eventId, readOnly, reload }: { report: FullReport | null; eventId: string | null; readOnly: boolean; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [cashAmount, setCashAmount] = useState("");
  const [cashNote, setCashNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (!report) return <p className="py-10 text-center text-muted-foreground">Belum ada laporan. Mulai acara atau pilih acara lama di atas.</p>;

  const t = report.totals;
  const name = safeFilename(report.event.name);

  async function dl(kind: "laporan" | "pesanan" | "modal" | "produk") {
    setError(null);
    try {
      const r = report as FullReport;
      const printed = `${wibDateTime(new Date())} WIB`;
      if (kind === "laporan") downloadCsv(`laporan_${name}.csv`, buildReportRows(r, printed));
      else if (kind === "produk") downloadCsv(`penjualan_produk_${name}.csv`, buildProductsRows(r));
      else if (kind === "pesanan") {
        const list = await staffRpc<AdminOrder[]>("list_event_orders", { p_event_id: r.event.id, p_search: "", p_filter: "all" });
        downloadCsv(`pesanan_${name}.csv`, buildOrdersRows(list));
      } else {
        const list = await staffRpc<Expense[]>("list_expenses", { p_event_id: r.event.id });
        downloadCsv(`modal_${name}.csv`, buildExpensesRows(list));
      }
    } catch (e) {
      setError(messageFor(e));
    }
  }

  async function saveCash() {
    if (busy || cashAmount === "") return;
    setBusy(true);
    setError(null);
    try {
      await staffRpc("set_cash_count", { p_event_id: eventId ?? report?.event.id, p_amount: Number(cashAmount), p_note: cashNote });
      setCashAmount("");
      setCashNote("");
      await reload();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <ErrorBanner message={error} />

      <section aria-label="Unduh laporan" className="rounded-2xl border bg-card p-4 print:hidden">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} onClick={() => window.print()}>Cetak / Simpan PDF</button>
          <button type="button" className={btnGhost} onClick={() => void dl("laporan")}>Unduh CSV Laporan</button>
          <button type="button" className={btnGhost} onClick={() => void dl("pesanan")}>Unduh CSV Pesanan</button>
          <button type="button" className={btnGhost} onClick={() => void dl("modal")}>Unduh CSV Modal</button>
          <button type="button" className={btnGhost} onClick={() => void dl("produk")}>Unduh CSV Penjualan Produk</button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">CSV memakai pemisah titik koma (;) dan angka polos, supaya terbuka rapi di Excel berbahasa Indonesia.</p>
      </section>

      {!readOnly && (
        <section aria-label="Hitung kas akhir" className="rounded-2xl border bg-card p-4 print:hidden">
          <h2 className="mb-1 text-lg font-extrabold">Hitung kas akhir</h2>
          <p className="mb-3 text-sm text-muted-foreground">Masukkan uang tunai yang benar-benar dihitung. Sistem membandingkannya dengan total yang tercatat dibayar ({formatRupiah(t.paid_total)}).</p>
          <div className="grid gap-3 md:grid-cols-[12rem_1fr_auto]">
            <input inputMode="numeric" value={cashAmount} onChange={(e) => setCashAmount(digits(e.target.value))} placeholder="Jumlah kas (Rp)" aria-label="Kas hasil hitung" className={inputClass} />
            <input value={cashNote} onChange={(e) => setCashNote(e.target.value)} placeholder="Catatan (opsional)" aria-label="Catatan kas" maxLength={200} className={inputClass} />
            <button type="button" className={btnPrimary} disabled={busy || cashAmount === ""} onClick={() => void saveCash()}>SIMPAN KAS</button>
          </div>
        </section>
      )}

      <article id="laporan" aria-label="Laporan penjualan" className="grid gap-6 rounded-2xl border bg-card p-6 print:border-0 print:p-0">
        <header>
          <h2 className="text-2xl font-extrabold">LAPORAN PENJUALAN</h2>
          <KV rows={[
            ["Acara", report.event.name],
            ["Periode", report.period.first_order_at ? `${wibReadable(report.period.first_order_at)} s/d ${wibReadable(report.period.last_order_at)}` : "-"],
            ["Status acara", STATUS[report.event.status]],
            ["Dicetak", wibReadable(new Date().toISOString())],
          ]} />
        </header>

        <Section title="A. Ringkasan Penjualan">
          <KV rows={[
            ["Jumlah pesanan", t.active_orders],
            ["Pesanan dibatalkan", t.cancelled_orders],
            ["Item terjual", t.items_sold],
            ["Penjualan kotor", formatRupiah(t.active_revenue)],
            ["Rata-rata nilai pesanan", formatRupiah(report.profit.avg_order)],
          ]} />
        </Section>

        <Section title="B. Penerimaan">
          <KV rows={[
            ["Sudah dibayar", formatRupiah(t.paid_total)],
            ["Belum dibayar / piutang", formatRupiah(t.debt_total)],
            ["Terkumpul", report.profit.paid_pct === null ? "-" : `${report.profit.paid_pct}%`],
            ["Pemeriksaan data", report.reconciliation.reconciled ? "SESUAI" : "ADA SELISIH"],
          ]} />
        </Section>

        <Section title="C. Laba Rugi">
          <KV rows={[
            ["Pendapatan diterima", formatRupiah(t.paid_total)],
            ["Total modal", formatRupiah(report.expenses.total_modal)],
            ["Laba bersih", formatRupiah(report.profit.net)],
            ["Margin laba", report.profit.margin_pct === null ? "-" : `${report.profit.margin_pct}%`],
          ]} />
        </Section>

        <Section title="D. Penjualan per Kategori">
          <Table head={["Kategori", "Item", "Pendapatan", "Kontribusi"]}
            rows={report.by_category.map((c) => [CATEGORY_LABELS[c.category] ?? c.category, c.items, formatRupiah(c.revenue), `${pct(c.revenue, t.active_revenue)}%`])} />
        </Section>

        <Section title="E. Penjualan per Produk">
          <Table head={["Produk", "Item", "Pendapatan", "Kontribusi"]}
            rows={[...report.products].sort((a, b) => b.revenue - a.revenue).map((p, i) => [`${i + 1}. ${p.product_name}`, p.quantity, formatRupiah(p.revenue), `${pct(p.revenue, t.active_revenue)}%`])} />
        </Section>

        <Section title="F. Penjualan per Jam (WIB)">
          <Table head={["Jam", "Pesanan", "Pendapatan"]} rows={report.by_hour.map((h) => [h.hour, h.orders, formatRupiah(h.revenue)])} />
        </Section>

        <Section title="G. Pembatalan">
          <KV rows={[
            ["Jumlah", t.cancelled_orders],
            ["Nilai", formatRupiah(t.cancelled_value)],
            ["Alasan", report.cancel_reasons.map((x) => `${x.reason} (${x.count})`).join(", ") || "-"],
          ]} />
        </Section>

        <Section title="H. Modal per Pekerja">
          <Table head={["Pekerja", "Total modal", "Sudah diganti", "Sisa diganti"]}
            rows={report.expenses.by_worker.map((w) => [w.worker_name, formatRupiah(w.total), formatRupiah(w.reimbursed), formatRupiah(w.remaining)])}
            foot={["TOTAL", formatRupiah(report.expenses.total_modal), formatRupiah(report.expenses.reimbursed_total), formatRupiah(report.expenses.remaining_total)]} />
        </Section>

        {report.cash && (
          <Section title="I. Kas Akhir">
            <KV rows={[
              ["Kas menurut sistem", formatRupiah(report.cash.system_amount)],
              ["Kas hasil hitung", formatRupiah(report.cash.counted_amount)],
              ["Selisih", formatRupiah(report.cash.difference)],
              ...(report.cash.note ? ([["Catatan", report.cash.note]] as [string, string][]) : []),
            ]} />
          </Section>
        )}

        {report.reversals.length > 0 && (
          <Section title="J. Pembatalan Pembayaran">
            <Table head={["No.", "Jumlah", "Catatan", "Waktu (WIB)"]}
              rows={report.reversals.map((v) => [`#${v.queue_number}`, formatRupiah(v.amount), v.note, wibDateTime(v.created_at)])} />
          </Section>
        )}

        <footer className="mt-4 hidden grid-cols-3 gap-8 pt-10 text-center text-sm print:grid">
          {["Dibuat oleh", "Mengetahui", "Menyetujui"].map((s) => (
            <div key={s}><p>{s}</p><p className="mt-16 border-t pt-1">(............................)</p></div>
          ))}
        </footer>
      </article>
    </div>
  );
}
