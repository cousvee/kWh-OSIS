"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { todayWib } from "@/lib/kwh/time";
import { EXPENSE_CATEGORIES, type Expense, type ExpenseCategory } from "@/lib/kwh/admin-types";
import { Card, ErrorBanner, Modal, Stat, btnDanger, btnGhost, btnPrimary, digits, inputClass } from "./ui";

interface Form {
  worker: string;
  item: string;
  category: ExpenseCategory;
  amount: string;
  nota: string;
  date: string;
}
const emptyForm = (): Form => ({ worker: "", item: "", category: "bahan", amount: "", nota: "", date: todayWib() });
const catLabel = (c: string) => EXPENSE_CATEGORIES.find((x) => x.value === c)?.label ?? c;

export function ExpensesTab({ eventId, readOnly, onChanged }: { eventId: string | null; readOnly: boolean; onChanged: () => Promise<void> }) {
  const [list, setList] = useState<Expense[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [voidFor, setVoidFor] = useState<Expense | null>(null);
  const [reason, setReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const lock = useRef(false);

  const load = useCallback(async () => {
    try {
      setList(await staffRpc<Expense[]>("list_expenses", { p_event_id: eventId }));
      setError(null);
    } catch (e) {
      if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) return;
      setError(messageFor(e));
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = (list ?? []).filter((e) => !e.voided);
  const total = live.reduce((s, e) => s + e.amount, 0);
  const reimbursed = live.filter((e) => e.reimbursed).reduce((s, e) => s + e.amount, 0);
  const workers = [...new Set((list ?? []).map((e) => e.worker_name))];

  async function save() {
    if (lock.current) return;
    const amount = Number(form.amount);
    if (!form.worker.trim() || !form.item.trim()) return setFormError("Nama pekerja dan barang wajib diisi.");
    if (!form.amount || !Number.isInteger(amount) || amount < 1) return setFormError("Jumlah harus lebih dari 0.");
    lock.current = true;
    setSaving(true);
    setFormError(null);
    try {
      await staffRpc("save_expense", {
        p_id: editingId,
        p_event_id: eventId,
        p_worker_name: form.worker,
        p_item: form.item,
        p_category: form.category,
        p_amount: amount,
        p_receipt_no: form.nota,
        p_spent_on: form.date,
      });
      setForm(emptyForm());
      setEditingId(null);
      await Promise.all([load(), onChanged()]);
    } catch (e) {
      setFormError(messageFor(e));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  async function toggleReimbursed(e: Expense) {
    if (lock.current) return;
    lock.current = true;
    try {
      await staffRpc("set_expense_reimbursed", { p_id: e.id, p_reimbursed: !e.reimbursed });
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      lock.current = false;
    }
  }

  async function confirmVoid() {
    if (!voidFor || lock.current) return;
    lock.current = true;
    setVoidError(null);
    try {
      await staffRpc("void_expense", { p_id: voidFor.id, p_reason: reason });
      setVoidFor(null);
      setReason("");
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setVoidError(messageFor(err));
    } finally {
      lock.current = false;
    }
  }

  function edit(e: Expense) {
    setEditingId(e.id);
    setForm({ worker: e.worker_name, item: e.item, category: e.category, amount: String(e.amount), nota: e.receipt_no ?? "", date: e.spent_on });
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="grid gap-4">
      <ErrorBanner message={error} />

      <section aria-label="Total modal" className="grid grid-cols-3 gap-3">
        <Stat label="Total modal" value={formatRupiah(total)} testId="exp-total" />
        <Stat label="Sudah diganti" value={formatRupiah(reimbursed)} tone="good" testId="exp-reimbursed" />
        <Stat label="Sisa yang harus diganti" value={formatRupiah(total - reimbursed)} tone={total - reimbursed > 0 ? "warn" : undefined} testId="exp-remaining" />
      </section>

      {!readOnly && (
        <Card title={editingId ? "Ubah modal" : "Catat modal baru"} label="Form modal">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Pekerja (yang membayar)</span>
              <input list="workers" value={form.worker} onChange={(e) => setForm({ ...form, worker: e.target.value })} maxLength={60} className={inputClass} />
              <datalist id="workers">{workers.map((w) => <option key={w} value={w} />)}</datalist>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Barang</span>
              <input value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} maxLength={120} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Kategori</span>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })} className={inputClass}>
                {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Jumlah (Rp)</span>
              <input inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: digits(e.target.value) })} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">No. Nota (jika ada)</span>
              <input value={form.nota} onChange={(e) => setForm({ ...form, nota: e.target.value })} maxLength={40} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Tanggal</span>
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={inputClass} />
            </label>
          </div>
          <ErrorBanner message={formError} />
          <div className="mt-4 flex gap-3">
            {editingId && <button type="button" className={btnGhost} onClick={() => { setEditingId(null); setForm(emptyForm()); setFormError(null); }}>Batal ubah</button>}
            <button type="button" className={cn(btnPrimary, "flex-1")} disabled={saving} onClick={() => void save()}>
              {saving ? "MENYIMPAN…" : editingId ? "SIMPAN PERUBAHAN" : "SIMPAN MODAL"}
            </button>
          </div>
        </Card>
      )}

      <Card title="Daftar modal" label="Daftar modal">
        {list === null ? (
          <p className="text-muted-foreground">Memuat…</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground">Belum ada modal yang dicatat.</p>
        ) : (
          <ul className="space-y-2">
            {list.map((e) => (
              <li key={e.id} data-testid={`expense-${e.item}`} className={cn("rounded-xl border p-3", e.voided && "opacity-60")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className={cn("font-semibold", e.voided && "line-through")}>{e.item} <span className="font-normal text-muted-foreground">· {catLabel(e.category)}</span></p>
                    <p className="text-sm text-muted-foreground">{e.worker_name} · {e.spent_on}{e.receipt_no ? ` · Nota ${e.receipt_no}` : ""}</p>
                    {e.voided && <p className="text-sm text-destructive">Dibatalkan: {e.void_reason}</p>}
                  </div>
                  <p className="text-xl font-extrabold tabular-nums">{formatRupiah(e.amount)}</p>
                </div>
                {!e.voided && !readOnly && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void toggleReimbursed(e)}
                      className={cn("min-h-10 rounded-lg px-3 text-sm font-bold", e.reimbursed ? "bg-emerald-600 text-white" : "bg-amber-500 text-black")}>
                      {e.reimbursed ? "Sudah diganti ✓" : "Belum diganti"}
                    </button>
                    <button type="button" className="min-h-10 rounded-lg border px-3 text-sm font-semibold" onClick={() => edit(e)}>Ubah</button>
                    <button type="button" className="min-h-10 rounded-lg border px-3 text-sm font-semibold text-destructive" onClick={() => { setVoidFor(e); setReason(""); setVoidError(null); }}>Batalkan</button>
                  </div>
                )}
                {!e.voided && readOnly && <p className="mt-1 text-sm">{e.reimbursed ? "Sudah diganti" : "Belum diganti"}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {voidFor && (
        <Modal title={`Batalkan modal "${voidFor.item}"?`} onClose={() => setVoidFor(null)}>
          <p className="mb-3 text-sm text-muted-foreground">Data tidak dihapus: tetap tampil sebagai dibatalkan dan tidak dihitung ke total modal.</p>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Alasan</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={200} className="w-full rounded-xl border bg-background px-4 py-3 text-base" />
          </label>
          <ErrorBanner message={voidError} />
          <div className="mt-4 flex gap-3">
            <button type="button" className={cn(btnGhost, "flex-1")} onClick={() => setVoidFor(null)}>Kembali</button>
            <button type="button" className={cn(btnDanger, "flex-1")} onClick={() => void confirmVoid()}>BATALKAN MODAL</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
