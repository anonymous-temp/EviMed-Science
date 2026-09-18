/**
 * Keeping keyboard focus inside a modal layer (WCAG 2.4.3, 2.1.2 — and appendix
 * D §4): every dialog in the shell traps Tab the same way, so it lives once.
 */

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** The elements Tab can reach inside a container, in document order. */
export function focusableIn(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

/** Keep Tab cycling through a container's focusable elements while it is open. */
export function trapTab(container: HTMLElement | null, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !container) return;
  const focusable = focusableIn(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!container.contains(active)) {
    // Focus drifted out (a click on the backdrop, say) — pull it back in.
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
