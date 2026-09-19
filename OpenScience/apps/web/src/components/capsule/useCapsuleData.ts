import { useCallback, useEffect, useRef, useState } from "react";
import { MEMORY_CHANGED_EVENT } from "@/lib/memoryClient";

/**
 * One read for a capsule section, in the four states every list has: loading
 * (nothing yet), failed (with the way to try again), and the data — empty or
 * not is the section's to say. Read again whenever any capsule surface says
 * memory changed, so an undo in a toast is never contradicted by the page.
 *
 * A failed re-read keeps what was on screen and says so, rather than blanking
 * a page the researcher was reading.
 */
export function useCapsuleData<T>(load: () => Promise<T>): {
  data: T | null;
  failed: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(() => {
    const current = ++generation.current;
    void loader.current().then(
      (next) => { if (current === generation.current) { setData(next); setFailed(false); } },
      () => { if (current === generation.current) setFailed(true); },
    );
  }, []);

  useEffect(() => {
    // The counter object, not its value: bumping it on the way out is what
    // makes a read still in flight land nowhere.
    const reads = generation;
    reload();
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => { reads.current++; window.removeEventListener(MEMORY_CHANGED_EVENT, reload); };
  }, [reload]);

  return { data, failed, reload };
}
