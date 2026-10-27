import { useLayoutEffect, useState, type RefObject } from 'react';

/** Available-space query for controls embedded in split panes; a viewport query cannot describe their room. */
export function useContainerNarrow(ref: RefObject<HTMLElement | null>, threshold: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      // jsdom has no geometry; zero is unknown rather than a narrow-width receipt.
      if (width > 0) setNarrow(width < threshold);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (!observer) window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); if (!observer) window.removeEventListener('resize', measure); };
  }, [ref, threshold]);
  return narrow;
}
