import { useCallback, useEffect, useState } from "react";
import {
  addFrontierFollow,
  fetchFrontierTag,
  frontierErrorMessage,
  FRONTIER_FOLLOWS_CHANGED,
  listFrontierFollows,
  listFrontierTags,
  type FrontierTagCount,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";

/**
 * The tag tree as the feed page reads it (2026-10-23): a chosen tag's name and whether the reader follows it, the 「专科」 panel's
 * 热门标签 and the search box's suggestions. Each read is a hint the page does without: a failure leaves the slug, no 「关注」, no
 * popular tags or no suggestions, and the feed itself is unaffected.
 */

/** Names already seen this visit, by slug — a card's tag, a suggestion, a popular tag — so a chosen tag's chip reads at once. */
const KNOWN = new Map<string, string>();

export function rememberTagName(slug: string, name: string): void {
  if (slug && name) KNOWN.set(slug, name);
}

/**
 * The chosen tag's name: known from where it was chosen, or read (`GET /api/frontier/tags/:slug`). A slug merged into another is
 * answered with the other, and `onMerged` hands the page the slug to put in its address instead.
 */
export function useTagName(slug: string, onMerged: (slug: string) => void): string {
  const [name, setName] = useState(() => KNOWN.get(slug) ?? "");
  useEffect(() => {
    setName(KNOWN.get(slug) ?? "");
    if (!slug || KNOWN.has(slug)) return undefined;
    let active = true;
    fetchFrontierTag(slug).then((tag) => {
      if (!active || !tag) return;
      rememberTagName(tag.slug, tag.name);
      if (tag.slug !== slug) onMerged(tag.slug);
      else setName(tag.name);
    }, () => { /* the slug stands for its name */ });
    return () => { active = false; };
  }, [slug, onMerged]);
  return name || slug;
}

/** Whether the reader follows a tag (null while not known), and 「关注」 it. */
export function useTagFollow(slug: string, name: string): { followed: boolean | null; following: boolean; follow: () => void } {
  const [followed, setFollowed] = useState<boolean | null>(null);
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    setFollowed(null);
    if (!slug) return undefined;
    let active = true;
    const read = () => {
      listFrontierFollows().then(
        (follows) => { if (active) setFollowed(follows.some((entry) => entry.kind === "tag" && entry.key === slug && !entry.muted)); },
        () => { if (active) setFollowed(null); },
      );
    };
    read();
    window.addEventListener(FRONTIER_FOLLOWS_CHANGED, read);
    return () => { active = false; window.removeEventListener(FRONTIER_FOLLOWS_CHANGED, read); };
  }, [slug]);
  const follow = useCallback(() => {
    if (!slug || following) return;
    setFollowing(true);
    addFrontierFollow({ kind: "tag", key: slug, label: name || slug }).then(
      () => { setFollowed(true); toast.success("已关注"); },
      (error: unknown) => toast.error(frontierErrorMessage(error)),
    ).finally(() => setFollowing(false));
  }, [slug, name, following]);
  return { followed, following, follow };
}

/** The chosen specialties' tags most used in 30 days (the 「专科」 panel's 热门标签): read while any is chosen. */
export function useHotTags(specialties: readonly string[]): { loading: boolean; tags: FrontierTagCount[] } {
  const key = specialties.join(",");
  const [state, setState] = useState<{ key: string; tags: FrontierTagCount[] } | null>(null);
  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    listFrontierTags({ specialties: key.split(","), limit: 24 }).then(
      (tags) => {
        if (!active) return;
        tags.forEach((tag) => rememberTagName(tag.slug, tag.name));
        setState({ key, tags });
      },
      () => { if (active) setState({ key, tags: [] }); },
    );
    return () => { active = false; };
  }, [key]);
  if (!key) return { loading: false, tags: [] };
  return state?.key === key ? { loading: false, tags: state.tags } : { loading: true, tags: [] };
}

/** At most eight tags whose name holds what is typed (the search box's suggestions), read a moment after the typing stops. */
export function useTagSuggestions(text: string, enabled: boolean): FrontierTagCount[] {
  const words = enabled ? text.trim() : "";
  const [found, setFound] = useState<{ words: string; tags: FrontierTagCount[] }>({ words: "", tags: [] });
  useEffect(() => {
    if (!words) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      listFrontierTags({ q: words, limit: 8 }).then(
        (tags) => {
          if (!active) return;
          tags.forEach((tag) => rememberTagName(tag.slug, tag.name));
          setFound({ words, tags: tags.slice(0, 8) });
        },
        () => { if (active) setFound({ words, tags: [] }); },
      );
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [words]);
  return words && found.words === words ? found.tags : [];
}

/** Which kinds of follow `useFollowSet` answers for: the ones a reader makes from the band (a specialty in 「筛选」, a search's words). */
export type BandFollowKind = "specialty" | "topic";

/**
 * Whether the reader follows a specialty or a topic (null while that is not known), and 「关注」 it — for the 「筛选」 panel's chosen
 * specialties and a search's 「关注“<词>”」. One read of the follows, again whenever a follow changes anywhere; a failure leaves every
 * answer unknown, and no 「关注」 is offered rather than a wrong one.
 */
export function useFollowSet(enabled: boolean): {
  followed: (kind: BandFollowKind, key: string) => boolean | null;
  pending: (kind: BandFollowKind, key: string) => boolean;
  follow: (kind: BandFollowKind, key: string, label: string) => void;
} {
  const [held, setHeld] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const read = () => {
      listFrontierFollows().then(
        (follows) => { if (active) setHeld(new Set(follows.filter((entry) => !entry.muted).map((entry) => `${entry.kind}:${entry.key.toLowerCase()}`))); },
        () => { if (active) setHeld(null); },
      );
    };
    read();
    window.addEventListener(FRONTIER_FOLLOWS_CHANGED, read);
    return () => { active = false; window.removeEventListener(FRONTIER_FOLLOWS_CHANGED, read); };
  }, [enabled]);
  const id = (kind: BandFollowKind, key: string) => `${kind}:${key.toLowerCase()}`;
  const followed = useCallback((kind: BandFollowKind, key: string) => (held ? held.has(id(kind, key)) : null), [held]);
  const pending = useCallback((kind: BandFollowKind, key: string) => busy.has(id(kind, key)), [busy]);
  const follow = useCallback((kind: BandFollowKind, key: string, label: string) => {
    const at = id(kind, key);
    if (busy.has(at)) return;
    setBusy((current) => new Set([...current, at]));
    addFrontierFollow({ kind, key, label }).then(
      () => { setHeld((current) => new Set([...(current ?? []), at])); toast.success("已关注"); },
      (error: unknown) => toast.error(frontierErrorMessage(error)),
    ).finally(() => setBusy((current) => { const next = new Set(current); next.delete(at); return next; }));
  }, [busy]);
  return { followed, pending, follow };
}
