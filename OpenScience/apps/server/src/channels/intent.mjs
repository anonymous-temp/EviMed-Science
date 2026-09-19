/**
 * What a chat message asks of the chat itself: move to another project, and
 * whether it also asks for work — or adds to the work already running.
 *
 * Language judgement, so a model makes it (principle 1): "换到糖尿病那个项目",
 * "在肿瘤项目里查一下", "对了，再加上老年人群" are not a command grammar, and a
 * keyword list over them is exactly the open-vocabulary regex principle 5
 * rules out. What code checks is only what code can: the project named is one
 * of the account's own, by id, and the answer has the three fields it should.
 * A failed or malformed verdict is dropped, never softened.
 *
 * Fail-safe by construction: no model, a timeout, an error or a bad answer
 * all mean "stay in this project, and treat the message as a new request" —
 * the one reading that never moves a conversation or edits a running task on
 * the strength of a guess.
 *
 * Deletable when the kernel exposes session-level intent a control plane can
 * read; the scaffolding is one prompt and one shape check.
 *
 * @module channels/intent
 */

import { callModelForControlPlane } from "../modelGateway.mjs";

/** The usage ledger's purpose for these calls (contract X1). */
export const CHANNEL_INTENT_PURPOSE = "channel-intent";

const instructions = [
  "你是 EviMed 研究助手在飞书里的消息分拣器。研究者发来一条消息；你会拿到他的项目列表、这个会话当前所在的项目，以及正在进行的任务（如有）。只判断三件事：",
  "1. switch_to：这条消息是否要求把这个会话换到列表里的另一个项目（例如「换到某某项目」「切到肿瘤那个项目」「在糖尿病项目里做」）。是，就填那个项目的 id；否则填 null。只能从列表里选，拿不准就填 null。",
  "2. has_request：除了换项目，消息里是否还有要回答或要完成的内容（提问、任务、补充要求、闲聊）。只是要求换项目、没有别的内容时填 false，其余一律填 true。",
  "3. continues_running_task：只在有正在进行的任务时判断——这条消息是在补充或修正那个任务（补充条件、改变范围、追加要求），而不是一个新的独立问题。没有正在进行的任务时填 false。",
  "只输出 JSON：{\"switch_to\": \"<项目 id 或 null>\", \"has_request\": true 或 false, \"continues_running_task\": true 或 false}。",
].join("\n");

/** @typedef {{ switchTo: string | null, hasRequest: boolean, continuesRunningTask: boolean, source: 'model' | 'fallback' | 'skipped', failure?: string }} ChannelIntent */

/** @returns {ChannelIntent} */
export function fallbackIntent(/** @type {string} */ failure) {
  return { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "fallback", failure };
}

/** @param {unknown} content */
function parsedVerdict(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [raw, ...[...raw.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && "switch_to" in parsed) return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The model's answer, re-verified. Null when it cannot be trusted as a whole.
 * @param {any} verdict @param {{ projectIds: readonly string[], currentProjectId: string, running: boolean }} context
 * @returns {ChannelIntent | null}
 */
export function verifiedIntent(verdict, { projectIds, currentProjectId, running }) {
  if (!verdict || typeof verdict !== "object") return null;
  const target = verdict.switch_to;
  if (target !== null && typeof target !== "string") return null;
  if (typeof verdict.has_request !== "boolean" || typeof verdict.continues_running_task !== "boolean") return null;
  // A project the account does not have is not a switch; neither is the one
  // the chat is already in.
  const switchTo = typeof target === "string" && projectIds.includes(target) && target !== currentProjectId ? target : null;
  return {
    switchTo,
    // "Nothing to answer" only makes sense for a message that moved the chat;
    // anything else — a greeting included — deserves a reply.
    hasRequest: switchTo ? verdict.has_request : true,
    continuesRunningTask: running && verdict.continues_running_task === true,
    source: "model",
  };
}

export class ChannelIntentClassifier {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, fetchImpl?: typeof fetch,
   *   callModel?: (deps: Record<string, any>, call: Record<string, any>) => Promise<any> }} [options]
   */
  constructor(config, { usageLedger = null, fetchImpl = globalThis.fetch, callModel = callModelForControlPlane } = {}) {
    this.config = config;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.callModel = callModel;
    // On the reply's critical path, so the gateway's own timeout caps it at 30 s.
    this.timeoutMs = Math.max(1_000, Math.min(30_000, Number(config?.modelGatewayTimeoutMs ?? 30_000)));
  }

  get available() {
    return this.config?.deepseekProviderEnabled === true && Boolean(this.config?.deepseekApiKey);
  }

  /**
   * @param {{ userId: string, projectId: string, text: string, projects: readonly { id: string, name: string }[],
   *   runningTask?: { question: string } | null }} input
   * @returns {Promise<ChannelIntent>}
   */
  async classify({ userId, projectId, text, projects, runningTask = null }) {
    const running = Boolean(runningTask);
    // Nothing to decide: one project and nothing running leaves only "a new
    // request here", which is also the fail-safe answer. No call is made.
    if (projects.length <= 1 && !running) return { switchTo: null, hasRequest: true, continuesRunningTask: false, source: "skipped" };
    if (!this.available) return fallbackIntent("model_unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await this.callModel(
        { config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl },
        {
          userId,
          projectId,
          runId: null,
          purpose: CHANNEL_INTENT_PURPOSE,
          signal: controller.signal,
          body: {
            model: this.config.deepseekModel,
            temperature: 0,
            // A closed choice over a short list: thinking off (plan §3.4).
            thinking: { type: "disabled" },
            max_tokens: 2_000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: instructions },
              {
                role: "user",
                content: JSON.stringify({
                  message: String(text).slice(0, 2_000),
                  projects: projects.slice(0, 50).map((project) => ({ id: project.id, name: project.name })),
                  current_project: projectId,
                  running_task: runningTask ? { question: String(runningTask.question ?? "").slice(0, 500) } : null,
                }),
              },
            ],
          },
        },
      );
      const message = body?.choices?.[0]?.message;
      const verdict = parsedVerdict(message?.content) ?? parsedVerdict(message?.reasoning_content);
      return verifiedIntent(verdict, { projectIds: projects.map((project) => project.id), currentProjectId: projectId, running })
        ?? fallbackIntent(verdict ? "verdict_invalid" : "verdict_missing");
    } catch (error) {
      return fallbackIntent(/** @type {any} */ (error)?.name === "AbortError" ? "timeout" : String(/** @type {any} */ (error)?.code ?? "error"));
    } finally {
      clearTimeout(timeout);
    }
  }
}
