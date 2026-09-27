import { create } from "zustand";
import { TOAST_DURATIONS } from "@evimed/design-tokens";

/** Optional CTA on a toast (e.g. undo) — clicking it also dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
}

export interface Toast {
  id: number;
  tone: "success" | "error";
  message: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: Toast["tone"], message: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
  /** Hovering or focusing a toast pauses its auto-dismiss timer. */
  pause: (id: number) => void;
  resume: (id: number) => void;
}

/** At most three on screen; a fourth sends the oldest away early (spec §22.1). */
export const MAX_TOASTS = 3;

/**
 * How long a toast stays, from the token table (`TOAST_DURATIONS`, spec
 * §22.1, appendix E #7): a success 5 s, one that carries an action (撤销,
 * 查看) 10 s — long enough to reach the button — and an error until it is
 * closed. An error that left by itself after six seconds was an error a reader
 * who looked away never saw. `null` means no timer.
 */
export function toastDuration(tone: Toast["tone"], hasAction: boolean): number | null {
  if (tone === "error") return TOAST_DURATIONS.error > 0 ? TOAST_DURATIONS.error : null;
  return hasAction ? TOAST_DURATIONS.action : TOAST_DURATIONS.success;
}

let nextId = 1;

interface Timer {
  handle: ReturnType<typeof setTimeout>;
  startedAt: number;
  remaining: number;
  paused: boolean;
}
const timers = new Map<number, Timer>();

export const useToastStore = create<ToastState>((set, get) => {
  const remove = (id: number) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer.handle);
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  };
  const schedule = (id: number, ms: number) => {
    timers.set(id, { handle: setTimeout(() => remove(id), ms), startedAt: Date.now(), remaining: ms, paused: false });
  };
  return {
    toasts: [],
    push: (tone, message, options) => {
      const id = nextId++;
      // The oldest leaves first, even an error: a fourth message is newer news.
      for (const old of get().toasts.slice(0, Math.max(0, get().toasts.length - (MAX_TOASTS - 1)))) remove(old.id);
      set((s) => ({ toasts: [...s.toasts, { id, tone, message, action: options?.action }] }));
      const ms = toastDuration(tone, Boolean(options?.action));
      if (ms !== null) schedule(id, ms);
    },
    dismiss: remove,
    // Idempotent: pointer/focus moving across the toast's children may fire
    // pause repeatedly, and only the first one may bank the elapsed time.
    pause: (id) => {
      const timer = timers.get(id);
      if (!timer || timer.paused) return;
      clearTimeout(timer.handle);
      timer.remaining -= Date.now() - timer.startedAt;
      timer.paused = true;
    },
    resume: (id) => {
      const timer = timers.get(id);
      if (!timer || !timer.paused) return;
      if (timer.remaining <= 0) {
        remove(id);
        return;
      }
      schedule(id, timer.remaining);
    },
  };
});

export const toast = {
  success: (message: string, options?: ToastOptions) => useToastStore.getState().push("success", message, options),
  error: (message: string, options?: ToastOptions) => useToastStore.getState().push("error", message, options),
};
