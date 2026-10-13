"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { callRpc } from "@/lib/kwh/rpc";
import { KwhError, messageFor } from "@/lib/kwh/errors";
import { staffRpc } from "@/lib/kwh/staff";
import type { ActiveEvent } from "@/lib/kwh/types";
import { StaffShell } from "./staff-shell";
import { useStaffSession } from "./use-staff-session";

const POLL_MS = 5000;

/** Admin start page. More admin tools (finance, products, events) are added in Phase 5. */
export function AdminHome() {
  const router = useRouter();
  const state = useStaffSession(["admin"]);
  const [event, setEvent] = useState<ActiveEvent | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const ready = state.status === "ok" && !state.session.must_change;

  const load = useCallback(async () => {
    try {
      setEvent(await callRpc<ActiveEvent | null>("get_active_event"));
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    if (state.status === "anon") router.replace("/staff");
  }, [state.status, router]);

  useEffect(() => {
    if (!ready) return;
    void load();
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [ready, load]);

  async function setAccepting(accepting: boolean) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await staffRpc("set_accepting_orders", { p_accepting: accepting });
      setError(null);
    } catch (e) {
      if (!(e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED"))) setError(messageFor(e));
    } finally {
      lock.current = false;
      setBusy(false);
      await load();
    }
  }

  if (state.status === "loading" || state.status === "anon") {
    return <p className="p-6 text-center text-muted-foreground">Memuat…</p>;
  }
  if (state.status === "forbidden") {
    return (
      <div className="mx-auto my-auto max-w-md rounded-3xl border bg-card p-6 text-center">
        <h1 className="text-xl font-extrabold">Akses ditolak</h1>
        <p className="mt-2 text-muted-foreground">Hanya Admin yang boleh membuka layar ini.</p>
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

  const open = event?.accepting_orders !== false;
  const linkClass = "flex min-h-14 items-center justify-center rounded-xl border bg-card px-4 font-semibold";

  return (
    <StaffShell title="Admin" role={state.session.role}>
      <div className="mx-auto grid max-w-3xl gap-4">
        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <section aria-label="Kontrol acara" className="rounded-3xl border bg-card p-6">
          <p className="text-sm text-muted-foreground">Acara aktif</p>
          <h2 className="text-2xl font-extrabold">
            {event === undefined ? "Memuat…" : event ? event.name : "Belum ada acara aktif"}
          </h2>

          {event && (
            <div className="mt-4">
              <p
                className={cn(
                  "mb-3 inline-block rounded-full px-4 py-1 text-sm font-extrabold",
                  open ? "bg-emerald-600 text-white" : "bg-amber-500 text-black",
                )}
                data-testid="ordering-state"
              >
                {open ? "PEMESANAN DIBUKA" : "PEMESANAN DITUTUP SEMENTARA"}
              </p>
              <p className="mb-4 text-sm text-muted-foreground">
                {open
                  ? "Tutup sementara jika dapur kewalahan. Pelanggan masih bisa melihat menu, tetapi tidak bisa memesan."
                  : "Pelanggan tidak bisa membuat pesanan baru. Pesanan yang sudah masuk tetap diproses."}
              </p>
              <button
                type="button"
                onClick={() => void setAccepting(!open)}
                disabled={busy}
                className={cn(
                  "min-h-16 w-full rounded-2xl text-xl font-extrabold active:scale-[0.98] disabled:opacity-50",
                  open ? "bg-amber-500 text-black" : "bg-emerald-600 text-white",
                )}
              >
                {open ? "TUTUP PEMESANAN SEMENTARA" : "BUKA PEMESANAN LAGI"}
              </button>
            </div>
          )}
        </section>

        <section aria-label="Layar" className="grid gap-3 sm:grid-cols-2">
          <Link href="/staff/kitchen" className={linkClass}>Layar Dapur</Link>
          <Link href="/staff/cashier" className={linkClass}>Layar Kasir</Link>
          <Link href="/antrian" className={linkClass}>Layar Antrian (TV)</Link>
          <Link href="/" className={linkClass}>Layar Pelanggan</Link>
        </section>
      </div>
    </StaffShell>
  );
}
