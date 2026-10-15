"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { callRpc } from "@/lib/kwh/rpc";
import { KwhError } from "@/lib/kwh/errors";
import { staffRpc } from "@/lib/kwh/staff";
import type { ActiveEvent } from "@/lib/kwh/types";
import type { EventListItem, FullReport } from "@/lib/kwh/admin-types";
import { StaffShell } from "./staff-shell";
import { useStaffSession } from "./use-staff-session";
import { EventsTab } from "./admin/events-tab";
import { ExpensesTab } from "./admin/expenses-tab";
import { MenuTab } from "./admin/menu-tab";
import { OrdersTab } from "./admin/orders-tab";
import { OverviewTab } from "./admin/overview-tab";
import { ReportTab } from "./admin/report-tab";

type Tab = "ringkasan" | "pesanan" | "modal" | "menu" | "acara" | "laporan";
const TABS: { id: Tab; label: string }[] = [
  { id: "ringkasan", label: "Ringkasan" },
  { id: "pesanan", label: "Pesanan" },
  { id: "modal", label: "Modal" },
  { id: "menu", label: "Menu" },
  { id: "acara", label: "Acara" },
  { id: "laporan", label: "Laporan" },
];
const POLL_MS = 5000;

const isSessionError = (e: unknown) => e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED");

/** Admin panel: overview, orders, modal (expenses), menu, events and the sales report. */
export function AdminHome() {
  const router = useRouter();
  const state = useStaffSession(["admin"]);
  const [tab, setTab] = useState<Tab>("ringkasan");
  const [selectedId, setSelectedId] = useState<string | null>(null); // null = the active event
  const [activeEvent, setActiveEvent] = useState<ActiveEvent | null | undefined>(undefined);
  const [events, setEvents] = useState<EventListItem[] | null>(null);
  const [report, setReport] = useState<FullReport | null>(null);
  const [reportState, setReportState] = useState<"loading" | "ok" | "none">("loading");
  const selRef = useRef<string | null>(null);
  selRef.current = selectedId;

  const ready = state.status === "ok" && !state.session.must_change;

  const loadActive = useCallback(async () => {
    try {
      setActiveEvent(await callRpc<ActiveEvent | null>("get_active_event"));
    } catch {
      /* keep last value */
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await staffRpc<EventListItem[]>("list_events"));
    } catch (e) {
      if (!isSessionError(e)) setEvents((cur) => cur);
    }
  }, []);

  const loadReport = useCallback(async () => {
    const wanted = selRef.current;
    try {
      const r = await staffRpc<FullReport>("get_event_full_report", { p_event_id: wanted });
      if (selRef.current === wanted) {
        setReport(r);
        setReportState("ok");
      }
    } catch (e) {
      if (isSessionError(e)) return;
      if (selRef.current === wanted) {
        setReport(null);
        setReportState("none");
      }
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadActive(), loadEvents(), loadReport()]);
  }, [loadActive, loadEvents, loadReport]);

  useEffect(() => {
    if (state.status === "anon") router.replace("/staff");
  }, [state.status, router]);

  useEffect(() => {
    if (!ready) return;
    void reloadAll();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadActive();
      void loadReport();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [ready, reloadAll, loadActive, loadReport]);

  // Switching the viewed event: refetch immediately.
  useEffect(() => {
    if (!ready) return;
    setReportState("loading");
    void loadReport();
  }, [selectedId, ready, loadReport]);

  if (state.status === "loading" || state.status === "anon") {
    return <p className="p-6 text-center text-muted-foreground">Memuat…</p>;
  }
  if (state.status === "forbidden") {
    return (
      <div className="mx-auto my-auto max-w-md rounded-3xl border bg-card p-6 text-center">
        <h1 className="text-xl font-extrabold">Akses ditolak</h1>
        <p className="mt-2 text-muted-foreground">Hanya Admin yang boleh membuka layar ini.</p>
        <Link href="/staff" className="mt-4 inline-flex min-h-12 items-center rounded-xl bg-secondary px-5 font-semibold">Kembali</Link>
      </div>
    );
  }
  if (state.session.must_change) {
    router.replace("/staff");
    return <p className="p-6 text-center text-muted-foreground">Memuat…</p>;
  }

  const effectiveEventId = report?.event.id ?? selectedId;
  const viewingActive = !!activeEvent && report?.event.id === activeEvent.id;
  const readOnly = report ? report.event.status === "archived" : false;

  return (
    <StaffShell title="Admin" role={state.session.role}>
      <div className="mx-auto max-w-5xl">
        <div className="mb-3 flex flex-wrap items-center gap-3 print:hidden">
          <label className="flex items-center gap-2 text-sm font-medium">
            Acara:
            <select
              aria-label="Pilih acara"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value === "" ? null : e.target.value)}
              className="min-h-12 rounded-xl border bg-background px-3 text-base"
            >
              <option value="">{activeEvent ? `${activeEvent.name} (aktif)` : "Acara aktif (belum ada)"}</option>
              {(events ?? []).filter((e) => e.event.status !== "active").map((e) => (
                <option key={e.event.id} value={e.event.id}>{e.event.name} ({e.event.status === "completed" ? "selesai" : "arsip"})</option>
              ))}
            </select>
          </label>
          {!viewingActive && report && <span className="rounded-full bg-secondary px-3 py-1 text-xs font-bold">Melihat acara lama</span>}
        </div>

        <nav className="mb-4 flex gap-2 overflow-x-auto pb-1 print:hidden" role="tablist" aria-label="Menu admin">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={cn("min-h-12 shrink-0 rounded-full border px-5 font-semibold", tab === t.id ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>
              {t.label}
            </button>
          ))}
        </nav>

        {tab === "ringkasan" && (
          <OverviewTab report={report} reportState={reportState} activeEvent={activeEvent} reload={reloadAll} goTo={setTab} />
        )}
        {tab === "pesanan" && (reportState === "none" ? <p className="py-10 text-center text-muted-foreground">Belum ada acara.</p> : <OrdersTab eventId={effectiveEventId} onChanged={reloadAll} />)}
        {tab === "modal" && (reportState === "none" ? <p className="py-10 text-center text-muted-foreground">Belum ada acara.</p> : <ExpensesTab eventId={effectiveEventId} readOnly={readOnly} onChanged={reloadAll} />)}
        {tab === "menu" && <MenuTab />}
        {tab === "acara" && (
          <EventsTab activeEvent={activeEvent} events={events} reload={reloadAll} viewReport={(id) => { setSelectedId(id); setTab("laporan"); }} />
        )}
        {tab === "laporan" && <ReportTab report={report} eventId={effectiveEventId} readOnly={readOnly} reload={reloadAll} />}
      </div>
    </StaffShell>
  );
}
