import { callRpc } from "./rpc";
import { KwhError } from "./errors";

export type StaffRole = "kitchen" | "cashier" | "admin";

export interface StaffSession {
  token: string;
  role: StaffRole;
  expires_at: string;
  must_change: boolean;
}

export const ROLE_LABELS: Record<StaffRole, string> = {
  kitchen: "Dapur",
  cashier: "Kasir",
  admin: "Admin",
};

const KEY = "kwh.staff-session";
export const SESSION_ENDED_EVENT = "kwh:session-ended";

/**
 * The browser keeps ONLY the opaque session token (valid 12h on the server).
 * The role stored next to it is for display; every privileged call is
 * re-checked by the database against the token, so editing this value in
 * devtools gives no extra power.
 */
export function getSession(): StaffSession | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StaffSession;
    if (!s.token || new Date(s.expires_at).getTime() <= Date.now()) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function setSession(s: StaffSession) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: session lives only until refresh */
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function patchSession(patch: Partial<StaffSession>) {
  const s = getSession();
  if (s) setSession({ ...s, ...patch });
}

interface LoginResponse {
  ok: boolean;
  error?: string;
  token?: string;
  role?: StaffRole;
  expires_at?: string;
  must_change?: boolean;
}

export async function login(role: StaffRole, passcode: string): Promise<StaffSession> {
  const res = await callRpc<LoginResponse>("staff_login", {
    p_role: role,
    p_passcode: passcode,
  });
  if (!res.ok || !res.token || !res.role || !res.expires_at) {
    throw new KwhError(res.error ?? "INVALID_CREDENTIALS");
  }
  const s: StaffSession = {
    token: res.token,
    role: res.role,
    expires_at: res.expires_at,
    must_change: !!res.must_change,
  };
  setSession(s);
  return s;
}

export async function logout() {
  const s = getSession();
  clearSession();
  if (s) {
    try {
      await callRpc("staff_logout", { p_token: s.token });
    } catch {
      /* session also expires on its own */
    }
  }
}

/** Calls a staff-only server function with the stored session token. */
export async function staffRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const s = getSession();
  if (!s) throw new KwhError("SESSION_INVALID");
  try {
    return await callRpc<T>(fn, { p_token: s.token, ...args });
  } catch (e) {
    if (e instanceof KwhError && (e.code === "SESSION_INVALID" || e.code === "SESSION_EXPIRED")) {
      clearSession();
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    }
    throw e;
  }
}
