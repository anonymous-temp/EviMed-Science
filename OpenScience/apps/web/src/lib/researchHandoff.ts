import { productRequest } from "./productClient";
import type { RuntimeUiIntent } from "./runtimeUiNavigation";

/**
 * 「转为深度研究」, the shell's half: a quick answer's question, the sources it
 * found and the premises it assumed become a new research conversation whose
 * first message carries the 「来自 AI 搜索」 card.
 *
 * The control plane binds the conversation and writes that message
 * (`POST /api/research/handoffs`, docs/WEB_DEPLOYMENT.md); this opens it the
 * way every new conversation opens — a `create` intent carrying the draft,
 * which the person sends. EviMed's Vue shell calls the same endpoint and opens
 * its own frame the same way; this side exists for an arrival from outside the
 * app, as an address: `/app/handoff#<payload>`, the payload in the fragment so
 * it never reaches a server log.
 */

export interface HandoffSource {
  title: string;
  url?: string;
  doi?: string;
  pmid?: string;
  quote?: string;
}

export interface HandoffInput {
  question: string;
  sources?: HandoffSource[];
  premises?: string[];
  projectId?: string;
  capabilityId?: string;
}

export interface HandoffCreated {
  projectId: string;
  sessionId: string;
  draft: string;
}

/** The same bound the frame puts on a draft (`runtimeUiIntentFromState`). */
const MAX_FRAGMENT = 200_000;

/** An address's fragment as a hand-off, or null when it holds none. */
export function handoffFromFragment(hash: string): HandoffInput | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || raw.length > MAX_FRAGMENT || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Partial<HandoffInput>;
    return typeof input.question === "string" && input.question.trim() ? input as HandoffInput : null;
  } catch {
    return null;
  }
}

/** The fragment for a hand-off: base64url of its JSON. */
export function handoffFragment(input: HandoffInput): string {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `#${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Bind the conversation and write its first message. The server checks every field. */
export function createResearchHandoff(input: HandoffInput): Promise<HandoffCreated> {
  return productRequest<HandoffCreated>("/research/handoffs", "POST", input);
}

/** The new conversation, as the frame opens one: created under the bound id, the card in its composer. */
export function handoffIntent(created: HandoffCreated): RuntimeUiIntent {
  return { kind: "create", projectId: created.projectId, requestId: crypto.randomUUID(), sessionId: created.sessionId, draft: created.draft };
}
