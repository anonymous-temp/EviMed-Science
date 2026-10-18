import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMemoryProfile, type WebMemoryProfile } from "@/lib/apiClient";
import { isMemoryServiceUnavailable } from "@/lib/memoryErrors";
import { MEMORY_CHANGED_EVENT, fetchMyCapsule, type MyCapsule } from "@/lib/memoryClient";
import { listAllHandbooks } from "@/lib/handbooksClient";
import { listAllMethods } from "@/lib/methodsClient";

type Handbooks = Awaited<ReturnType<typeof listAllHandbooks>>;
type Methods = Awaited<ReturnType<typeof listAllMethods>>;

/**
 * What the memory page has read, each part as it arrived (R19.1; the walk of the owner's account found 记忆胶囊 not answering in 30 s).
 *
 * The page used to wait for all four reads together — the memories, the notes of the researcher's own capsule, the learned methods, the
 * handbooks — and drew nothing under its tabs until the slowest had answered; on an account of a hundred memory files the slowest was a
 * walk of the engine. Each read is its own now: `undefined` while it is under way, `null` when it failed (a list that could not be read
 * is never an empty one), the data when it came. A tab fills the moment the reads it is made of are in (`SOURCES_OF`), and a re-read
 * keeps what is on screen until the new answer comes.
 */
export interface MemoryReads {
  profile: WebMemoryProfile | null | undefined;
  mine: MyCapsule | null | undefined;
  methods: Methods | null | undefined;
  handbooks: Handbooks | null | undefined;
  /** The memory service itself is down: the page says so in place of the lists it feeds, and nothing else breaks. */
  serviceDown: boolean;
}

export type MemoryRead = "profile" | "mine" | "methods" | "handbooks";

export function useMemoryReads(): { data: MemoryReads; reload: () => void } {
  const [data, setData] = useState<MemoryReads>({ profile: undefined, mine: undefined, methods: undefined, handbooks: undefined, serviceDown: false });
  const generation = useRef(0);

  const reload = useCallback(() => {
    const current = ++generation.current;
    const put = (patch: Partial<MemoryReads>) => { if (current === generation.current) setData((previous) => ({ ...previous, ...patch })); };
    fetchMemoryProfile().then(
      (profile) => put({ profile, serviceDown: false }),
      (error: unknown) => put({ profile: null, serviceDown: isMemoryServiceUnavailable(error) }),
    );
    fetchMyCapsule().then((mine) => put({ mine }), () => put({ mine: null }));
    listAllMethods("approved").then((methods) => put({ methods }), () => put({ methods: null }));
    listAllHandbooks("active").then((handbooks) => put({ handbooks }), () => put({ handbooks: null }));
  }, []);

  useEffect(() => {
    // The counter object, not its value: bumping it on the way out is what makes a read still in flight land nowhere.
    const reads = generation;
    reload();
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => { reads.current++; window.removeEventListener(MEMORY_CHANGED_EVENT, reload); };
  }, [reload]);

  return { data, reload };
}
