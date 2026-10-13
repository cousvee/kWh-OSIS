/**
 * Tiny sound + vibration helpers (no audio files needed).
 * Browsers only allow sound after a tap, so unlockAudio() must be called from
 * a click/tap handler (or via armAudioOnFirstGesture()).
 */
let ctx: AudioContext | null = null;
let armed = false;

type AudioCtor = typeof AudioContext;

export function unlockAudio(): boolean {
  try {
    const AC: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!AC) return false;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function isAudioReady(): boolean {
  return !!ctx && ctx.state === "running";
}

export function armAudioOnFirstGesture() {
  if (typeof window === "undefined" || armed) return;
  armed = true;
  const handler = () => {
    unlockAudio();
    window.removeEventListener("pointerdown", handler);
    window.removeEventListener("keydown", handler);
  };
  window.addEventListener("pointerdown", handler);
  window.addEventListener("keydown", handler);
}

function tone(freq: number, start: number, dur: number, volume = 0.3) {
  if (!ctx || ctx.state !== "running") return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Kitchen: a new order arrived. */
export function playNewOrder() {
  tone(880, 0, 0.15);
  tone(1175, 0.18, 0.28);
}

/** Customer / pickup screen: an order is ready. */
export function playReady() {
  tone(659, 0, 0.18);
  tone(784, 0.2, 0.18);
  tone(988, 0.4, 0.4);
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}
