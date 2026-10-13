"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { messageFor } from "@/lib/kwh/errors";
import { ROLE_LABELS, login, type StaffRole } from "@/lib/kwh/staff";
import { PasscodeForm } from "./passcode-form";
import { useStaffSession } from "./use-staff-session";

const ROLES: StaffRole[] = ["kitchen", "cashier", "admin"];

export function homeFor(role: StaffRole): string {
  if (role === "kitchen") return "/staff/kitchen";
  if (role === "cashier") return "/staff/cashier";
  return "/staff/admin";
}

export function StaffLogin() {
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const state = useStaffSession(null, version);
  const [role, setRole] = useState<StaffRole>("kitchen");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await login(role, passcode);
      if (!s.must_change) {
        router.replace(homeFor(s.role));
        return;
      }
      setVersion((v) => v + 1); // re-validate and show the next step
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const card = "mx-auto my-auto w-full max-w-md rounded-3xl border bg-card p-6";

  if (state.status === "loading") {
    return <div className={card}><p className="text-center text-muted-foreground">Memuat…</p></div>;
  }

  if (state.status === "ok" || state.status === "forbidden") {
    const s = state.session;
    if (s.must_change) {
      return (
        <div className={card}>
          <h1 className="text-2xl font-extrabold">Ganti passcode</h1>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">
            Passcode sementara harus diganti sebelum {ROLE_LABELS[s.role]} bisa dipakai.
          </p>
          <PasscodeForm
            role={s.role}
            knownCurrent={passcode || undefined}
            currentLabel="Passcode sementara (yang tadi dipakai untuk masuk)"
            onDone={() => {
              setPasscode("");
              router.replace(homeFor(s.role));
            }}
          />
        </div>
      );
    }
    // Already logged in (session kept for 12 hours): go straight to the screen.
    router.replace(homeFor(s.role));
    return <div className={card}><p className="text-center text-muted-foreground">Membuka layar {ROLE_LABELS[s.role]}…</p></div>;
  }

  return (
    <div className={card}>
      <p className="text-xs font-medium tracking-widest text-muted-foreground">KWh ANTRIAN</p>
      <h1 className="mb-5 text-2xl font-extrabold">Masuk Staf</h1>

      <div className="mb-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Peran">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={role === r}
            onClick={() => setRole(r)}
            className={cn(
              "min-h-14 rounded-xl border text-base font-semibold",
              role === r ? "border-primary bg-primary text-primary-foreground" : "bg-card",
            )}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Passcode</span>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          autoComplete="current-password"
          className="min-h-14 w-full rounded-xl border bg-background px-4 text-lg"
        />
      </label>

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || passcode.length === 0}
        className="mt-5 min-h-16 w-full rounded-2xl bg-primary text-xl font-extrabold text-primary-foreground disabled:opacity-50"
      >
        {busy ? "MEMERIKSA…" : "MASUK"}
      </button>
    </div>
  );
}
