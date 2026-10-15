import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";

/**
 * A message's text without what the platform wrote into it for the model — the one place the browser does what the conversation
 * frame's transcript does (`withoutPlatformBlocks` in `harness-port`), for a page that reads a stored transcript itself (a study's
 * record of one of its AI runs). By the domain's closed list of tags (`PLATFORM_CONTEXT_TAGS`): an `injected` tag is removed with
 * everything it holds, up to its closing tag (nested ones counted) or, when it is never closed, to the end of the text; a
 * `user-wrapper` tag (the reader's own words, wrapped by the platform so a compaction keeps them) loses its tags and keeps the
 * words. Structural, not prose: only a name on the list is ever matched, and a text without one comes back as the same string.
 */
const INJECTED = new Set(PLATFORM_CONTEXT_TAGS.filter((entry) => entry.role === "injected").map((entry) => entry.tag));
const NAMES = PLATFORM_CONTEXT_TAGS.map((entry) => entry.tag);
// Longest first, so `evimed-claim-source` is never read as `evimed-claim`; an opening tag may carry attributes.
const TAG = new RegExp(
  `<(/?)(${[...NAMES].sort((left, right) => right.length - left.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=[\\s>/])[^>]*>`,
  "g",
);

export function withoutPlatformText(text: string): string {
  if (!text.includes("<")) return text;
  TAG.lastIndex = 0;
  let kept = "";
  let from = 0;
  let skipping: { name: string; depth: number } | null = null;
  let matched = false;
  for (let found = TAG.exec(text); found !== null; found = TAG.exec(text)) {
    matched = true;
    const closing = found[1] === "/";
    const name = found[2];
    if (skipping) {
      if (name !== skipping.name) continue;
      skipping.depth += closing ? -1 : (found[0].endsWith("/>") ? 0 : 1);
      if (skipping.depth === 0) { skipping = null; from = TAG.lastIndex; }
      continue;
    }
    kept += text.slice(from, found.index);
    from = TAG.lastIndex;
    if (INJECTED.has(name) && !closing && !found[0].endsWith("/>")) skipping = { name, depth: 1 };
  }
  if (!matched) return text;
  // A block never closed is taken to the end of its text.
  if (!skipping) kept += text.slice(from);
  return kept.trim();
}
