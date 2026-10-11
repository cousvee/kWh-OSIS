/** One idempotency key per checkout attempt; reused for retries of the SAME order. */

const PENDING_KEY = "kwh.pending-checkout";
const TICKET_KEY = "kwh.ticket";

export function newIdempotencyKey(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // randomUUID needs HTTPS/localhost; tablets on a plain-http LAN need this fallback.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return "k-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PendingCheckout {
  key: string;
  signature: string;
}

function read<T>(name: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(name);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(name: string, value: unknown) {
  try {
    window.sessionStorage.setItem(name, JSON.stringify(value));
  } catch {
    /* storage unavailable: fine, we just lose refresh-survival */
  }
}
function remove(name: string) {
  try {
    window.sessionStorage.removeItem(name);
  } catch {
    /* ignore */
  }
}

export const loadPending = () => read<PendingCheckout>(PENDING_KEY);
export const savePending = (p: PendingCheckout) => write(PENDING_KEY, p);
export const clearPending = () => remove(PENDING_KEY);

export const loadSavedTicket = <T,>() => read<T>(TICKET_KEY);
export const saveTicket = (t: unknown) => write(TICKET_KEY, t);
export const clearSavedTicket = () => remove(TICKET_KEY);
