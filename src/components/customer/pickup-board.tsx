"use client";

import { useEffect, useRef, useState } from "react";
import { callRpc } from "@/lib/kwh/rpc";
import { messageFor } from "@/lib/kwh/errors";
import { isAudioReady, playReady, unlockAudio } from "@/lib/kwh/sound";
import type { PickupBoardData } from "@/lib/kwh/types";

const POLL_MS = 3000;
const FLASH_MS = 8000;

/** Public screen for a TV/monitor: queue numbers only, no personal data. */
export function PickupBoard() {
  const [board, setBoard] = useState<PickupBoardData | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [soundOn, setSoundOn] = useState(false);
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const b = await callRpc<PickupBoardData | null>("get_pickup_board");
        if (stopped) return;
        setBoard(b ?? null);
        setError(null);
        const ready = new Set(b?.ready ?? []);
        if (known.current !== null) {
          const fresh = [...ready].filter((n) => !known.current!.has(n));
          if (fresh.length > 0) {
            playReady();
            setFlash((f) => new Set([...f, ...fresh]));
            window.setTimeout(() => {
              setFlash((f) => {
                const c = new Set(f);
                fresh.forEach((n) => c.delete(n));
                return c;
              });
            }, FLASH_MS);
          }
        }
        known.current = ready;
      } catch (e) {
        if (!stopped) setError(messageFor(e));
      }
    }
    void load();
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  function enableSound() {
    unlockAudio();
    setSoundOn(true);
    playReady();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-widest text-muted-foreground">NOMOR ANTRIAN</p>
          <h1 className="text-3xl font-extrabold sm:text-5xl">{board?.event_name ?? "KWh Antrian"}</h1>
        </div>
        {!soundOn && !isAudioReady() && (
          <button type="button" onClick={enableSound} className="min-h-12 rounded-xl border px-5 font-semibold">
            🔔 Nyalakan suara
          </button>
        )}
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-destructive">
          {error}
        </p>
      )}

      {board === null && !error && (
        <p className="py-20 text-center text-2xl text-muted-foreground">Belum ada acara yang berlangsung.</p>
      )}
      {board === undefined && !error && <p className="py-20 text-center text-2xl text-muted-foreground">Memuat…</p>}

      {board && (
        <div className="grid flex-1 gap-6 lg:grid-cols-2">
          <section aria-label="Sedang disiapkan" className="rounded-3xl border bg-card p-6">
            <h2 className="mb-4 text-2xl font-extrabold sm:text-3xl">SEDANG DISIAPKAN</h2>
            {board.preparing.length === 0 ? (
              <p className="text-xl text-muted-foreground">—</p>
            ) : (
              <ul className="flex flex-wrap gap-3">
                {board.preparing.map((n) => (
                  <li key={n} className="rounded-2xl bg-secondary px-5 py-3 font-mono text-4xl font-extrabold sm:text-5xl">
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Siap diambil" className="rounded-3xl border-2 border-emerald-600 bg-emerald-600/10 p-6">
            <h2 className="mb-4 text-2xl font-extrabold text-emerald-700 sm:text-3xl dark:text-emerald-400">SIAP DIAMBIL</h2>
            {board.ready.length === 0 ? (
              <p className="text-xl text-muted-foreground">—</p>
            ) : (
              <ul className="flex flex-wrap gap-4">
                {board.ready.map((n) => (
                  <li
                    key={n}
                    data-testid={`ready-${n}`}
                    className={
                      "rounded-2xl bg-emerald-600 px-6 py-4 font-mono text-6xl font-extrabold text-white sm:text-7xl " +
                      (flash.has(n) ? "animate-pulse ring-8 ring-emerald-300" : "")
                    }
                  >
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
