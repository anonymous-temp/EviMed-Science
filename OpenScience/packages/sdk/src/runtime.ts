import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  RuntimeEvent,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  RuntimeStatus,
  SessionMeta,
  SkillInfo,
} from "./types";

/**
 * Runtime-agnostic boundary between the UI and an agent runtime.
 *
 * Provider, MCP, and OAuth configuration remain concrete OpenCode concerns;
 * this interface covers the portable conversation and execution surface only.
 */
export interface AgentRuntime {
  connect(): Promise<void>;
  close(): void;
  getStatus(): RuntimeStatus;
  onStatus(listener: (status: RuntimeStatus) => void): () => void;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;

  createSession(): Promise<string>;
  listSessions(): Promise<SessionMeta[]>;
  deleteSession(sessionId: string): Promise<void>;
  getMessages(sessionId: string): Promise<HistoryMessage[]>;
  sendPrompt(sessionId: string, text: string, agent?: string, model?: string | null): Promise<void>;
  abortSession(sessionId: string): Promise<void>;

  listSkills(): Promise<SkillInfo[]>;
  listAgents(): Promise<AgentInfo[]>;
  listCommands(): Promise<CommandInfo[]>;

  getDefaultModel(): Promise<string | null>;
  setDefaultModel(model: string): Promise<void>;

  runShell(sessionId: string, command: string, agent?: string): Promise<void>;
  runCommand(sessionId: string, command: string, args?: string): Promise<void>;

  listQuestions(sessionId?: string): Promise<QuestionAskedEvent[]>;
  listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]>;
  answerQuestion(requestId: string, answers: string[][]): Promise<void>;
  rejectQuestion(requestId: string): Promise<void>;
  replyPermission(requestId: string, reply: PermissionReply): Promise<void>;
}
