import { useEffect, useRef } from "react";
import type { EpisodeRecord } from "@/lib/autopilotClient";
import { toast } from "@/lib/toast";
import { inFlight, runState } from "./taskPresentation";

/**
 * A scheduled execution that ends while its page is open says so once (2026-11-01 audit D14: only 虚拟临床研究 did; an execution of a task
 * ended in silence unless the researcher was looking at the line that changed). It is a notice for an execution this page watched go from
 * on its way to over — one that was already over when the page loaded is no news, and one the researcher stopped themselves is something
 * they did. A researcher who is not on the page is told by the inbox, as before.
 */
export function useExecutionFinishToasts(episodes: readonly EpisodeRecord[], titleOf: (agendaId: string) => string | undefined): void {
  // Whether each execution was last seen on its way: only a true can become a notice.
  const watched = useRef(new Map<string, boolean>());
  const title = useRef(titleOf); title.current = titleOf;
  useEffect(() => {
    for (const episode of episodes) {
      if (inFlight(episode)) { watched.current.set(episode.id, true); continue; }
      if (watched.current.get(episode.id) !== true) continue;
      watched.current.set(episode.id, false);
      if (episode.payload.status === "canceled") continue;
      const name = title.current(episode.payload.agendaId);
      toast.success(`${name ? `“${name}”` : "定时任务"}${runState(episode.payload)}`, { eventId: "autopilot:execution-finished", entityId: episode.id });
    }
  }, [episodes]);
}
