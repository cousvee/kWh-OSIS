"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { callRpc } from "@/lib/kwh/rpc";
import { messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { CATEGORY_LABELS, CATEGORY_ORDER, type Category, type Product } from "@/lib/kwh/types";
import { Card, ErrorBanner, btnPrimary, digits, inputClass } from "./ui";

function ProductRow({ product, onSaved, onError }: { product: Product | null; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [category, setCategory] = useState<Category>(product?.category ?? "makanan");
  const [available, setAvailable] = useState(product?.available ?? true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  // Keep in sync when the kitchen flips availability elsewhere.
  useEffect(() => {
    if (product) setAvailable(product.available);
  }, [product]);

  const dirty = !product || name !== product.name || price !== String(product.price) || category !== product.category || available !== product.available;

  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onError(null);
    try {
      await staffRpc("admin_save_product", {
        p_id: product?.id ?? null,
        p_name: name,
        p_category: category,
        p_price: Number(price === "" ? NaN : price),
        p_available: available,
      });
      if (!product) {
        setName("");
        setPrice("");
        setAvailable(true);
      }
      await onSaved();
    } catch (e) {
      onError(messageFor(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <li data-testid={product ? `product-${product.name}` : "product-new"} className="grid items-end gap-2 rounded-xl border p-3 md:grid-cols-[1fr_9rem_9rem_auto_auto]">
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Nama menu</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label={product ? `Nama ${product.name}` : "Nama menu baru"} className={inputClass} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Harga (Rp)</span>
        <input inputMode="numeric" value={price} onChange={(e) => setPrice(digits(e.target.value))} aria-label={product ? `Harga ${product.name}` : "Harga menu baru"} className={inputClass} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Kategori</span>
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)} aria-label={product ? `Kategori ${product.name}` : "Kategori menu baru"} className={inputClass}>
          {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => setAvailable(!available)} aria-label={product ? `Ketersediaan ${product.name}` : "Ketersediaan menu baru"}
        className={cn("min-h-12 rounded-xl px-4 font-bold", available ? "bg-emerald-600 text-white" : "bg-destructive text-white")}>
        {available ? "ADA" : "HABIS"}
      </button>
      <button type="button" disabled={busy || !dirty} onClick={() => void save()} aria-label={product ? `Simpan ${product.name}` : "Tambah menu"} className={btnPrimary}>
        {product ? "Simpan" : "Tambah"}
      </button>
    </li>
  );
}

export function MenuTab() {
  const [menu, setMenu] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMenu(await callRpc<Product[]>("get_menu"));
    } catch (e) {
      setError(messageFor(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-4">
      <ErrorBanner message={error} />
      <Card title="Tambah menu baru" label="Tambah menu">
        <ul><ProductRow product={null} onSaved={load} onError={setError} /></ul>
      </Card>
      <Card title="Daftar menu" label="Daftar menu">
        <p className="mb-3 text-sm text-muted-foreground">
          Mengubah nama atau harga tidak mengubah pesanan lama: riwayat tetap memakai nama dan harga saat dipesan.
        </p>
        {menu === null ? (
          <p className="text-muted-foreground">Memuat…</p>
        ) : (
          <ul className="space-y-2">
            {menu.map((p) => (
              <ProductRow key={`${p.id}-${p.name}-${p.price}-${p.category}`} product={p} onSaved={load} onError={setError} />
            ))}
          </ul>
        )}
        {menu && menu.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Harga saat ini: {menu.map((p) => `${p.name} ${formatRupiah(p.price)}`).join(" · ")}</p>}
      </Card>
    </div>
  );
}
