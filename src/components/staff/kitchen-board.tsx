"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { callRpc } from "@/lib/kwh/rpc";
import { staffRpc } from "@/lib/kwh/staff";
import { armAudioOnFirstGesture, isAudioReady, playNewOrder, unlockAudio } from "@/lib/kwh/sound";
import { PRODUCTION_LABELS, type Product, type ProductionStatus } from "@/lib/kwh/types";
import { StaffShell } from "./staff-shell";
import { useStaffSession } from "./use-staff-session";

const POLL_MS = 3000;
// Orders that wait longer than this (minutes since ordered) are coloured.
const OVERDUE_AMBER_MIN = 8;
const OVERDUE_RED_MIN = 15;
const NEW_HIGHLIGHT_MS = 8000;

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

  const [menu, setMenu] = useState<Product[] | null>(null);
  const [habisFor, setHabisFor] = useState<Product | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [soundReady, setSoundReady] = useState(false);
  const knownIds = useRef<Set<string> | null>(null);

  const ready = state.status === "ok" && !state.session.must_change;

  const load = useCallback(async () => {
    try {
      const [o, s, m] = await Promise.all([
        staffRpc<KitchenOrder[]>("list_kitchen_orders"),
        staffRpc<Summary>("get_production_summary"),
        callRpc<Product[]>("get_menu"),
      ]);
      setOrders(o);
      setSummary(s);
      setMenu(m);
      setError(null);

      // New-order alert: anything not seen before (never on the very first load).
      if (knownIds.current !== null) {
        const fresh = o.filter((x) => !knownIds.current!.has(x.id)).map((x) => x.id);
        if (fresh.length > 0) {
          playNewOrder();
          setNewIds((cur) => new Set([...cur, ...fresh]));
          window.setTimeout(() => {
            setNewIds((cur) => {
              const c = new Set(cur);
              fresh.forEach((id) => c.delete(id));
              return c;
            });
          }, NEW_HIGHLIGHT_MS);
        }
      }
      knownIds.current = new Set(o.map((x) => x.id));
      setSoundReady(isAudioReady());
    } catch (e) {
      if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) return;
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    if (state.status === "anon") router.replace("/staff");
  }, [state.status, router]);

  useEffect(() => {
    armAudioOnFirstGesture();
  }, []);

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

  async function setAvailability(p: Product, available: boolean) {
    const lockKey = `product-${p.id}`;
    if (locks.current.has(lockKey)) return;
    locks.current.add(lockKey);
    try {
      await staffRpc("set_product_availability", { p_product_id: p.id, p_available: available });
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      locks.current.delete(lockKey);
      setHabisFor(null);
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

      {/* Stock: kitchen decides when a menu item is HABIS (portions vary). */}
      <section aria-label="Stok menu" className="mb-4 rounded-2xl border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-extrabold">Stok Menu</h2>
          {!soundReady && (
            <button
              type="button"
              onClick={() => { unlockAudio(); setSoundReady(true); playNewOrder(); }}
              className="min-h-10 rounded-xl border px-4 text-sm font-semibold"
            >
              🔔 Aktifkan suara pesanan baru
            </button>
          )}
        </div>
        {menu === null ? (
          <p className="text-muted-foreground">Memuat menu…</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {menu.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-label={p.available ? `Tandai ${p.name} habis` : `Tandai ${p.name} ada lagi`}
                  onClick={() => (p.available ? setHabisFor(p) : void setAvailability(p, true))}
                  className={cn(
                    "min-h-12 rounded-xl border px-4 text-base font-semibold active:scale-95",
                    p.available ? "bg-card" : "border-destructive bg-destructive text-white",
                  )}
                >
                  {p.name}
                  {!p.available && <span className="ml-2 font-extrabold">HABIS</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Ketuk menu untuk menandai HABIS. Ketuk lagi untuk menandai ADA.</p>
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
                  {list.map((o) => {
                    const waited = now ? Math.floor((now - new Date(o.created_at).getTime()) / 60000) : 0;
                    const late = col.status === "ready" ? "" : waited >= OVERDUE_RED_MIN ? "red" : waited >= OVERDUE_AMBER_MIN ? "amber" : "";
                    return (
                    <li
                      key={o.id}
                      data-testid={`order-${o.queue_number}`}
                      data-late={late || undefined}
                      className={cn(
                        "rounded-2xl border-2 bg-card p-4",
                        late === "red" && "border-red-500 bg-red-500/10",
                        late === "amber" && "border-amber-500 bg-amber-500/10",
                        newIds.has(o.id) && "ring-4 ring-blue-500",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-mono text-5xl font-extrabold leading-none">
                          {o.queue_number}
                          {newIds.has(o.id) && (
                            <span className="ml-2 align-middle rounded-full bg-blue-600 px-2 py-0.5 font-sans text-xs font-bold text-white">BARU</span>
                          )}
                        </p>
                        <div className="text-right text-sm text-muted-foreground">
                          <p>{clock(o.created_at)}</p>
                          <p className={cn(late === "red" && "font-extrabold text-red-600", late === "amber" && "font-bold text-amber-600")}>
                            {ago(o.created_at, now)}
                          </p>
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
                    );
                  })}
                  {list.length === 0 && <li className="rounded-2xl border border-dashed p-6 text-center text-muted-foreground">Kosong</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {habisFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Tandai habis">
          <div className="w-full max-w-md rounded-3xl bg-card p-6">
            <h2 className="text-xl font-extrabold">Tandai {habisFor.name} HABIS?</h2>
            <p className="mb-4 mt-2 text-sm text-muted-foreground">
              Pelanggan tidak bisa memesannya lagi. Pesanan yang sudah masuk tidak dibatalkan otomatis.
            </p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setHabisFor(null)} className="min-h-14 flex-1 rounded-xl border font-semibold">
                Kembali
              </button>
              <button type="button" onClick={() => void setAvailability(habisFor, false)} className="min-h-14 flex-1 rounded-xl bg-destructive font-extrabold text-white">
                TANDAI HABIS
              </button>
            </div>
          </div>
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
