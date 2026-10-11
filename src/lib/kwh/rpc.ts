import { createClient } from "@/lib/client";
import { KwhError } from "./errors";

/**
 * Calls a Supabase server function (RPC) and converts every failure into a
 * KwhError with a stable code. The browser only ever uses the public
 * publishable key; all authority lives in the database functions.
 */
export async function callRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    throw new KwhError("CONFIG");
  }

  let res;
  try {
    res = await createClient().rpc(fn, args);
  } catch {
    throw new KwhError("NETWORK");
  }

  if (res.error) {
    const { message, code, details } = res.error;
    // Our functions raise errors as: SQLSTATE P0001, message = "SOME_CODE".
    if (code === "P0001" && /^[A-Z][A-Z_]+$/.test(message)) {
      throw new KwhError(message, details || undefined);
    }
    // supabase-js reports a failed fetch as an error without an SQLSTATE code.
    if (!code || /fetch|network|load failed/i.test(message)) {
      throw new KwhError("NETWORK");
    }
    console.error("RPC error", fn, res.error);
    throw new KwhError("UNKNOWN");
  }
  return res.data as T;
}
