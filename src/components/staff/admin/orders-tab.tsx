"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { wibDateTime } from "@/lib/kwh/time";
import { PRODUCTION_LABELS } from "@/lib/kwh/types";
import type { AdminOrder } from "@/lib/kwh/admin-types";
import { ErrorBanner, Modal, btnDanger, btnGhost, inputClass } from "./ui";

type Filter = "all" | "unpaid" | "paid" | "cancelled";
const FILTERS: { v: Filter; l: string }[] = [
  { v: "all", l: "Semua" },
  { v: "unpaid", l: "Belum Lunas" },
  { v: "paid", l: "Lunas" },
  { v: "cancelled", l: "Dibatalkan" },
];

export function OrdersTab({ eventId, onChanged }: { eventId: string | null; onChanged: () => Promise<void> }) {
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ kind: "reverse" | "cancel"; order: AdminOrder } | null>(null);
  const [text, setText] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const lock = useRef(false);
  const qref = useRef({ filter: "all" as Filter, q: "", eventId });
  qref.current = { filter, q, eventId };

  useEffect(() => {
    const id = window.setTimeout(() => setQ(search), 250);
    return () => window.clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const cur = qref.current;
    try {
      const list = await staffRpc<AdminOrder[]>("list_event_orders", { p_event_id: cur.eventId, p_search: cur.q, p_filter: cur.filter });
      if (qref.current.filter === cur.filter && qref.current.q === cur.q) {
        setOrders(list);
        setError(null);
      }
    } catch (e) {
      if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) return;
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => window.clearInterval(id);
  }, [load, filter, q, eventId]);

  async function confirm() {
    if (!dialog || lock.current) return;
    lock.current = true;
    setDialogError(null);
    try {
      if (dialog.kind === "reverse") {
        await staffRpc("reverse_order_payment", { p_order_id: dialog.order.id, p_note: text });
      } else {
        await staffRpc("cancel_order", { p_order_id: dialog.order.id, p_reason: text });
      }
      setDialog(null);
      setText("");
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      setDialogError(messageFor(e));
    } finally {
      lock.current = false;
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari nomor antrian, nama, atau kelas" aria-label="Cari pesanan" className={cn(inputClass, "md:max-w-md")} />
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter pesanan">
          {FILTERS.map((f) => (
            <button key={f.v} type="button" role="tab" aria-selected={filter === f.v} onClick={() => setFilter(f.v)}
              className={cn("min-h-12 rounded-xl border px-4 font-semibold", filter === f.v ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
              {f.l}
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner message={error} />

      {orders === null ? (
        <p className="py-10 text-center text-muted-foreground">Memuat…</p>
      ) : orders.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground">Tidak ada pesanan yang cocok.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {orders.map((o) => {
            const cancelled = o.production_status === "cancelled";
            const paid = o.payment_status === "paid";
            return (
              <li key={o.id} data-testid={`order-${o.queue_number}`} className="rounded-2xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-mono text-4xl font-extrabold leading-none">{o.queue_number}</p>
                  <div className="flex flex-col items-end gap-1">
                    <span className={cn("rounded-full px-3 py-1 text-xs font-extrabold", cancelled ? "bg-destructive text-white" : paid ? "bg-emerald-600 text-white" : "bg-amber-500 text-black")}>
                      {cancelled ? "DIBATALKAN" : paid ? "LUNAS" : "BELUM LUNAS"}
                    </span>
                    {!cancelled && <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold">{PRODUCTION_LABELS[o.production_status]}</span>}
                  </div>
                </div>
                <p className="mt-2 font-semibold">{o.customer_name} <span className="font-normal text-muted-foreground">· {o.customer_class} · {wibDateTime(o.created_at)}</span></p>
                <p className="my-2 text-sm text-muted-foreground">{o.items.map((i) => `${i.product_name} × ${i.quantity}`).join(", ")}</p>
                <p className="text-xl font-extrabold tabular-nums">{formatRupiah(o.total_amount)}</p>
                {cancelled && <p className="mt-1 text-sm text-destructive">Alasan: {o.cancel_reason} ({o.cancelled_by_role})</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {paid && !cancelled && (
                    <button type="button" className={btnGhost} onClick={() => { setDialog({ kind: "reverse", order: o }); setText(""); setDialogError(null); }}>
                      Batalkan pembayaran
                    </button>
                  )}
                  {!paid && !cancelled && (
                    <button type="button" className={cn(btnGhost, "text-destructive")} onClick={() => { setDialog({ kind: "cancel", order: o }); setText(""); setDialogError(null); }}>
                      Batalkan pesanan
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog && (
        <Modal title={dialog.kind === "reverse" ? `Batalkan pembayaran #${dialog.order.queue_number}?` : `Batalkan pesanan #${dialog.order.queue_number}?`} onClose={() => setDialog(null)}>
          <p className="mb-3 text-sm text-muted-foreground">
            {dialog.kind === "reverse"
              ? "Pesanan kembali menjadi belum dibayar. Catatan pembayaran asli tetap tersimpan sebagai riwayat."
              : "Pesanan tetap tersimpan di riwayat dan tidak dihitung sebagai pendapatan."}
          </p>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{dialog.kind === "reverse" ? "Catatan admin" : "Alasan pembatalan"}</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={300} className="w-full rounded-xl border bg-background px-4 py-3 text-base" />
          </label>
          <ErrorBanner message={dialogError} />
          <div className="mt-4 flex gap-3">
            <button type="button" className={cn(btnGhost, "flex-1")} onClick={() => setDialog(null)}>Kembali</button>
            <button type="button" className={cn(btnDanger, "flex-1")} onClick={() => void confirm()}>
              {dialog.kind === "reverse" ? "BATALKAN PEMBAYARAN" : "BATALKAN PESANAN"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
