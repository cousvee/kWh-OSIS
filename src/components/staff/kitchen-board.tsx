"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { staffRpc } from "@/lib/kwh/staff";
import { PRODUCTION_LABELS, type ProductionStatus } from "@/lib/kwh/types";
import { StaffShell } from "./staff-shell";
import { useStaffSession } from "./use-staff-session";

const POLL_MS = 3000;

interface KitchenItem {
  product_name: string;
  quantity: number;
}
interface KitchenOrder {
  id: string;
  queue_number: string;
  customer_name: string;
  customer_class: string;
  production_status: ProductionStatus;
  created_at: string;
  items: KitchenItem[];
}
interface Summary {
  items: { product_name: string; quantity: number }[];
  order_count: number;
}

const COLUMNS: { status: ProductionStatus; next: ProductionStatus; action: string; tone: string }[] = [
  { status: "waiting", next: "processing", action: "MULAI PROSES", tone: "bg-amber-500 text-black" },
  { status: "processing", next: "ready", action: "TANDAI SIAP", tone: "bg-blue-600 text-white" },
  { status: "ready", next: "completed", action: "SELESAI", tone: "bg-emerald-600 text-white" },
];

function ago(iso: string, now: number): string {
  if (!now) return "";
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  return m < 1 ? "baru saja" : `${m} mnt lalu`;
}
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function KitchenBoard() {
  const router = useRouter();
  const state = useStaffSession(["kitchen", "admin"]);

  const [orders, setOrders] = useState<KitchenOrder[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0); // set in the browser only (prerender must not read the clock)
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const locks = useRef<Set<string>>(new Set());
  const [cancelFor, setCancelFor] = useState<KitchenOrder | null>(null);
  const [reason, setReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);

  const ready = state.status === "ok" && !state.session.must_change;

  const load = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([
        staffRpc<KitchenOrder[]>("list_kitchen_orders"),
        staffRpc<Summary>("get_production_summary"),
      ]);
      setOrders(o);
      setSummary(s);
      setError(null);
    } catch (e) {
      if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) return;
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    if (state.status === "anon") router.replace("/staff");
  }, [state.status, router]);

  useEffect(() => {
    if (!ready) return;
    setNow(Date.now());
    void load();
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [ready, load]);

  async function advance(order: KitchenOrder, next: ProductionStatus) {
    if (locks.current.has(order.id)) return;
    locks.current.add(order.id);
    setBusyIds((b) => ({ ...b, [order.id]: true }));
    try {
      await staffRpc("update_production_status", { p_order_id: order.id, p_new_status: next });
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      locks.current.delete(order.id);
      setBusyIds((b) => {
        const c = { ...b };
        delete c[order.id];
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
        <p className="mt-2 text-muted-foreground">Peran Anda tidak boleh membuka layar Dapur.</p>
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
    <StaffShell title="Dapur" role={state.session.role}>
      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Production summary: remaining workload (waiting + processing + ready) */}
      <section aria-label="Ringkasan produksi" className="mb-4 rounded-2xl border bg-card p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-extrabold">Ringkasan Produksi</h2>
          <span className="text-sm text-muted-foreground">{summary?.order_count ?? 0} pesanan aktif</span>
        </div>
        {summary && summary.items.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {summary.items.map((i) => (
              <li key={i.product_name} className="rounded-xl bg-secondary px-4 py-2 text-lg">
                {i.product_name} — <span className="font-extrabold tabular-nums">{i.quantity}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Tidak ada yang perlu dibuat.</p>
        )}
      </section>

      {orders === null ? (
        <p className="py-10 text-center text-muted-foreground">Memuat pesanan…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {COLUMNS.map((col) => {
            const list = orders.filter((o) => o.production_status === col.status);
            return (
              <section key={col.status} aria-label={PRODUCTION_LABELS[col.status]}>
                <h2 className="mb-2 flex items-center justify-between text-lg font-extrabold">
                  {PRODUCTION_LABELS[col.status]}
                  <span className="rounded-full bg-secondary px-3 text-base tabular-nums">{list.length}</span>
                </h2>
                <ul className="space-y-3">
                  {list.map((o) => (
                    <li key={o.id} data-testid={`order-${o.queue_number}`} className="rounded-2xl border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-mono text-5xl font-extrabold leading-none">{o.queue_number}</p>
                        <div className="text-right text-sm text-muted-foreground">
                          <p>{clock(o.created_at)}</p>
                          <p>{ago(o.created_at, now)}</p>
                        </div>
                      </div>
                      <p className="mt-2 text-lg font-semibold">
                        {o.customer_name} <span className="font-normal text-muted-foreground">· {o.customer_class}</span>
                      </p>
                      <ul className="my-3 space-y-1 border-y py-2 text-lg">
                        {o.items.map((i) => (
                          <li key={i.product_name} className="flex justify-between">
                            <span>{i.product_name}</span>
                            <span className="font-extrabold tabular-nums">× {i.quantity}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void advance(o, col.next)}
                          disabled={!!busyIds[o.id]}
                          className={cn("min-h-14 flex-1 rounded-xl text-lg font-extrabold active:scale-[0.98] disabled:opacity-50", col.tone)}
                        >
                          {col.action}
                        </button>
                        {(col.status === "waiting" || col.status === "processing") && (
                          <button
                            type="button"
                            onClick={() => { setCancelFor(o); setReason(""); setCancelError(null); }}
                            className="min-h-14 rounded-xl border px-4 font-semibold text-destructive"
                          >
                            Batal
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                  {list.length === 0 && <li className="rounded-2xl border border-dashed p-6 text-center text-muted-foreground">Kosong</li>}
                </ul>
              </section>
            );
          })}
        </div>
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
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                rows={3}
                className="w-full rounded-xl border bg-background px-4 py-3 text-lg"
              />
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
