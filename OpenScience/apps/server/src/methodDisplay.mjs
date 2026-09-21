/**
 * The line a researcher reads for one learned method, when the method came
 * without one.
 *
 * A method's own name and description are written for the model — kebab-case,
 * English, phrased for routing — and the memory page printed them as they were
 * (「claim-verdict-audit：Re-verifies the statements of…」 to a Chinese reader,
 * 2026-09-21). A distillation now writes `display` itself; this names the
 * methods that predate that, or that arrived without one, with one small model
 * call through the same metered gateway as run titles. Language judgement, so a
 * model makes it (principle 1); what the page keeps is only a title and a
 * sentence cleaned by `cleanMethodDisplay`, never text inside the method.
 *
 * @module methodDisplay
 */

import { cleanMethodDisplay } from "@evimed/domain";

import { callModelForControlPlane } from "./modelGateway.mjs";

const displayInstructions = [
  "你为研究者的一条工作做法写一个标题和一句说明，显示在他的「记忆胶囊」页面上。",
  "做法原文是写给模型看的英文；你要用简体中文告诉研究者：他做研究时会多做或换一种做法做的是什么，以及什么时候用。",
  "标题不超过 16 个字，说明不超过 80 个字；不要出现工具名、文件名、英文代号或连字符写法，不要写「该方法」「本做法」之类的套话。",
  "只输出 JSON：{\"title\": \"...\", \"summary\": \"...\"}。",
].join("");

/**
 * The model's answer, if it is one: a JSON object with `title` and `summary`
 * in the content, or in the reasoning text when a reasoning model wrote it there.
 * @param {unknown} content @returns {Record<string, unknown> | null}
 */
function displayFrom(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [raw, ...[...raw.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.title === "string") return parsed;
    } catch { /* keep looking */ }
  }
  return null;
}

export class MethodDescriber {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, fetchImpl?: typeof fetch, callModel?: typeof callModelForControlPlane }} [options]
   */
  constructor(config, { usageLedger = null, fetchImpl = globalThis.fetch, callModel = callModelForControlPlane } = {}) {
    this.config = config;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.callModel = callModel;
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config?.modelGatewayTimeoutMs ?? 30_000)));
  }

  get available() {
    return this.config?.deepseekProviderEnabled === true && Boolean(this.config?.deepseekApiKey);
  }

  /**
   * A title and sentence for one method, or null — never a throw. Why it failed
   * goes to stderr once: a line that silently never arrives looks exactly like
   * a feature that is off.
   * @param {any} document a learned method document
   * @param {{ userId: string, projectId: string | null }} owner
   * @returns {Promise<{title: string, summary: string} | null>}
   */
  async describe(document, { userId, projectId }) {
    if (!this.available) return null;
    const frontmatter = document?.payload?.frontmatter ?? {};
    const source = [
      `name: ${String(frontmatter.name ?? "")}`,
      `description: ${String(frontmatter.description ?? "")}`,
      `whenToUse: ${String(frontmatter.whenToUse ?? "")}`,
      String(document?.payload?.body ?? "").slice(0, 3_000),
    ].join("\n");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await this.callModel(
        { config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl },
        {
          userId,
          projectId,
          purpose: "learning",
          signal: controller.signal,
          body: {
            model: this.config.deepseekModel,
            temperature: 0,
            // The same measurement as run titles: a line needs no reasoning.
            thinking: { type: "disabled" },
            max_tokens: 2_000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: displayInstructions },
              { role: "user", content: source },
            ],
          },
        },
      );
      const message = body?.choices?.[0]?.message;
      const display = cleanMethodDisplay(displayFrom(message?.content) ?? displayFrom(message?.reasoning_content));
      if (!display) process.stderr.write(`method display produced no usable line for ${String(document?.id ?? "")}\n`);
      return display;
    } catch (error) {
      process.stderr.write(`method display failed for ${String(document?.id ?? "")}: ${error?.name === "AbortError" ? "timeout" : error?.code ?? "error"}\n`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
