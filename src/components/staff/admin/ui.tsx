"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {message}
    </p>
  );
}

export function Card({ title, children, className, label }: { title?: string; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? title} className={cn("rounded-2xl border bg-card p-5", className)}>
      {title && <h2 className="mb-3 text-lg font-extrabold">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone, testId }: { label: string; value: string; tone?: "good" | "bad" | "warn"; testId?: string }) {
  return (
    <div className="rounded-2xl border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        data-testid={testId}
        className={cn(
          "text-2xl font-extrabold tabular-nums",
          tone === "good" && "text-emerald-600",
          tone === "bad" && "text-destructive",
          tone === "warn" && "text-amber-600",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function Modal({ title, children, onClose, label }: { title: string; children: ReactNode; onClose: () => void; label?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:hidden" role="dialog" aria-modal="true" aria-label={label ?? title}>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-3xl bg-card p-6">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-xl font-extrabold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Tutup" className="min-h-10 rounded-lg px-3 text-muted-foreground">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const inputClass = "min-h-12 w-full rounded-xl border bg-background px-4 text-base";
export const btnPrimary = "min-h-12 rounded-xl bg-primary px-5 font-bold text-primary-foreground active:scale-[0.98] disabled:opacity-50";
export const btnGhost = "min-h-12 rounded-xl border px-4 font-semibold active:scale-[0.98] disabled:opacity-50";
export const btnDanger = "min-h-12 rounded-xl bg-destructive px-5 font-bold text-white active:scale-[0.98] disabled:opacity-50";

/** Digits only, for Rupiah amounts typed into text inputs. */
export function digits(v: string): string {
  return v.replace(/[^0-9]/g, "").slice(0, 10);
}
