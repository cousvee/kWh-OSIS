"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { callRpc } from "@/lib/kwh/rpc";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import {
  clearPending,
  clearSavedTicket,
  loadPending,
  loadSavedTicket,
  newIdempotencyKey,
  savePending,
  saveTicket,
} from "@/lib/kwh/idempotency";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type ActiveEvent,
  type Category,
  type CreateOrderResponse,
  type Product,
  type Ticket,
} from "@/lib/kwh/types";
import { unlockAudio } from "@/lib/kwh/sound";
import { QueueTicket } from "./queue-ticket";

const POLL_MS = 5000;
const MAX_QTY = 99;

interface SavedTicket {
  ticket: Ticket;
  eventName: string;
}

export function CustomerOrder() {
  const [event, setEvent] = useState<ActiveEvent | null | undefined>(undefined); // undefined = loading
  const [menu, setMenu] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [category, setCategory] = useState<Category | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [name, setName] = useState("");
  const [klass, setKlass] = useState("");
  const [fieldError, setFieldError] = useState<{ name?: string; klass?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);

  const [saved, setSaved] = useState<SavedTicket | null>(null);

  // Restore a ticket after an accidental refresh so the customer never loses their number.
  useEffect(() => {
    const t = loadSavedTicket<SavedTicket>();
    if (t?.ticket?.queue_number) setSaved(t);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [ev, products] = await Promise.all([
        callRpc<ActiveEvent | null>("get_active_event"),
        callRpc<Product[]>("get_menu"),
      ]);
      setEvent(ev ?? null);
      setMenu(products ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(messageFor(e));
    }
  }, []);

  // Initial load + light polling (pauses while the tab is hidden or a ticket is shown).
  useEffect(() => {
    if (saved) return;
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, saved]);

  const categories = useMemo(() => {
    const present = new Set((menu ?? []).map((p) => p.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [menu]);

  const activeCategory: Category | null =
    category && categories.includes(category) ? category : (categories[0] ?? null);

  const visibleProducts = useMemo(
    () => (menu ?? []).filter((p) => p.category === activeCategory),
    [menu, activeCategory],
  );

  // Cart lines only count products that are still available (derived, so a
  // product that sells out mid-order drops out of the order automatically).
  const { lines, total, soldOutInCart } = useMemo(() => {
    const byId = new Map((menu ?? []).map((p) => [p.id, p]));
    const l: { product: Product; qty: number; subtotal: number }[] = [];
    const gone: string[] = [];
    for (const [id, qty] of Object.entries(cart)) {
      const product = byId.get(id);
      if (!product || qty <= 0) continue;
      if (!product.available) {
        gone.push(product.name);
        continue;
      }
      l.push({ product, qty, subtotal: product.price * qty });
    }
    l.sort((a, b) => a.product.name.localeCompare(b.product.name));
    return {
      lines: l,
      total: l.reduce((s, x) => s + x.subtotal, 0),
      soldOutInCart: gone,
    };
  }, [cart, menu]);

  const itemCount = lines.reduce((s, l) => s + l.qty, 0);

  function change(productId: string, delta: number) {
    setFormError(null);
    setCart((prev) => {
      const next = Math.min(MAX_QTY, Math.max(0, (prev[productId] ?? 0) + delta));
      const copy = { ...prev };
      if (next === 0) delete copy[productId];
      else copy[productId] = next;
      return copy;
    });
  }

  async function submit() {
    if (submitLock.current) return; // double-click / double-tap guard
    unlockAudio(); // this tap lets the ticket play a "ready" sound later
    const cleanName = name.trim();
    const cleanClass = klass.trim();

    const errs: { name?: string; klass?: string } = {};
    if (!cleanName) errs.name = "Nama wajib diisi";
    if (!cleanClass) errs.klass = "Kelas wajib diisi";
    setFieldError(errs);
    if (lines.length === 0) {
      setFormError(messageFor(new KwhError("EMPTY_CART")));
      return;
    }
    if (errs.name || errs.klass) {
      setFormError(null);
      return;
    }

    submitLock.current = true;
    setSubmitting(true);
    setFormError(null);

    // Same order content => same key (safe retries). Changed content => new key.
    const signature = JSON.stringify({
      n: cleanName,
      c: cleanClass,
      l: lines.map((x) => [x.product.id, x.qty]).sort(),
    });
    const pending = loadPending();
    const key = pending && pending.signature === signature ? pending.key : newIdempotencyKey();
    savePending({ key, signature });

    try {
      const res = await callRpc<CreateOrderResponse>("create_customer_order", {
        p_idempotency_key: key,
        p_customer_name: cleanName,
        p_customer_class: cleanClass,
        p_items: lines.map((x) => ({ product_id: x.product.id, quantity: x.qty })),
      });
      clearPending();
      const t: SavedTicket = { ticket: res.order, eventName: res.event_name };
      saveTicket(t);
      setSaved(t);
      setCart({});
      setName("");
      setKlass("");
      setFieldError({});
    } catch (e) {
      const code = e instanceof KwhError ? e.code : "UNKNOWN";
      setFormError(messageFor(e));
      // A definite rejection means the next attempt is a new checkout (new key).
      // Network/server uncertainty keeps the key so a retry can never double-order.
      if (code !== "NETWORK" && code !== "UNKNOWN") clearPending();
      if (code === "PRODUCT_UNAVAILABLE" || code === "PRODUCT_NOT_FOUND" || code === "NO_ACTIVE_EVENT" || code === "EVENT_CLOSED" || code === "ORDERS_PAUSED") {
        void refresh();
      }
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  function newOrder() {
    clearSavedTicket();
    clearPending();
    setSaved(null);
    setFormError(null);
  }

  if (saved) {
    return <QueueTicket ticket={saved.ticket} eventName={saved.eventName} onNewOrder={newOrder} />;
  }

  const noEvent = event === null;
  const paused = !!event && event.accepting_orders === false;
  const loading = event === undefined && !loadError;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pb-28 pt-4 lg:pb-6">
      <header className="mb-4">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">KWh ANTRIAN</p>
        <h1 className="text-2xl font-extrabold leading-tight sm:text-3xl">
          {event ? event.name : loading ? "Memuat…" : "KWh Antrian"}
        </h1>
      </header>

      {loadError && (
        <div role="alert" className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
          {menu === null && (
            <button type="button" onClick={() => void refresh()} className="ml-3 font-semibold underline">
              Coba lagi
            </button>
          )}
        </div>
      )}

      {paused && (
        <div role="status" className="mb-4 rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 font-semibold">
          Pemesanan sedang ditutup sementara. Menu tetap bisa dilihat; silakan coba lagi sebentar lagi.
        </div>
      )}

      {noEvent && !loadError && (
        <div role="status" className="rounded-3xl border bg-card px-6 py-12 text-center">
          <p className="text-xl font-bold">Belum ada acara yang berlangsung</p>
          <p className="mt-2 text-muted-foreground">Silakan hubungi panitia.</p>
        </div>
      )}

      {!noEvent && (
        <div className="grid flex-1 gap-6 lg:grid-cols-[1fr_380px]">
          {/* MENU */}
          <section aria-label="Menu">
            {categories.length > 0 && (
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={c === activeCategory}
                    onClick={() => setCategory(c)}
                    className={cn(
                      "min-h-12 shrink-0 rounded-full border px-5 text-base font-semibold",
                      c === activeCategory
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-card text-foreground",
                    )}
                  >
                    {CATEGORY_LABELS[c]}
                  </button>
                ))}
              </div>
            )}

            {menu === null && !loadError && (
              <p className="py-10 text-center text-muted-foreground">Memuat menu…</p>
            )}
            {menu !== null && menu.length === 0 && (
              <p className="py-10 text-center text-muted-foreground">Belum ada menu.</p>
            )}

            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {visibleProducts.map((p) => {
                const qty = cart[p.id] ?? 0;
                return (
                  <li
                    key={p.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-2xl border bg-card p-4",
                      !p.available && "opacity-60",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="break-words text-lg font-semibold leading-snug">{p.name}</p>
                      <p className="text-base text-muted-foreground tabular-nums">{formatRupiah(p.price)}</p>
                    </div>
                    {p.available ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          aria-label={`Kurangi ${p.name}`}
                          onClick={() => change(p.id, -1)}
                          disabled={qty === 0 || submitting}
                          className="flex size-14 items-center justify-center rounded-xl border bg-secondary text-secondary-foreground active:scale-95 disabled:opacity-30"
                        >
                          <Minus className="size-6" />
                        </button>
                        <span className="w-8 text-center text-xl font-bold tabular-nums" aria-live="polite">
                          {qty}
                        </span>
                        <button
                          type="button"
                          aria-label={`Tambah ${p.name}`}
                          onClick={() => change(p.id, 1)}
                          disabled={qty >= MAX_QTY || submitting}
                          className="flex size-14 items-center justify-center rounded-xl bg-primary text-primary-foreground active:scale-95 disabled:opacity-30"
                        >
                          <Plus className="size-6" />
                        </button>
                      </div>
                    ) : (
                      <span className="shrink-0 rounded-xl bg-destructive px-4 py-2 text-base font-extrabold tracking-wide text-white">
                        HABIS
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* CART */}
          <aside id="pesanan" aria-label="Pesanan Anda" className="h-fit rounded-3xl border bg-card p-5 lg:sticky lg:top-4">
            <h2 className="mb-3 text-xl font-extrabold">Pesanan Anda</h2>

            {soldOutInCart.length > 0 && (
              <p role="alert" className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {soldOutInCart.join(", ")} baru saja habis dan tidak dimasukkan ke pesanan.
              </p>
            )}

            {lines.length === 0 ? (
              <p className="py-4 text-center text-muted-foreground">Belum ada menu dipilih.</p>
            ) : (
              <ul className="space-y-2">
                {lines.map(({ product, qty, subtotal }) => (
                  <li key={product.id} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 break-words">
                      {product.name} <span className="text-muted-foreground">× {qty}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatRupiah(subtotal)}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex items-baseline justify-between border-t pt-3">
              <span className="font-medium">Total</span>
              <span className="text-3xl font-extrabold tabular-nums" data-testid="cart-total">
                {formatRupiah(total)}
              </span>
            </div>

            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Nama</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  autoComplete="off"
                  enterKeyHint="next"
                  disabled={submitting}
                  aria-invalid={!!fieldError.name}
                  className="min-h-14 w-full rounded-xl border bg-background px-4 text-lg"
                />
                {fieldError.name && <span className="mt-1 block text-sm text-destructive">{fieldError.name}</span>}
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Kelas</span>
                <input
                  value={klass}
                  onChange={(e) => setKlass(e.target.value)}
                  maxLength={20}
                  autoComplete="off"
                  enterKeyHint="done"
                  disabled={submitting}
                  aria-invalid={!!fieldError.klass}
                  className="min-h-14 w-full rounded-xl border bg-background px-4 text-lg"
                />
                {fieldError.klass && <span className="mt-1 block text-sm text-destructive">{fieldError.klass}</span>}
              </label>
            </div>

            {formError && (
              <p role="alert" className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </p>
            )}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting || loading || noEvent || paused}
              className="mt-5 min-h-16 w-full rounded-2xl bg-primary px-6 text-xl font-extrabold text-primary-foreground active:scale-[0.98] disabled:opacity-50"
            >
              {submitting ? "MEMPROSES…" : paused ? "PEMESANAN DITUTUP" : "BUAT PESANAN"}
            </button>
          </aside>
        </div>
      )}

      {/* Small screens: sticky summary that jumps to the order panel */}
      {!noEvent && itemCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 backdrop-blur lg:hidden">
          <a
            href="#pesanan"
            className="mx-auto flex min-h-14 max-w-xl items-center justify-between rounded-2xl bg-primary px-5 text-primary-foreground"
          >
            <span className="font-semibold">{itemCount} item</span>
            <span className="text-lg font-extrabold tabular-nums">{formatRupiah(total)}</span>
            <span className="font-semibold">Lihat pesanan ↓</span>
          </a>
        </div>
      )}
    </div>
  );
}
