import { create } from "zustand";

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
  /** Hovering or focusing a toast pauses its auto-dismiss timer (P1-7). */
  pause: (id: number) => void;
  resume: (id: number) => void;
}

let nextId = 1;
/** Errors stay up longer — they carry the "what went wrong" detail (P1-7). */
const TOAST_MS: Record<Toast["tone"], number> = { success: 3500, error: 6000 };

interface Timer {
  handle: ReturnType<typeof setTimeout>;
  startedAt: number;
  remaining: number;
  paused: boolean;
}
const timers = new Map<number, Timer>();

export const useToastStore = create<ToastState>((set) => {
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
      set((s) => ({ toasts: [...s.toasts, { id, tone, message, action: options?.action }] }));
      schedule(id, TOAST_MS[tone]);
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
