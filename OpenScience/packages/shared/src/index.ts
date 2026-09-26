// Stable domain types for EviMed.
// Imported by the desktop app now, and by the SDK / runtime in later slices.

export type RuntimeStatus = "connecting" | "ready" | "error" | "offline";
export type ModelStatus = "connected" | "disconnected" | "error";

export interface Project {
  id: string;
  name: string;
  sessions: Session[];
}

export type SessionGroup = "Examples" | "Today" | "Active" | "Earlier";

export interface Session {
  id: string;
  projectId: string;
  title: string;
  group: SessionGroup;
  /** Optional right-aligned count badge, e.g. running agents. */
  badge?: number;
  /** Status dot color hint. */
  status?: "idle" | "running" | "done" | "warn";
  blocks: ThreadBlock[];
  inspector?: Inspector;
}

// ---- Thread blocks (center pane) ----

export type ThreadBlock =
  | UserMessageBlock
  | AgentMessageBlock
  | StepSummaryBlock
  | ToolCallBlock
  | ReviewerBlock
  | DataTableBlock
  | FigureBlock
  | ArtifactBlock
  | RunningJobsBlock
  | StatusLineBlock;

export interface UserMessageBlock {
  kind: "user";
  text: string;
}

export interface AgentMessageBlock {
  kind: "agent";
  /** Markdown; inline `code` tokens are rendered as blue mono. */
  markdown: string;
}

export interface StepSummaryBlock {
  kind: "step-summary";
  summary: string;
  steps: number;
  details?: string[];
}

export type ToolCallStatus =
  | "pending"
  | "running"
  | "waiting-approval"
  | "success"
  | "warning"
  | "failed";

export interface ToolCallBlock {
  kind: "tool-call";
  /** What to recognize the step by: a de-noised command, a file path, a
   *  pattern — never the raw `cd … && …` line (that lives in `command`). */
  title: string;
  status: ToolCallStatus;
  /** Right-aligned meta, e.g. "142 lines of output" or "16m 2s". */
  meta?: string;
  /** Display verb rendered before the title ("Ran", "Created", "Edited"…). */
  verb?: string;
  /** Model-visible tool name ("bash", "write", "mcp__evimed__…") — picks the detail renderer. */
  tool?: string;
  /**
   * The call this block is showing. A result frame arrives separately from its
   * call, and pairing them by position broke the moment two tools ran at once —
   * which is the normal case, not the exception.
   */
  callId?: string;
  /** Full command line as executed (bash) — shown in the expanded detail. */
  command?: string;
  filePath?: string;
  /** Written file content (write tools), for the inline detail view. */
  content?: string;
  /** Unified diff (edit tools), for the inline detail view. */
  diff?: string;
  /** Live stdout tail while the tool is running (already \r-folded + capped). */
  partialOutput?: string;
  /** Final output, for the expanded detail view. */
  output?: string;
  /** Epoch ms — drive the elapsed timer (running) and duration meta (done). */
  startedAt?: number;
  endedAt?: number;
  /** Output of a user-typed "!" command — its detail view opens by default. */
  outputSummary?: string;
  /** Subagent session spawned by this task tool — lets the UI show its live activity. */
  childSessionId?: string;
}

export type FindingLevel = "warn" | "ok" | "error";

/**
 * Which check produced a finding: P0-4's three traceability audits, `domain`
 * for P0-5's domain-correctness gates, and `integrity` for P1-6's
 * analysis-integrity gate. `domain`/`integrity` findings carry their own `tag`
 * (e.g. "physics · units", "stats · prereg") so new checks need no UI change.
 */
export type ReviewCheck = "citation" | "number" | "figure" | "domain" | "integrity";

export interface ReviewFinding {
  level: FindingLevel;
  title: string;
  /** Monospace evidence body. */
  evidence?: string;
  check?: ReviewCheck;
  /** Freeform label shown on the card, overriding the check name (used by
   *  domain-correctness findings, e.g. "earth · crs"). */
  tag?: string;
}

export interface ReviewerBlock {
  kind: "reviewer";
  findings: ReviewFinding[];
  note?: string;
}

export interface DataTableBlock {
  kind: "table";
  columns: string[];
  /** Cells rendered with mono where they look code-like. */
  rows: string[][];
  caption?: string;
}

export interface FigureBlock {
  kind: "figure";
  title: string;
  /** Image URL / data URI; a placeholder this slice. */
  src: string;
  caption?: string;
  /** Reviewer/user pins dropped on the figure. */
  annotations?: FigureAnnotation[];
}

export interface FigureAnnotation {
  index: number;
  note: string;
  /** Percent position of the pin within the image. */
  x: number;
  y: number;
}

/** File the agent produced, surfaced as a traceable artifact in the thread. */
export type ArtifactKind =
  | "figure"
  | "script"
  | "report"
  | "table"
  | "model"
  | "data";

export interface ArtifactBlock {
  kind: "artifact";
  /** Workspace-relative path the tool wrote. */
  path: string;
  filename: string;
  artifact: ArtifactKind;
  /** Tool that produced it, e.g. "write" / "edit". */
  tool: string;
  /** Text content when the producing tool carried it (write/edit); absent for binary. */
  content?: string;
  language?: string;
}

export interface RunningJob {
  label: string;
  elapsed: string;
}

export interface RunningJobsBlock {
  kind: "running-jobs";
  title: string; // e.g. "REMOTE · 8"
  jobs: RunningJob[];
}

export interface StatusLineBlock {
  kind: "status-line";
  text: string; // e.g. "8 running · 16m 2s"
  /** Severity: only "error" renders red; "done"/"muted" are neutral. */
  tone?: "running" | "done" | "review" | "muted" | "error";
  /** A failed turn's triggering user text — the status line offers a resend. */
  retryText?: string;
}

// ---- Inspector (right pane) ----

export type Inspector =
  | ArtifactInspector
  | PdfInspector
  | FilePreviewInspector;

/** Folder tree a root-relative file path resolves in: the active session
 *  workspace (default) or the base folder all session workspaces live under. */
export type FileRoot = "workspace" | "base";

/** A workspace file surfaced for preview — the agent wrote it OR code produced it.
 *  Rendered by type: HTML → live iframe, PDF → pdf.js, image → <img>, text → code. */
export interface FilePreviewInspector {
  variant: "file";
  path: string;
  filename: string;
  artifact: ArtifactKind;
  language?: string;
  /** Inline text content when known (write/edit tools); else loaded from disk. */
  content?: string;
  /** Folder tree `path` resolves in (default "workspace"). */
  root?: FileRoot;
}

export interface ArtifactVersion {
  label: string; // "v1", "v2"
  /** Per-version overrides; fall back to the inspector-level fields when absent. */
  code?: string;
  executionLog?: string;
  messages?: string[];
  environment?: string;
  reviewPassed?: boolean;
}

export type ArtifactTab =
  | "Code"
  | "Execution Log"
  | "Messages"
  | "Environment"
  | "Review";

export type ArtifactType =
  | "figure"
  | "report"
  | "table"
  | "script"
  | "pdf";

export interface ArtifactInspector {
  variant: "artifact";
  title: string;
  /** Name used when downloading the script (defaults to `title`). */
  filename?: string;
  versions: ArtifactVersion[];
  activeVersion: string;
  reviewPassed?: boolean;
  inputs: string[];
  /** Source shown in the Code tab. */
  code: string;
  language: string;
  /** First line number to show. */
  codeStartLine?: number;
  executionLog?: string;
  environment?: string;
  messages?: string[];
}

export interface PdfInspector {
  variant: "pdf";
  title: string; // "review.pdf"
  /** HTML facsimile document sections rendered as a paper this slice. */
  doc: PdfDoc;
}

export interface PdfDoc {
  title: string;
  subtitle?: string;
  summaryTable?: DataTableBlock;
  figure?: FigureBlock;
  sections: PdfSection[];
}

export interface PdfSection {
  heading: string;
  body: string;
}

// ---- Provenance / citations ----

/** One recorded write of an artifact — a line in `.openscience/provenance.jsonl`.
 *  Every agent write appends one, so any artifact can reveal its generating
 *  code, environment, and originating conversation, per version. */
export interface ProvenanceRecord {
  /** Workspace-relative artifact path with `/` separators. */
  path: string;
  /** 1-based version, assigned on append. */
  version: number;
  /** Seconds since the epoch. */
  ts: number;
  /** Tool that produced this version, e.g. "write". */
  tool: string;
  sessionId?: string;
  /** Model configured when the version was recorded. */
  model?: string;
  /** Text the tool wrote (capped); absent for binary or indirect writes. */
  content?: string;
  /** Unified diff of an incremental edit when full content was not captured. */
  diff?: string;
  log?: string;
  /** Runtime environment captured when the version was recorded. */
  env?: ProvenanceEnv;
  /** Reproducible run that produced this artifact version. */
  runId?: string;
}

/** The environment a version was produced in — enough to reproduce. */
export interface ProvenanceEnv {
  /** Local Python version, e.g. "3.12.4". */
  python?: string;
  /** OS and architecture, e.g. "macos-aarch64". */
  platform: string;
  /** EviMed app version that recorded it. */
  app: string;
  /** Installed Python packages (pip freeze), content-addressed to a lockfile. */
  packages?: PackageSnapshot;
  /** Hardware used by the recorded execution. */
  hardware?: HardwareInfo;
}

export interface HardwareInfo {
  cpu?: string;
  cores?: number;
  memGb?: number;
  gpu?: string[];
  accelerator?: string;
}

/** One append-only experiment or analysis execution recipe. */
export interface RunRecord {
  runId: string;
  ts: number;
  sessionId?: string;
  model?: string;
  command: string;
  surface?: "local" | "hpc" | "modal" | "jupyter" | "ssh";
  host?: string;
  jobId?: string;
  remoteHardware?: string;
  status: "ok" | "failed";
  wallMs?: number;
  code?: RunArtifact[];
  outputs?: RunArtifact[];
  logHash?: string;
  env?: ProvenanceEnv;
}

export interface RunArtifact {
  path: string;
  hash?: string;
  size: number;
}

export interface PackageSnapshot {
  /** Number of installed packages captured. */
  count: number;
  /** Short content hash; the lockfile is `.openscience/env/<hash>.txt`. */
  hash: string;
}

export interface Citation {
  id: string; // DOI / PMID / arXiv id
  title: string;
  year?: number;
  source?: string;
}

// ---- Chart design system (P1-5) ----
// One validated palette, the single source of truth for BOTH native app charts
// (SVG stat tiles, mini-bars) and agent-generated figures (matplotlib, via the
// bundled `openscience.mplstyle` which carries the same hexes). Validated with
// the dataviz skill against the app's real surfaces — light #ffffff and
// #f8f8f9, dark #1d2225 and #14181a (2026-09-18) — for the lightness band,
// chroma floor, CVD separation, the normal-vision floor and contrast. The
// order is the colour-vision mechanism: the previous order of these same
// hexes put orange beside pink (normal-vision ΔE 12.9) and, in dark, pink
// beside red (7.8), both under the 15 floor.
// Categorical hues are assigned in this fixed order, never cycled.

export type ChartTheme = "light" | "dark";

export interface ChartPalette {
  /** Categorical series hues, in fixed assignment order (identity encoding). */
  categorical: string[];
  /** Single-hue sequential ramp, light→dark (magnitude encoding). */
  sequential: string[];
  /** Reserved state colors — never reused as a series hue. */
  status: { good: string; warning: string; serious: string; critical: string };
}

/**
 * Light-mode palette (chart surface #ffffff).
 *
 * Slot 1 is the brand: in a comparison chart "ours" is always the brand blue
 * and every competitor is a grey (slots 7, 8 and `--chart-rival-*`). A chart of
 * eight rainbow brands tells a reader nothing about which one is theirs.
 *
 * Kept as literals rather than imported so this package stays dependency-free;
 * `apps/web/src/lib/chartPalette.test.ts` asserts they equal
 * `@evimed/design-tokens`' `CHART_SERIES`, so drift is a red test.
 */
export const CHART_PALETTE_LIGHT: ChartPalette = {
  categorical: ["#0a5dc1", "#e07b39", "#1d9a87", "#7b5cd6", "#c94f7c", "#c7a12b", "#5a626b", "#b4bcc5"],
  sequential: ["#f3f6fa", "#dce8f7", "#b3cdef", "#7fa9e3", "#3e7ed4", "#0a5dc1"],
  status: { good: "#1e7a4c", warning: "#a15c00", serious: "#d1594e", critical: "#c0362c" },
};

/** Dark-mode palette — the same hues stepped for the dark surface (#161b21). */
export const CHART_PALETTE_DARK: ChartPalette = {
  categorical: ["#5690dd", "#e8975f", "#3fb5a2", "#9b82e2", "#d7749a", "#d4b551", "#8a939c", "#c8cfd6"],
  sequential: ["#0a1f3e", "#0c3e7f", "#0a5dc1", "#3e7ed4", "#7fa9e3", "#b3cdef"],
  status: { good: "#7cc0a0", warning: "#e0b169", serious: "#e0877f", critical: "#d1594e" },
};

export function chartPalette(theme: ChartTheme): ChartPalette {
  return theme === "dark" ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT;
}

/** Categorical hue for series `i`, assigned in fixed order (wraps only past 8). */
export function seriesColor(i: number, theme: ChartTheme): string {
  const c = chartPalette(theme).categorical;
  return c[((i % c.length) + c.length) % c.length];
}
