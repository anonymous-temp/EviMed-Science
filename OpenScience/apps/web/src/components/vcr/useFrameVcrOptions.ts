import { useCallback, useEffect, useRef } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { getVcrHome, getVcrStudy, patchVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { VCR_CAPABILITIES } from "@evimed/domain";
import type { FrameVcrOptions, VcrStart } from "./frameVcrOptions";

export type { FrameVcrOptions } from "./frameVcrOptions";

/** The option builders, a chunk of their own (`frameVcrOptions.ts`). */
const builders = () => import("./frameVcrOptions");

/**
 * 虚拟临床研究's options in the conversation frame.
 *
 * When the conversation on screen is bound to one of the module's
 * capabilities, the shell finds the study the tab's project is (a study is an
 * ordinary project plus a study row) and tells the frame what to draw beside
 * the chip: 起点, 预期用途 and the single-task starters. A change the reader
 * makes there comes back as `vcr-options` and is written to the study with
 * `PATCH`; the frame is then told what the study now holds — read back from the
 * server, not assumed — so a refused write puts the old value back rather than
 * leaving the control lying.
 *
 * What the chip draws is built by `frameVcrOptions.ts`, loaded the first time a
 * 虚拟临床研究 conversation is on screen. Nothing here decides who may change what:
 * the routes do (`manage_study` for the intended use, `write` for the start),
 * and the frame is only offered the controls the reader's roles allow.
 *
 * Returns the handler for `vcr-options`.
 */
export function useFrameVcrOptions({
  projectId,
  sessionId,
  capabilityId,
  enabled,
  post,
}: {
  projectId: string;
  sessionId: string | null;
  capabilityId: string | null;
  enabled: boolean;
  post: (payload: FrameVcrOptions | { sessionId: string | null; clear: true }) => void;
}) {
  const found = useRef<{ sessionId: string; study: VcrStudy | null } | null>(null);
  const vcr = Boolean(capabilityId && (VCR_CAPABILITIES as readonly string[]).includes(capabilityId));

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    if (!vcr) {
      if (found.current) post({ sessionId, clear: true });
      found.current = null;
      return undefined;
    }
    let live = true;
    void Promise.all([
      getVcrHome()
        .then((home) => home.studies.find((entry) => entry.projectId === projectId) ?? null)
        .then((summary) => (summary ? getVcrStudy(summary.id) : null))
        // The module refusing, or the list not answering: the chip keeps its
        // starters and has nothing to write options to.
        .catch(() => null),
      builders(),
    ])
      .then(([study, { frameVcrOptions }]) => {
        if (!live) return;
        found.current = { sessionId, study };
        post(frameVcrOptions(sessionId, study));
      })
      // The builders' chunk would not load: the chip draws nothing extra.
      .catch(() => {});
    return () => { live = false; };
  }, [enabled, vcr, projectId, sessionId, post]);

  return useCallback((change: { sessionId?: unknown; start?: unknown; intendedUse?: unknown }) => {
    const current = found.current;
    const study = current?.study;
    if (!current || !study || (change.sessionId != null && change.sessionId !== current.sessionId)) return;
    // Loaded already: `found` is set only after the builders arrived.
    void builders().then(({ frameVcrOptions, isIntendedUse, isStart }) => {
      const patch: { action?: VcrStart; intendedUse?: VcrStudy["intendedUse"] } = {};
      if (isStart(change.start) && study.abilities.includes("write")) patch.action = change.start;
      if (isIntendedUse(change.intendedUse) && study.abilities.includes("manage_study")) patch.intendedUse = change.intendedUse;
      if (patch.action === undefined && patch.intendedUse === undefined) return;
      // What the study holds after the write is read back from the server: the
      // start is the study's own `requested` flags, and the frame should show
      // what they are rather than what was asked for.
      void patchVcrStudy(study.id, patch)
        .then(() => getVcrStudy(study.id))
        .then(
          (next) => {
            if (found.current === current) found.current = { ...current, study: next };
            post(frameVcrOptions(current.sessionId, next));
          },
          (error: unknown) => {
            toast.error(webErrorMessage(error, { fallback: "没有改成功，请稍后重试。" }));
            post(frameVcrOptions(current.sessionId, study));
          },
        );
    }, () => {});
  }, [post]);
}
