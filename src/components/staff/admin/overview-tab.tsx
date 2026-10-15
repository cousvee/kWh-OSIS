"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { wibDateTime } from "@/lib/kwh/time";
import type { ActiveEvent } from "@/lib/kwh/types";
import type { FullReport } from "@/lib/kwh/admin-types";
import { Card, ErrorBanner, Stat } from "./ui";

interface Props {
  report: FullReport | null;
  reportState: "loading" | "ok" | "none";
  activeEvent: ActiveEvent | null | undefined;
  reload: () => Promise<void>;
  goTo: (tab: "acara") => void;
}

export function OverviewTab({ report, reportState, activeEvent, reload, goTo }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  async function setAccepting(accepting: boolean) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await staffRpc("set_accepting_orders", { p_accepting: accepting });
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      lock.current = false;
      setBusy(false);
      await reload();
    }
  }

  if (reportState === "loading") return <p className="py-10 text-center text-muted-foreground">Memuat…</p>;
  if (reportState === "none" || !report) {
    return (
      <Card title="Belum ada acara aktif">
        <p className="mb-4 text-muted-foreground">Mulai acara baru di tab Acara, atau pilih acara lama di atas untuk melihat laporannya.</p>
        <button type="button" onClick={() => goTo("acara")} className="min-h-12 rounded-xl bg-primary px-5 font-bold text-primary-foreground">
          Ke tab Acara
        </button>
      </Card>
    );
  }

  const t = report.totals;
  const rec = report.reconciliation;
  const isActive = !!activeEvent && activeEvent.id === report.event.id;
  const open = activeEvent?.accepting_orders !== false;

  return (
    <div className="grid gap-4">
      <ErrorBanner message={error} />

      {isActive && (
        <Card label="Kontrol acara" title="Kontrol pemesanan">
          <p
            data-testid="ordering-state"
            className={cn("mb-2 inline-block rounded-full px-4 py-1 text-sm font-extrabold", open ? "bg-emerald-600 text-white" : "bg-amber-500 text-black")}
          >
            {open ? "PEMESANAN DIBUKA" : "PEMESANAN DITUTUP SEMENTARA"}
          </p>
          <p className="mb-3 text-sm text-muted-foreground">
            {open
              ? "Tutup sementara jika dapur kewalahan. Pelanggan masih bisa melihat menu, tetapi tidak bisa memesan."
              : "Pelanggan tidak bisa membuat pesanan baru. Pesanan yang sudah masuk tetap diproses."}
          </p>
          <button
            type="button"
            onClick={() => void setAccepting(!open)}
            disabled={busy}
            className={cn("min-h-14 w-full rounded-2xl text-lg font-extrabold active:scale-[0.98] disabled:opacity-50", open ? "bg-amber-500 text-black" : "bg-emerald-600 text-white")}
          >
            {open ? "TUTUP PEMESANAN SEMENTARA" : "BUKA PEMESANAN LAGI"}
          </button>
        </Card>
      )}

      <section aria-label="Angka utama" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Pesanan aktif" value={String(t.active_orders)} />
        <Stat label="Pendapatan (semua pesanan aktif)" value={formatRupiah(t.active_revenue)} testId="kpi-revenue" />
        <Stat label="Sudah dibayar" value={formatRupiah(t.paid_total)} tone="good" testId="kpi-paid" />
        <Stat label="Belum dibayar" value={formatRupiah(t.debt_total)} tone={t.debt_total > 0 ? "warn" : undefined} testId="kpi-debt" />
        <Stat label="Dibatalkan" value={`${t.cancelled_orders} · ${formatRupiah(t.cancelled_value)}`} />
        <Stat label="Item terjual" value={String(t.items_sold)} />
        <Stat label="Total modal" value={formatRupiah(report.expenses.total_modal)} testId="kpi-modal" />
        <Stat label="Laba bersih" value={formatRupiah(report.profit.net)} tone={report.profit.net >= 0 ? "good" : "bad"} testId="kpi-profit" />
      </section>

      <Card label="Rekonsiliasi" title="Pemeriksaan data">
        <p
          data-testid="reconciliation"
          className={cn("mb-2 inline-block rounded-full px-4 py-1 text-base font-extrabold", rec.reconciled ? "bg-emerald-600 text-white" : "bg-destructive text-white")}
        >
          {rec.reconciled ? "✓ RECONCILED" : "⚠ ADA SELISIH"}
        </p>
        <p className="text-sm text-muted-foreground">
          Pendapatan {formatRupiah(rec.active_revenue)} = Dibayar {formatRupiah(t.paid_total)} + Belum dibayar {formatRupiah(t.debt_total)} ({formatRupiah(rec.paid_plus_debt)})
        </p>
        {!rec.reconciled && (
          <div className="mt-3 space-y-2 text-sm">
            <p>Selisih: <b>{formatRupiah(rec.difference)}</b> · Total item: {formatRupiah(rec.items_total)} · Buku pembayaran: {formatRupiah(rec.ledger_net_paid)}</p>
            {rec.issues.length > 0 && (
              <ul className="space-y-1">
                {rec.issues.map((i) => (
                  <li key={i.queue_number} className="rounded-lg bg-destructive/10 px-3 py-2">
                    #{i.queue_number}: {i.issue === "ITEMS_TOTAL_MISMATCH" ? "total pesanan ≠ jumlah item" : "pembayaran ≠ buku pembayaran"} (total {formatRupiah(i.total_amount)}, item {formatRupiah(i.items_sum)}, buku {formatRupiah(i.ledger_net)})
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card title="Penjualan per produk">
        {report.products.length === 0 ? (
          <p className="text-muted-foreground">Belum ada penjualan.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground"><tr><th className="py-1">Produk</th><th className="text-right">Terjual</th><th className="text-right">Pendapatan</th></tr></thead>
              <tbody>
                {report.products.map((p) => (
                  <tr key={p.product_name} className="border-t"><td className="py-2">{p.product_name}</td><td className="text-right tabular-nums">{p.quantity}</td><td className="text-right tabular-nums">{formatRupiah(p.revenue)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Pesanan dibatalkan (audit)">
        {report.cancelled.length === 0 ? (
          <p className="text-muted-foreground">Tidak ada.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {report.cancelled.map((c) => (
              <li key={c.queue_number} className="rounded-lg bg-secondary px-3 py-2">
                <b>#{c.queue_number}</b> {c.customer_name} · {c.customer_class} · {formatRupiah(c.total_amount)} — <i>{c.cancel_reason}</i>
                <span className="text-muted-foreground"> ({c.cancelled_by_role}, {wibDateTime(c.cancelled_at)})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Pembatalan pembayaran (audit)">
        {report.reversals.length === 0 ? (
          <p className="text-muted-foreground">Tidak ada.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {report.reversals.map((v, i) => (
              <li key={i} className="rounded-lg bg-secondary px-3 py-2">
                <b>#{v.queue_number}</b> {formatRupiah(v.amount)} — <i>{v.note}</i>
                <span className="text-muted-foreground"> ({v.recorded_by_role}, {wibDateTime(v.created_at)})</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Layar">
        <p className="mb-3 text-sm text-muted-foreground">
          Alamat layar TV (tanpa login): <b data-testid="tv-address">{origin ? `${origin}/antrian` : "…/antrian"}</b>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Link href="/staff/kitchen" className="flex min-h-12 items-center justify-center rounded-xl border font-semibold">Layar Dapur</Link>
          <Link href="/staff/cashier" className="flex min-h-12 items-center justify-center rounded-xl border font-semibold">Layar Kasir</Link>
          <Link href="/antrian" className="flex min-h-12 items-center justify-center rounded-xl border font-semibold">Layar Antrian (TV)</Link>
          <Link href="/" className="flex min-h-12 items-center justify-center rounded-xl border font-semibold">Layar Pelanggan</Link>
        </div>
      </Card>
    </div>
  );
}
