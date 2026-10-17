/**
 * Where a 虚拟临床研究 study lives, and the one address that is a view of it rather than a tab: its conversation.
 *
 * `/app/virtual-research/:studyId/chat` is a pure front-end view of the study page (R19, plan §5.3: one study is one conversation,
 * and the conversation is a view of the same page, not another place). It is **not** one of the domain's `VCR_TABS` — the server
 * has no `GET …/chat` and must never be asked for one — so it is recognised here, before an address is read as a tab.
 *
 * It lives in `lib/` because the shell's frame host decides from the address alone whether the kernel's conversation is placed over
 * a pane (`isPanePath`), and the shell may not import from a module's components.
 */

/** The module's home. */
export const VCR_HOME_PATH = "/app/virtual-research";

/** A study id the shell is willing to put in an address. */
const ADDRESSABLE_STUDY = /^[A-Za-z0-9_-]{1,160}$/;

/** The study's conversation view. */
export function vcrChatPath(studyId: string): string {
  return `${VCR_HOME_PATH}/${encodeURIComponent(studyId)}/chat`;
}

/** Whether an address is a study's conversation view: exactly `/app/virtual-research/:studyId/chat`. */
export function isStudyChatPath(pathname: string): boolean {
  return /^\/app\/virtual-research\/[^/]+\/chat\/?$/.test(pathname);
}

/** The study whose conversation view an address is, or null for any other address. */
export function studyIdFromChatPath(pathname: string): string | null {
  const match = /^\/app\/virtual-research\/([^/]+)\/chat\/?$/.exec(pathname);
  if (!match) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(match[1]); } catch { return null; }
  return ADDRESSABLE_STUDY.test(decoded) ? decoded : null;
}
