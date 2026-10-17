/**
 * One step a module's programme ran for the person in the module's own project, as 「AI 运行」 lists it (虚拟临床研究's studies, 循证
 * GEO's projects). The programme's steps are not conversations — the server marks each `role: "programme"` and no list of
 * conversations draws them — so the module's page reads them as a record: what each was, whether it is still going, and when it began.
 * Each module's client turns its own answer into this one shape, and `components/runs/ProgrammeRunsDrawer.tsx` is the one drawer.
 */
export interface ProgrammeRun {
  /** The session the step ran in — the key of its record, never a place to go. */
  sessionId: string;
  /** What the step was, in the person's words: 「写第 2 批稿件」, 「生成虚拟患者」. */
  label: string;
  state: "running" | "finished" | "stopped";
  /** When it began, as a row says it (「今天 14:32」); null when the platform did not record it. */
  at: string | null;
}

/** The three state words a run is read by; any other word the server sent is a run that did not finish. @param {unknown} value */
export function programmeRunState(value: unknown): ProgrammeRun["state"] {
  return value === "running" || value === "finished" ? value : "stopped";
}
