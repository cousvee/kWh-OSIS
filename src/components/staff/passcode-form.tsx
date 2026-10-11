"use client";

import { useState } from "react";
import { messageFor } from "@/lib/kwh/errors";
import { patchSession, staffRpc, type StaffRole } from "@/lib/kwh/staff";

interface Props {
  role: StaffRole;
  /** When known (just logged in), the user isn't asked for it again. */
  knownCurrent?: string;
  /** Label for the "current passcode" box when it has to be asked. */
  currentLabel?: string;
  onDone: () => void;
  onCancel?: () => void;
}

export function PasscodeForm({ role, knownCurrent, currentLabel, onDone, onCancel }: Props) {
  const [current, setCurrent] = useState(knownCurrent ?? "");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (next.length < 6) return setError("Passcode baru minimal 6 karakter.");
    if (next !== confirm) return setError("Konfirmasi passcode tidak sama.");
    setBusy(true);
    setError(null);
    try {
      await staffRpc("change_passcode", { p_target_role: role, p_current: current, p_new: next });
      patchSession({ must_change: false });
      onDone();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const input = "min-h-14 w-full rounded-xl border bg-background px-4 text-lg";
  return (
    <div className="space-y-3">
      {!knownCurrent && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{currentLabel ?? "Passcode saat ini"}</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} autoComplete="current-password" />
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Passcode baru (min. 6 karakter)</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} className={input} autoComplete="new-password" />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Ulangi passcode baru</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className={input}
          autoComplete="new-password"
        />
      </label>
      {error && (
        <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        {onCancel && (
          <button type="button" onClick={onCancel} className="min-h-14 flex-1 rounded-xl border px-4 font-semibold">
            Batal
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="min-h-14 flex-1 rounded-xl bg-primary px-4 text-lg font-bold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "MENYIMPAN…" : "SIMPAN PASSCODE"}
        </button>
      </div>
    </div>
  );
}
