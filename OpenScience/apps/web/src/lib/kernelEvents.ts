import type { ToolCallStatus } from "@ai4s/shared";

/**
 * The kernel event shapes this shell still reads.
 *
 * They used to come from `@ai4s/sdk`, a client that spoke a kernel's own
 * protocol from the browser. That client is gone with the desktop shell, and
 * the browser no longer reaches a kernel at all: it reads the control plane's
 * `RunEvent` stream, and these are the payload shapes carried inside it.
 *
 * Only the shapes with a live reader are here. The rest of that client's
 * vocabulary — sessions, history, permissions replies over the wire — went
 * with it, because a type nothing reads is a claim nobody checks.
 */

export type { ToolCallStatus };

export interface ToolUpdatedEvent {
  type: "tool.updated";
  sessionId: string;
  callId: string;
  tool: string;
  status: ToolCallStatus;
  title?: string;
  /** Tool arguments (e.g. a write tool's `filePath` + `content`). */
  input?: Record<string, unknown>;
  /** Tool result text, when the tool returned one. */
  output?: string;
  /** Accumulated stdout tail while the tool is still running. */
  partialOutput?: string;
  /** Unified diff an edit tool reports. */
  diff?: string;
  /** Epoch ms the tool started / finished. */
  startedAt?: number;
  endedAt?: number;
  /** A task tool's spawned subagent session — that session's interactive
   *  requests (question/permission) belong to THIS conversation. */
  childSessionId?: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  /** Allow selecting more than one option. */
  multiple?: boolean;
  /** Allow a free-text answer in addition to the options. */
  custom?: boolean;
}

export interface QuestionAskedEvent {
  type: "question.asked";
  sessionId: string;
  requestId: string;
  questions: QuestionItem[];
}

export interface PermissionAskedEvent {
  type: "permission.asked";
  sessionId: string;
  requestId: string;
  /** e.g. "bash", "write", "edit" — what the agent wants to do. */
  action: string;
  /** The concrete targets (a command line, file paths). */
  resources: string[];
}

/** Approve a permission once, always (persist a rule), or reject it. */
export type PermissionReply = "once" | "always" | "reject";

/** How an MCP server is reached, as the runtime reports it. */
export type McpConfig =
  | { type: "local"; command: string[]; enabled?: boolean; environment?: Record<string, string> }
  | { type: "remote"; url: string; enabled?: boolean; headers?: Record<string, string> };
