/** Reports and exports are always in WIB (Asia/Jakarta), whatever the device's timezone. */
const TZ = "Asia/Jakarta";

function parts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

export function wibDate(iso: string | Date): string {
  const p = parts(typeof iso === "string" ? new Date(iso) : iso);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-14 09:12" */
export function wibDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const p = parts(typeof iso === "string" ? new Date(iso) : iso);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function todayWib(): string {
  return wibDate(new Date());
}

/** "14 Okt 2026, 09.12 WIB" for on-screen reading */
export function wibReadable(iso: string | null | undefined): string {
  if (!iso) return "-";
  return (
    new Intl.DateTimeFormat("id-ID", {
      timeZone: TZ,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso)) + " WIB"
  );
}
