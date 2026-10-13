"use client";

import { useEffect, useRef, useState } from "react";
import { callRpc } from "@/lib/kwh/rpc";
import { formatRupiah } from "@/lib/kwh/format";
import { playReady, vibrate } from "@/lib/kwh/sound";
import {
  PAYMENT_LABELS,
  PRODUCTION_LABELS,
  type PaymentStatus,
  type ProductionStatus,
  type Ticket,
  type TicketStatus,
} from "@/lib/kwh/types";

const POLL_MS = 4000;

interface QueueTicketProps {
  ticket: Ticket;
  eventName: string;
  onNewOrder: () => void;
}

/**
 * Full-screen ticket. Static details come from the server's order response;
 * the two statuses refresh by themselves (the ticket's secret id lets it read
 * ONLY its own statuses). When the kitchen marks it ready it turns green,
 * beeps and vibrates (if the device allows).
 */
export function QueueTicket({ ticket, eventName, onNewOrder }: QueueTicketProps) {
  const [payment, setPayment] = useState<PaymentStatus>(ticket.payment_status);
  const [production, setProduction] = useState<ProductionStatus>(ticket.production_status);
  const prev = useRef<ProductionStatus>(ticket.production_status);

  useEffect(() => {
    let stopped = false;
    const finished = (s: ProductionStatus) => s === "completed" || s === "cancelled";

    async function poll() {
      if (stopped || finished(prev.current)) return;
      try {
        const st = await callRpc<TicketStatus | null>("get_ticket_status", { p_order_id: ticket.id });
        if (stopped || !st) return;
        setPayment(st.payment_status);
        setProduction(st.production_status);
        if (st.production_status === "ready" && prev.current !== "ready") {
          playReady();
          vibrate([300, 150, 300, 150, 600]);
        }
        prev.current = st.production_status;
      } catch {
        /* offline for a moment: keep the last known status */
      }
    }

    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ticket.id]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Tiket antrian"
    >
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center gap-6 px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">{eventName}</p>

        {production === "ready" && (
          <div role="status" className="w-full rounded-3xl bg-emerald-600 px-6 py-5 text-white">
            <p className="text-3xl font-extrabold">SIAP DIAMBIL</p>
            <p className="mt-1 text-lg">Silakan ambil pesanan Anda.</p>
          </div>
        )}
        {production === "completed" && (
          <div role="status" className="w-full rounded-3xl bg-secondary px-6 py-4">
            <p className="text-2xl font-extrabold">PESANAN SELESAI</p>
            <p className="text-muted-foreground">Terima kasih!</p>
          </div>
        )}
        {production === "cancelled" && (
          <div role="status" className="w-full rounded-3xl bg-destructive px-6 py-5 text-white">
            <p className="text-2xl font-extrabold">PESANAN DIBATALKAN</p>
            <p className="mt-1">Hubungi panitia jika ini keliru.</p>
          </div>
        )}

        <div
          className={
            "w-full rounded-3xl border-2 bg-card px-6 py-8 " +
            (production === "ready" ? "border-emerald-600" : "border-primary")
          }
        >
          <p className="text-lg font-medium tracking-widest text-muted-foreground">NOMOR ANTRIAN</p>
          <p
            className="mt-2 font-mono text-8xl font-extrabold leading-none tracking-tight sm:text-9xl"
            data-testid="queue-number"
          >
            {ticket.queue_number}
          </p>
        </div>

        <dl className="grid w-full grid-cols-2 gap-4 text-left">
          <div className="rounded-2xl bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">Nama</dt>
            <dd className="break-words text-lg font-semibold">{ticket.customer_name}</dd>
          </div>
          <div className="rounded-2xl bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">Kelas</dt>
            <dd className="break-words text-lg font-semibold">{ticket.customer_class}</dd>
          </div>
        </dl>

        <div className="w-full rounded-2xl border bg-card px-5 py-4 text-left">
          <p className="mb-2 text-sm font-medium text-muted-foreground">Pesanan</p>
          <ul className="space-y-1.5">
            {ticket.items.map((item) => (
              <li key={item.product_name} className="flex justify-between gap-4 text-lg">
                <span>
                  {item.product_name} × {item.quantity}
                </span>
                <span className="tabular-nums text-muted-foreground">{formatRupiah(item.subtotal)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-baseline justify-between border-t pt-3">
            <span className="text-base font-medium">Total</span>
            <span className="text-3xl font-extrabold tabular-nums" data-testid="ticket-total">
              {formatRupiah(ticket.total_amount)}
            </span>
          </div>
        </div>

        <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-muted px-4 py-3">
            <p className="text-xs text-muted-foreground">STATUS PEMBAYARAN</p>
            <p className="text-xl font-bold">{PAYMENT_LABELS[payment]}</p>
          </div>
          <div className="rounded-2xl bg-muted px-4 py-3">
            <p className="text-xs text-muted-foreground">STATUS PESANAN</p>
            <p className="text-xl font-bold">{PRODUCTION_LABELS[production]}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Status diperbarui otomatis. Biarkan halaman ini terbuka.</p>

        <button
          type="button"
          onClick={onNewOrder}
          className="mt-auto min-h-16 w-full rounded-2xl bg-primary px-6 text-xl font-bold text-primary-foreground active:scale-[0.98]"
        >
          PESANAN BARU
        </button>
      </div>
    </div>
  );
}
