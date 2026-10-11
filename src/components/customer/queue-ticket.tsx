"use client";

import { formatRupiah } from "@/lib/kwh/format";
import {
  PAYMENT_LABELS,
  PRODUCTION_LABELS,
  type Ticket,
} from "@/lib/kwh/types";

interface QueueTicketProps {
  ticket: Ticket;
  eventName: string;
  onNewOrder: () => void;
}

/** Full-screen ticket. Every value comes from the server response. */
export function QueueTicket({ ticket, eventName, onNewOrder }: QueueTicketProps) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Tiket antrian"
    >
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center gap-6 px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">{eventName}</p>

        <div className="w-full rounded-3xl border-2 border-primary bg-card px-6 py-8">
          <p className="text-lg font-medium tracking-widest text-muted-foreground">
            NOMOR ANTRIAN
          </p>
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
                <span className="tabular-nums text-muted-foreground">
                  {formatRupiah(item.subtotal)}
                </span>
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
            <p className="text-xl font-bold">{PAYMENT_LABELS[ticket.payment_status]}</p>
          </div>
          <div className="rounded-2xl bg-muted px-4 py-3">
            <p className="text-xs text-muted-foreground">STATUS PESANAN</p>
            <p className="text-xl font-bold">{PRODUCTION_LABELS[ticket.production_status]}</p>
          </div>
        </div>

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
