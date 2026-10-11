"use client";

import { useEffect, useState } from "react";
import {
  SESSION_ENDED_EVENT,
  clearSession,
  getSession,
  patchSession,
  staffRpc,
  type StaffRole,
  type StaffSession,
} from "@/lib/kwh/staff";
import { KwhError } from "@/lib/kwh/errors";

export type SessionState =
  | { status: "loading" }
  | { status: "anon" }
  | { status: "forbidden"; session: StaffSession }
  | { status: "ok"; session: StaffSession };

/**
 * UI convenience only: asks the server who this token belongs to and whether
 * the role fits this screen. The server re-checks on every real operation.
 */
export function useStaffSession(allowed: StaffRole[] | null, version = 0): SessionState {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const allowedKey = allowed ? allowed.join(",") : "*";

  useEffect(() => {
    let cancelled = false;
    const onEnded = () => !cancelled && setState({ status: "anon" });
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);

    (async () => {
      const stored = getSession();
      if (!stored) {
        if (!cancelled) setState({ status: "anon" });
        return;
      }
      try {
        const v = await staffRpc<{ role: StaffRole; expires_at: string; must_change: boolean }>(
          "staff_validate",
        );
        patchSession({ role: v.role, expires_at: v.expires_at, must_change: v.must_change });
        const session = { ...stored, role: v.role, expires_at: v.expires_at, must_change: v.must_change };
        if (cancelled) return;
        const list = allowedKey === "*" ? null : (allowedKey.split(",") as StaffRole[]);
        if (list && !list.includes(v.role)) setState({ status: "forbidden", session });
        else setState({ status: "ok", session });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) {
          clearSession();
          setState({ status: "anon" });
        } else {
          // Network hiccup: keep the stored session instead of logging staff out.
          const list = allowedKey === "*" ? null : (allowedKey.split(",") as StaffRole[]);
          if (list && !list.includes(stored.role)) setState({ status: "forbidden", session: stored });
          else setState({ status: "ok", session: stored });
        }
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
    };
  }, [allowedKey, version]);

  return state;
}
