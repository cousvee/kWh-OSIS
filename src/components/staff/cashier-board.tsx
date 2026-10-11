"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { PRODUCTION_LABELS, type PaymentStatus, type ProductionStatus } from "@/lib/kwh/types";
import { StaffShell } from "./staff-shell";
import { useStaffSession } from "./use-staff-session";

const POLL_MS = 3000;
type Filter = "all" | "unpaid" | "paid";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "unpaid", label: "Belum Lunas" },
  { value: "paid", label: "Lunas" },
];

interface CashierOrder {
  id: string;
  queue_number: string;
  customer_name: string;
  customer_class: string;
  total_amount: number;
  payment_status: PaymentStatus;
  production_status: ProductionStatus;
  paid_at: string | null;
  items: { product_name: string; quantity: number; subtotal: number }[];
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function CashierBoard() {
  const router = useRouter();
  const state = useStaffSession(["cashier", "admin"]);

  const [orders, setOrders] = useState<CashierOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const locks = useRef<Set<string>>(new Set());
  const queryRef = useRef({ filter: "all" as Filter, search: "" });

  const [cancelFor, setCancelFor] = useState<CashierOrder | null>(null);
  const [reason, setReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);

  const ready = state.status === "ok" && !state.session.must_change;

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 250);
    return () => window.clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const { filter: f, search: s } = queryRef.current;
    try {
      const list = await staffRpc<CashierOrder[]>("list_cashier_orders", { p_search: s, p_filter: f });
      // Ignore a slow answer for an older query.
      if (queryRef.current.filter === f && queryRef.current.search === s) {
        setOrders(list);
        setError(null);
      }
    } catch (e) {
      if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) return;
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    if (state.status === "anon") router.replace("/staff");
  }, [state.status, router]);

  useEffect(() => {
    queryRef.current = { filter, search: debounced };
    if (!ready) return;
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [ready, load, filter, debounced]);

  async function markPaid(o: CashierOrder) {
    if (locks.current.has(o.id)) return;
    locks.current.add(o.id);
    setBusyIds((b) => ({ ...b, [o.id]: true }));
    try {
      await staffRpc("mark_order_paid", { p_order_id: o.id });
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      locks.current.delete(o.id);
      setBusyIds((b) => {
        const c = { ...b };
        delete c[o.id];
        return c;
      });
      await load();
    }
  }

  async function confirmCancel() {
    if (!cancelFor || locks.current.has(cancelFor.id)) return;
    locks.current.add(cancelFor.id);
    setCancelError(null);
    try {
      await staffRpc("cancel_order", { p_order_id: cancelFor.id, p_reason: reason });
      setCancelFor(null);
      setReason("");
      await load();
    } catch (e) {
      setCancelError(messageFor(e));
    } finally {
      locks.current.delete(cancelFor.id);
    }
  }

  if (state.status === "loading" || state.status === "anon") {
    return <p className="p-6 text-center text-muted-foreground">Memuat…</p>;
  }
  if (state.status === "forbidden") {
    return (
      <div className="mx-auto my-auto max-w-md rounded-3xl border bg-card p-6 text-center">
        <h1 className="text-xl font-extrabold">Akses ditolak</h1>
        <p className="mt-2 text-muted-foreground">Peran Anda tidak boleh membuka layar Kasir.</p>
        <Link href="/staff" className="mt-4 inline-flex min-h-12 items-center rounded-xl bg-secondary px-5 font-semibold">
          Kembali
        </Link>
      </div>
    );
  }
  if (state.session.must_change) {
    router.replace("/staff");
    return <p className="p-6 text-center text-muted-foreground">Memuat…</p>;
  }

  return (
    <StaffShell title="Kasir" role={state.session.role}>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari nomor antrian, nama, atau kelas"
          aria-label="Cari pesanan"
          className="min-h-14 w-full rounded-xl border bg-background px-4 text-lg md:max-w-md"
        />
        <div className="flex gap-2" role="tablist" aria-label="Filter pembayaran">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "min-h-14 rounded-xl border px-5 font-semibold",
                filter === f.value ? "border-primary bg-primary text-primary-foreground" : "bg-card",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {orders === null ? (
        <p className="py-10 text-center text-muted-foreground">Memuat pesanan…</p>
      ) : orders.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground">Tidak ada pesanan yang cocok.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((o) => {
            const paid = o.payment_status === "paid";
            const canCancel = !paid && o.production_status !== "completed";
            return (
              <li key={o.id} data-testid={`order-${o.queue_number}`} className="rounded-2xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-mono text-5xl font-extrabold leading-none">{o.queue_number}</p>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={cn(
                        "rounded-full px-3 py-1 text-sm font-extrabold",
                        paid ? "bg-emerald-600 text-white" : "bg-amber-500 text-black",
                      )}
                    >
                      {paid ? "LUNAS" : "BELUM LUNAS"}
                    </span>
                    <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold">
                      {PRODUCTION_LABELS[o.production_status]}
                    </span>
                  </div>
                </div>
                <p className="mt-2 text-lg font-semibold">
                  {o.customer_name} <span className="font-normal text-muted-foreground">· {o.customer_class}</span>
                </p>
                <ul className="my-3 space-y-1 border-y py-2">
                  {o.items.map((i) => (
                    <li key={i.product_name} className="flex justify-between gap-3">
                      <span>
                        {i.product_name} × {i.quantity}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{formatRupiah(i.subtotal)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mb-3 flex items-baseline justify-between">
                  <span className="font-medium">Total</span>
                  <span className="text-3xl font-extrabold tabular-nums">{formatRupiah(o.total_amount)}</span>
                </div>
                {paid ? (
                  <p className="text-sm text-muted-foreground">{o.paid_at ? `Dibayar ${clock(o.paid_at)}` : "Sudah dibayar"}</p>
                ) : (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void markPaid(o)}
                      disabled={!!busyIds[o.id]}
                      className="min-h-14 flex-1 rounded-xl bg-primary text-lg font-extrabold text-primary-foreground active:scale-[0.98] disabled:opacity-50"
                    >
                      TANDAI SUDAH DIBAYAR
                    </button>
                    {canCancel && (
                      <button
                        type="button"
                        onClick={() => { setCancelFor(o); setReason(""); setCancelError(null); }}
                        className="min-h-14 rounded-xl border px-4 font-semibold text-destructive"
                      >
                        Batal
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {cancelFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Batalkan pesanan">
          <div className="w-full max-w-md rounded-3xl bg-card p-6">
            <h2 className="text-xl font-extrabold">Batalkan pesanan {cancelFor.queue_number}?</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              {cancelFor.customer_name} · {cancelFor.customer_class}. Pesanan tetap tersimpan di riwayat.
            </p>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Alasan pembatalan</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} rows={3} className="w-full rounded-xl border bg-background px-4 py-3 text-lg" />
            </label>
            {cancelError && (
              <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {cancelError}
              </p>
            )}
            <div className="mt-4 flex gap-3">
              <button type="button" onClick={() => setCancelFor(null)} className="min-h-14 flex-1 rounded-xl border font-semibold">
                Kembali
              </button>
              <button type="button" onClick={() => void confirmCancel()} className="min-h-14 flex-1 rounded-xl bg-destructive font-extrabold text-white">
                BATALKAN PESANAN
              </button>
            </div>
          </div>
        </div>
      )}
    </StaffShell>
  );
}
