/**
 * A crawled post's reading text (rd-server, 2026-10-31).
 *
 * The owner, on a Xiaohongshu result whose 导读 had nothing to say: 「抓不到正文啊，这 ai 导读的都没法看呀，这种情况肯定不止这一个，应该是代表着
 * 一类问题」. The class: a post of the six crawl platforms (`FRONTIER_CRAWL_PLATFORMS`) reaches the reader as one string, `title content`, cut at
 * 300 characters, with the platform's own markers in it (`#抑郁症[话题]#`, `[笑哭R]`, zero-width characters, tab-only lines), the title said
 * twice where the platform's title is its content (`title title`: 35 of 73 channels posts, 14 of 25 bilibili) and, often, nothing but
 * hashtags after the title. A reader sees a title and a repeat of it; the 导读 describes the post instead of its content.
 *
 * This module is the one reading of such a text, a pure function of the text and the title, so that the item detail's `body`, what the
 * model is shown and the decision that a post has nothing of its own say the same thing about the same post, for rows stored before the
 * plugin kept the whole post (`body_excerpt`: `title content`, the layout `titled`) and for rows after it (`body_text`: the post's own
 * text, the title not repeated, the layout `own`). Format only: a marker is removed by its closed form, a copy of the title by comparing
 * it with the title, a tag by its `#`; nothing here reads what the words say (principle 5), and what a post says beyond its title and
 * tags is a count of characters, never a judgement of them.
 *
 * - **Words and tags.** The tags a post ends with are its topic marks, not its words; the tags inside a sentence stay where they are.
 *   `words` is the text without the title copy at its head and without the trailing tags, `tags` the trailing run.
 * - **What a post says of its own** (`own`): the letters and digits of the words that are not the title again, not a tag, not a link and
 *   not an `@` mention, a Han character one and any other character three-tenths — the unit `frontierLeadLimit` counts in.
 *   `FRONTIER_POST_LIMITS.own` is the least a post must say to be shown as text: measured on the 90 real items of
 *   `rd/lead-samples.jsonl` (see the constant).
 *
 * @module frontierPostText
 */

import { FRONTIER_CRAWL_PLATFORMS, FRONTIER_MEDIA_ID } from "@evimed/domain";

/**
 * The limits of a post's text, each with its reason.
 *
 * - `own` — the least a post must say beyond its title and tags to count as text, in `frontierLeadLimit`'s units (a Han character is
 *   one). Measured on the 45 social posts of the 90 real items of 2026-10-31 (`rd/lead-samples.jsonl`): the posts with nothing of their own
 *   (the title twice, the title and its hashtags, a cut title repeated) count 0 to 0.9 (the tail of the cut), the thinnest post that says
 *   anything counts 38 (a Zhihu answer of one sentence under its question) and the next 44; 12 is about one short clause, so a stray word
 *   or two after a title is not a text and a clause is. A post under it has no text of its own.
 * - `picture` — the least the pictures of a thin post must read as for the post to be shown: the same unit, the same measure of a clause.
 * - `maxPictures` — how many pictures of one post are read: a picture post is up to nine pictures (Xiaohongshu), and the first ones carry the
 *   post's point; the rest would cost a parse each for a caption.
 * - `postsPerRound` — how many posts have their pictures read in a round: each is up to `maxPictures` parses of the in-house API, which
 *   charges per page.
 * - `pictureChars` — the most text kept of one post's pictures: a poster of text, never a document.
 * @type {Readonly<{ own: number, picture: number, maxPictures: number, postsPerRound: number, pictureChars: number }>}
 */
export const FRONTIER_POST_LIMITS = Object.freeze({ own: 12, picture: 12, maxPictures: 4, postsPerRound: 4, pictureChars: 4_000 });

const CRAWL = new Set(FRONTIER_CRAWL_PLATFORMS);

/** Whether a platform id is one of the six the crawler reads. @param {unknown} platform */
export function frontierCrawlPost(platform) {
  return typeof platform === "string" && CRAWL.has(platform);
}

// Zero-width and object-replacement characters the platforms leave in a text: U+200B..U+200F, U+2060, U+FEFF, U+FFFC, the soft hyphen.
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\ufffc\u00ad]/gu;
// Xiaohongshu writes a topic as `#词[话题]#`; the marker is the platform's, the tag is `#词`.
const TOPIC_MARK = /\[话题\]#?/gu;
// Xiaohongshu's emoticons are `[笑哭R]`, `[赞R]`; Weibo's, `[思考]`, `[话筒]`; a picture's place, `[图片]`: one to four Han characters, or a few ending in R.
const EMOTICON = /\[(?:[一-鿿]{1,4}|[一-鿿A-Za-z]{1,6}R)\]/gu;
// A tag: `#词`, or Weibo's `#词#`; the word runs to a space or the next `#`.
const TAG = /#[^\s#]{1,60}#?/gu;
const TRAILING_TAGS = /(?:^|[^\p{L}\p{N}#])(#[^\s#]{1,60}#?)\s*$/u;
const LINK = /https?:\/\/\S+|\bt\.cn\/\S+/giu;
const MENTION = /@[^\s@，。！？、：；,.!?:;）)】]{1,40}/gu;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * A text without the platforms' markers, its lines trimmed and its blank lines (and the lines that hold only tabs or spaces) collapsed to
 * one, paragraph breaks kept. @param {unknown} value
 */
export function frontierPostClean(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").replace(INVISIBLE, "").replace(TOPIC_MARK, "").replace(EMOTICON, "")
    .split("\n").map((line) => line.replace(/[ \t\f\v\u00a0\u3000]+/g, " ").replace(/ ([】）」』])/gu, "$1").replace(/([【（「『]) /gu, "$1").trim());
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    if (line || (out.length && out[out.length - 1])) out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

/** One line of a text, for comparing a title with it: cleaned, whitespace folded, a trailing ellipsis (a cut title) dropped. @param {unknown} value */
function flat(value) {
  return frontierPostClean(value).replace(/\s+/g, " ").replace(/\s*(?:…|\.{3})$/u, "").trim();
}

/**
 * The text after the copies of `title` it begins with (at most `max`), whitespace folded for the comparison and mapped back to the
 * original string. @param {string} text @param {string} title @param {number} [max] @returns {{ rest: string, copies: number }}
 */
function afterTitle(text, title, max = Infinity) {
  if (!title) return { rest: text, copies: 0 };
  let rest = text;
  let copies = 0;
  while (copies < max) {
    const head = rest.replace(/^\s+/u, "");
    // Compare on a whitespace-folded head of the same length, so a title wrapped over two lines still matches.
    const folded = head.replace(/\s+/g, " ");
    if (!folded.startsWith(title)) break;
    // Map the folded length back: walk the head until `title.length` folded characters are consumed.
    let consumed = 0;
    let index = 0;
    let previousSpace = false;
    while (index < head.length && consumed < title.length) {
      const space = /\s/u.test(head[index]);
      if (!(space && previousSpace)) consumed += 1;
      previousSpace = space;
      index += 1;
    }
    rest = head.slice(index);
    copies += 1;
    if (!rest.trim()) break;
  }
  return { rest: rest.replace(/^\s+/u, ""), copies };
}

/**
 * The characters a text says, in `frontierLeadLimit`'s unit: letters and digits only (punctuation, symbols and emoji say nothing), a Han
 * character one and any other three-tenths. @param {string} text
 */
export function frontierPostWeight(text) {
  let han = 0;
  let other = 0;
  for (const char of text) {
    if (!/[\p{L}\p{N}]/u.test(char)) continue;
    if (HAN.test(char)) han += 1;
    else other += 1;
  }
  return han + 0.3 * other;
}

/** The trailing tags of a text and the text without them. @param {string} text @returns {{ words: string, tags: string[] }} */
function splitTrailingTags(text) {
  let words = text.trimEnd();
  /** @type {string[]} */
  const tags = [];
  for (let match = TRAILING_TAGS.exec(words); match; match = TRAILING_TAGS.exec(words)) {
    tags.unshift(match[1]);
    words = words.slice(0, words.length - match[0].length).trimEnd();
  }
  return { words, tags };
}

/**
 * A post's reading text.
 *
 * `layout` says how the stored text was made: `titled` — the plugin's first layout, `title content` (the title is joined to the front,
 * and a post whose content is the title says it twice) — or `own`, the post's own text as the platform's author wrote it. The title's
 * leading copy is removed in `titled` always, and in either layout a copy that is the whole text is no text.
 * @param {{ title?: unknown, text?: unknown, layout?: "titled" | "own" }} input
 * @returns {{ text: string, words: string, tags: string[], own: number }}
 *   `text` — the cleaned post, words and tags, the layout's title copy gone; `words` — without its trailing tags (what the reader's body shows);
 *   `own` — what the post says beyond its title and tags, in `frontierPostWeight`'s unit.
 */
export function frontierPostText({ title = "", text = "", layout = "titled" }) {
  const head = flat(title);
  const cleaned = frontierPostClean(text);
  const stripped = layout === "titled" ? afterTitle(cleaned, head, 1).rest : cleaned;
  const { words, tags } = splitTrailingTags(stripped);
  // What is left after the title once more (a post that begins with its own title, Weibo's cut first line) is the post's own part;
  // compared before the tags are taken off, because a title can end in tags itself.
  const beyond = splitTrailingTags(afterTitle(stripped, head).rest).words;
  const own = frontierPostWeight(beyond.replace(LINK, " ").replace(TAG, " ").replace(MENTION, " "));
  return { text: stripped, words, tags, own };
}

/**
 * Whether a post's text says something beyond its title and tags (`FRONTIER_POST_LIMITS.own`).
 * @param {ReturnType<typeof frontierPostText>} post
 */
export function frontierPostSaysSomething(post) {
  return post.own >= FRONTIER_POST_LIMITS.own;
}

/**
 * The text of a stored row for the post it holds: the best of the row's own text (`body_text`, layout `own`) and its excerpt
 * (`body_excerpt`, layout `titled`), or the entry's summary for a row not yet stored (`titled` too).
 * @param {{ body_text?: unknown, body_excerpt?: unknown } | null | undefined} texts
 * @param {unknown} title @param {unknown} [fallback] the entry's `summary_raw`, read when the row holds neither
 */
export function frontierPostOf(texts, title, fallback = null) {
  const candidates = /** @type {Array<[unknown, "own" | "titled"]>} */ ([[texts?.body_text, "own"], [texts?.body_excerpt, "titled"], [fallback, "titled"]]);
  for (const [value, layout] of candidates) {
    if (typeof value === "string" && value.trim()) return { ...frontierPostText({ title, text: value, layout }), layout };
  }
  return null;
}

/**
 * What the model reads of a post: its words, its trailing tags on a line of their own, and — when the post said nothing in text and its
 * pictures were read — the words in the pictures under their own label. Never the reader's `body` (`frontierPostBody`).
 * @param {ReturnType<typeof frontierPostOf> | ReturnType<typeof frontierPostText> | null} post @param {unknown} [pictureText]
 */
export function frontierPostMaterial(post, pictureText = null) {
  const pictures = typeof pictureText === "string" ? pictureText.trim() : "";
  return [post?.words ?? "", post?.tags.length ? post.tags.join(" ") : "", pictures ? `图片中的文字：\n${pictures}` : ""].filter((part) => part.trim()).join("\n\n").trim();
}

/**
 * The reader's body of a post: its words, the title copy and the trailing tags gone, or null when the post says nothing of its own
 * (`FRONTIER_POST_LIMITS.own`). @param {ReturnType<typeof frontierPostOf>} post
 */
export function frontierPostBody(post) {
  return post && frontierPostSaysSomething(post) ? post.words.trim() || null : null;
}

/**
 * Whether a crawl post can be shown, from what is stored of it, and what it still waits for.
 *
 * `readable` — the post says something of its own, or its pictures were read and held words; `waiting` — it says nothing in text, has
 * stored pictures and they have not been tried (`item_texts.picture_tried_at`): the picture step will decide; otherwise it is nothing
 * a reader could use and, with no pictures to wait for, it is not shown (the owner's 2026-10-22 rule, 「除非是真的全部信息都没有，那么就先不展示出来」).
 * @param {{ title?: unknown, texts?: { body_text?: unknown, body_excerpt?: unknown, picture_text?: unknown, picture_tried_at?: unknown } | null,
 *   summary?: unknown, media?: unknown }} input
 * @returns {{ readable: boolean, waiting: boolean, says: boolean, pictures: "read" | "pending" | "none", own: number }}
 */
export function frontierPostReading({ title = "", texts = null, summary = null, media = [] }) {
  const post = frontierPostOf(texts, title, summary);
  const says = post ? frontierPostSaysSomething(post) : false;
  const pictureRead = frontierPostWeight(String(texts?.picture_text ?? "")) >= FRONTIER_POST_LIMITS.picture;
  const stored = (Array.isArray(media) ? media : []).some((entry) => entry && typeof entry === "object" && FRONTIER_MEDIA_ID.test(String(/** @type {any} */ (entry).id ?? "")));
  const pictures = pictureRead ? "read" : stored && !texts?.picture_tried_at ? "pending" : "none";
  return { readable: says || pictureRead, waiting: !says && pictures === "pending", says, pictures, own: post?.own ?? 0 };
}
