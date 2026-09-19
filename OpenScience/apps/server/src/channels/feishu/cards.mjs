/**
 * The cards the Feishu channel sends: one progress card per task, updated in
 * place; the answer; an inbox notice.
 *
 * Hidden knowledge: Feishu card markdown is not plain markdown. It renders
 * `<at id=all></at>` as a mention of everyone, `<font>` and `<a>` as markup — and the
 * answer text is model output. An answer that happened to contain the tag
 * would page a whole group chat. So every piece of text that did not come from
 * this file has `<` and `>` replaced by the numeric entities Feishu's own
 * escape table names (`&#60;`, `&#62;`) before it reaches a card: a tag can no
 * longer form, "p<0.05" still reads as written, and markdown links, bold and
 * lists still render, which is all an answer uses.
 *
 * Sizes: Feishu refuses a card over ~30 KB of JSON (230099), and a CJK
 * character is three bytes, so one text element carries at most 6,000
 * characters and an answer longer than three of those points to the page.
 *
 * @module channels/feishu/cards
 */

/** Element ids the progress card is updated through. */
export const PROGRESS_ELEMENT = "progress";
export const STATUS_ELEMENT = "status";

/** Longest text one card element carries. */
export const CARD_TEXT_LIMIT = 6_000;
/** Most answer cards one task sends before pointing at the page. */
export const MAX_ANSWER_CARDS = 3;

/** @param {unknown} text */
export function escapeCardText(text) {
  return String(text ?? "").replaceAll("<", "&#60;").replaceAll(">", "&#62;");
}

/** @param {string} content */
function plain(content) {
  return { tag: "plain_text", content };
}

/** @param {unknown} value @param {number} max */
function preview(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** @param {string | null | undefined} link @param {string} [label] */
function linkButton(link, label = "在网页中查看") {
  if (!link) return [];
  return [{
    tag: "button",
    text: plain(label),
    type: "primary",
    width: "default",
    behaviors: [{ type: "open_url", default_url: link }],
  }];
}

/**
 * The card a task starts with. Streaming mode lets the progress element
 * extend itself with Feishu's own typewriter effect; the card entity stays
 * updatable for 14 days, long after streaming mode closes on its own.
 * @param {{ question: string, status: string, progress?: string, link?: string | null }} input
 */
export function progressCard({ question, status, progress = "", link = null }) {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "EviMed 正在处理你的问题" },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 2 },
        print_strategy: "fast",
      },
    },
    header: {
      title: plain(preview(question, 60) || "EviMed 研究任务"),
      subtitle: plain("EviMed 研究助手"),
      template: "blue",
    },
    body: {
      elements: [
        { tag: "markdown", element_id: STATUS_ELEMENT, content: escapeCardText(status) },
        { tag: "markdown", element_id: PROGRESS_ELEMENT, content: escapeCardText(progress) || " " },
        ...linkButton(link),
      ],
    },
  };
}

const OUTCOME_TEMPLATES = Object.freeze({
  delivered: "green",
  qualified: "orange",
  failed: "red",
  stopped: "grey",
});

/**
 * The same card once the task has ended: streaming off, colour by outcome.
 * @param {{ question: string, outcome: 'delivered' | 'qualified' | 'failed' | 'stopped', status: string,
 *   lines?: string[], link?: string | null }} input
 */
export function finishedCard({ question, outcome, status, lines = [], link = null }) {
  return {
    schema: "2.0",
    config: { streaming_mode: false, summary: { content: preview(status, 40) } },
    header: {
      title: plain(preview(question, 60) || "EviMed 研究任务"),
      subtitle: plain("EviMed 研究助手"),
      template: OUTCOME_TEMPLATES[outcome] ?? "blue",
    },
    body: {
      elements: [
        { tag: "markdown", element_id: STATUS_ELEMENT, content: escapeCardText(status) },
        { tag: "markdown", element_id: PROGRESS_ELEMENT, content: lines.map(escapeCardText).join("\n") || " " },
        ...linkButton(link),
      ],
    },
  };
}

/**
 * The answer, as up to `MAX_ANSWER_CARDS` cards. Split on paragraph
 * boundaries where one falls in the last third of a chunk, so a list is not
 * cut mid-item when it can be helped.
 * @param {{ text: string, link?: string | null }} input
 * @returns {Record<string, any>[]}
 */
export function answerCards({ text, link = null }) {
  const chunks = [];
  let rest = String(text ?? "").trim();
  while (rest && chunks.length < MAX_ANSWER_CARDS) {
    if (rest.length <= CARD_TEXT_LIMIT) { chunks.push(rest); rest = ""; break; }
    const head = rest.slice(0, CARD_TEXT_LIMIT);
    const cut = head.lastIndexOf("\n\n");
    const end = cut > CARD_TEXT_LIMIT * 0.66 ? cut : CARD_TEXT_LIMIT;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).replace(/^\n+/, "");
  }
  if (chunks.length === 0) return [];
  if (rest) chunks[chunks.length - 1] += "\n\n……（回答较长，完整内容请在网页中查看）";
  return chunks.map((chunk, index) => ({
    schema: "2.0",
    config: { summary: { content: preview(chunk.replace(/[#*`_]/g, " "), 40) } },
    body: {
      elements: [
        { tag: "markdown", content: escapeCardText(chunk) },
        ...(index === chunks.length - 1 ? linkButton(link) : []),
      ],
    },
  }));
}

const SEVERITY_TEMPLATES = Object.freeze({ safety: "red", attention: "orange", info: "blue" });

/**
 * An inbox item, pushed.
 * @param {{ title: string, body: string, link?: string | null, linkLabel?: string | null, severity?: string }} input
 */
export function noticeCard({ title, body, link = null, linkLabel = null, severity = "info" }) {
  return {
    schema: "2.0",
    config: { summary: { content: preview(title, 40) } },
    header: {
      title: plain(preview(title, 80) || "EviMed 通知"),
      template: SEVERITY_TEMPLATES[/** @type {keyof typeof SEVERITY_TEMPLATES} */ (severity)] ?? "blue",
    },
    body: {
      elements: [
        { tag: "markdown", content: escapeCardText(String(body ?? "").trim().slice(0, CARD_TEXT_LIMIT)) || " " },
        ...linkButton(link, linkLabel ?? "在网页中查看"),
      ],
    },
  };
}
