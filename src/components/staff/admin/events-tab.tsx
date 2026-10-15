"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { formatRupiah } from "@/lib/kwh/format";
import { staffRpc } from "@/lib/kwh/staff";
import { wibReadable } from "@/lib/kwh/time";
import type { ActiveEvent } from "@/lib/kwh/types";
import type { EventListItem } from "@/lib/kwh/admin-types";
import { Card, ErrorBanner, Modal, btnDanger, btnGhost, btnPrimary, inputClass } from "./ui";

interface Props {
  activeEvent: ActiveEvent | null | undefined;
  events: EventListItem[] | null;
  reload: () => Promise<void>;
  viewReport: (eventId: string) => void;
}

const STATUS_LABEL = { active: "BERLANGSUNG", completed: "SELESAI", archived: "DIARSIPKAN" } as const;

export function EventsTab({ activeEvent, events, reload, viewReport }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [newName, setNewName] = useState("");
  const [closing, setClosing] = useState<{ openOrders: number | null } | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [archiveFor, setArchiveFor] = useState<EventListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  useEffect(() => {
    if (activeEvent) setRenameTo((cur) => (cur === "" ? activeEvent.name : cur));
  }, [activeEvent]);

  async function run(fn: () => Promise<void>, onFail?: (e: unknown) => void) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await fn();
      setError(null);
      await reload();
    } catch (e) {
      if (onFail) onFail(e);
      else setError(messageFor(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const rename = () => run(async () => { await staffRpc("rename_event", { p_event_id: null, p_name: renameTo }); });
  const start = () => run(async () => { await staffRpc("start_new_event", { p_name: newName }); setNewName(""); });
  const archive = () => run(async () => { if (archiveFor) await staffRpc("archive_event", { p_event_id: archiveFor.event.id }); setArchiveFor(null); });

  const close = (force: boolean) =>
    run(
      async () => {
        await staffRpc("close_current_event", { p_force: force });
        setClosing(null);
        setCloseError(null);
      },
      (e) => {
        if (e instanceof KwhError && e.code === "ORDERS_STILL_ACTIVE") {
          setClosing({ openOrders: Number(e.detail) || 1 });
          setCloseError(null);
        } else {
          setCloseError(messageFor(e));
        }
      },
    );

  return (
    <div className="grid gap-4">
      <ErrorBanner message={error} />

      {activeEvent ? (
        <Card title="Acara aktif" label="Acara aktif">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Nama acara</span>
            <div className="flex gap-3">
              <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} maxLength={100} aria-label="Nama acara" className={inputClass} />
              <button type="button" className={btnPrimary} disabled={busy || renameTo.trim() === "" || renameTo === activeEvent.name} onClick={() => void rename()}>
                Simpan nama
              </button>
            </div>
          </label>
          <div className="mt-5 border-t pt-4">
            <p className="mb-3 text-sm text-muted-foreground">
              Menutup acara menghentikan pesanan baru dan perubahan status. Nomor antrian acara berikutnya mulai lagi dari 001. Semua data lama tetap tersimpan.
            </p>
            <button type="button" className={btnDanger} onClick={() => { setClosing({ openOrders: null }); setCloseError(null); }}>
              Tutup acara
            </button>
          </div>
        </Card>
      ) : (
        <Card title="Mulai acara baru" label="Mulai acara baru">
          <p className="mb-3 text-sm text-muted-foreground">Tidak ada acara aktif. Antrian akan mulai dari 001.</p>
          <div className="flex gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} placeholder="Nama acara baru" aria-label="Nama acara baru" className={inputClass} />
            <button type="button" className={btnPrimary} disabled={busy || newName.trim() === ""} onClick={() => void start()}>
              MULAI ACARA
            </button>
          </div>
        </Card>
      )}

      <Card title="Riwayat acara" label="Riwayat acara">
        {events === null ? (
          <p className="text-muted-foreground">Memuat…</p>
        ) : (
          <ul className="space-y-3">
            {events.map((it) => (
              <li key={it.event.id} data-testid={`event-${it.event.name}`} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-lg font-extrabold">{it.event.name}</p>
                  <span className={cn("rounded-full px-3 py-1 text-xs font-extrabold", it.event.status === "active" ? "bg-emerald-600 text-white" : "bg-secondary")}>
                    {STATUS_LABEL[it.event.status]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {wibReadable(it.event.created_at)}{it.event.ended_at ? ` → ${wibReadable(it.event.ended_at)}` : ""}
                </p>
                <p className="mt-2 text-sm">
                  {it.totals.active_orders} pesanan · Pendapatan {formatRupiah(it.totals.active_revenue)} · Dibayar {formatRupiah(it.totals.paid_total)} · Belum dibayar {formatRupiah(it.totals.debt_total)} · Dibatalkan {it.totals.cancelled_orders}{" "}
                  <b className={it.reconciled ? "text-emerald-600" : "text-destructive"}>{it.reconciled ? "✓" : "⚠ ADA SELISIH"}</b>
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={btnGhost} onClick={() => viewReport(it.event.id)}>Lihat laporan</button>
                  {it.event.status === "completed" && (
                    <button type="button" className={btnGhost} onClick={() => setArchiveFor(it)}>Arsipkan</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {closing && (
        <Modal title={closing.openOrders === null ? "Tutup acara ini?" : "Masih ada pesanan belum selesai"} onClose={() => setClosing(null)}>
          {closing.openOrders === null ? (
            <p className="mb-4 text-sm text-muted-foreground">Pastikan semua pesanan sudah selesai dan semua pembayaran sudah dicatat: setelah acara ditutup, pembayaran tidak bisa dicatat lagi oleh kasir.</p>
          ) : (
            <p className="mb-4 text-sm">
              Ada <b>{closing.openOrders}</b> pesanan yang masih menunggu, diproses, atau siap diambil. Menutup paksa akan membiarkannya tidak selesai.
            </p>
          )}
          <ErrorBanner message={closeError} />
          <div className="flex gap-3">
            <button type="button" className={cn(btnGhost, "flex-1")} onClick={() => setClosing(null)}>Kembali</button>
            <button type="button" className={cn(btnDanger, "flex-1")} disabled={busy} onClick={() => void close(closing.openOrders !== null)}>
              {closing.openOrders === null ? "TUTUP ACARA" : "TUTUP PAKSA"}
            </button>
          </div>
        </Modal>
      )}

      {archiveFor && (
        <Modal title={`Arsipkan "${archiveFor.event.name}"?`} onClose={() => setArchiveFor(null)}>
          <p className="mb-4 text-sm text-muted-foreground">Acara diarsipkan tidak bisa menerima catatan modal baru. Data dan laporan tetap bisa dilihat.</p>
          <div className="flex gap-3">
            <button type="button" className={cn(btnGhost, "flex-1")} onClick={() => setArchiveFor(null)}>Kembali</button>
            <button type="button" className={cn(btnPrimary, "flex-1")} disabled={busy} onClick={() => void archive()}>ARSIPKAN</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
