"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ROLE_LABELS, logout, type StaffRole } from "@/lib/kwh/staff";
import { PasscodeForm } from "./passcode-form";

interface Props {
  title: string;
  role: StaffRole;
  children: ReactNode;
}

export function StaffShell({ title, role, children }: Props) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [done, setDone] = useState(false);

  async function exit() {
    await logout();
    router.replace("/staff");
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3 print:hidden">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-extrabold">{title}</h1>
          <span className="rounded-full bg-secondary px-3 py-1 text-sm font-semibold">{ROLE_LABELS[role]}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setDone(false); setChanging(true); }} className="min-h-12 rounded-xl border px-4 text-sm font-semibold">
            Ganti passcode
          </button>
          <button type="button" onClick={() => void exit()} className="min-h-12 rounded-xl bg-secondary px-4 text-sm font-semibold">
            Keluar
          </button>
        </div>
      </header>
      <main className="flex-1 p-4">{children}</main>

      {changing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Ganti passcode">
          <div className="w-full max-w-md rounded-3xl bg-card p-6">
            <h2 className="mb-4 text-xl font-extrabold">Ganti passcode</h2>
            {done ? (
              <div className="space-y-4">
                <p>Passcode berhasil diganti.</p>
                <button type="button" onClick={() => setChanging(false)} className="min-h-14 w-full rounded-xl bg-primary font-bold text-primary-foreground">
                  TUTUP
                </button>
              </div>
            ) : (
              <PasscodeForm role={role} onDone={() => setDone(true)} onCancel={() => setChanging(false)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
