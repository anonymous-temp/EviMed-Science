import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

/**
 * A list page keeps its place in its address (design reference §20.3 A08): the
 * tab, the filter, the search, the open item and how many pages were loaded are
 * search parameters, so a reload, a shared link, and Back from wherever a row
 * took the reader all find the page as it was. The frontier pages have done
 * this for their feed; these two hooks are the parts the inbox and the memory
 * page share with it.
 *
 * Which writes make a history entry follows the frontier pages: choosing a
 * *view* (a tab) pushes, so Back steps back through the views; narrowing a
 * view (a filter, a search) replaces, so Back does not walk through every
 * keystroke; an item that opens in a drawer pushes, so Back closes it.
 */

/** Set one parameter on a copy of `current`; an empty value removes it. */
export function withParam(current: URLSearchParams, name: string, value: string | null | undefined): URLSearchParams {
  const updated = new URLSearchParams(current);
  if (value === null || value === undefined || value === "") updated.delete(name);
  else updated.set(name, value);
  return updated;
}

/**
 * A text field mirrored into one search parameter.
 *
 * `draft` is what the box shows and what the page filters by, so typing is
 * never a render behind; the address follows 300 ms after the last keystroke
 * and never in the middle of an IME composition (the caller spreads
 * `composition` on the box, which is the only way the hook learns that one
 * ended). A Back or forward that changes the parameter puts the new text in
 * the box.
 */
export function useAddressText(name = "q", limit = 200, delay = 300) {
  const [params, setParams] = useSearchParams();
  const committed = params.get(name) ?? "";
  const [draft, setDraft] = useState(committed);
  const composing = useRef(false);
  const [composed, setComposed] = useState(0);

  useEffect(() => {
    // The address won against the box only when it differs from what the box holds once trimmed: a trailing space typed
    // while the address caught up is the reader's, not stale.
    setDraft((current) => (current.trim().slice(0, limit) === committed ? current : committed));
  }, [committed, limit]);

  useEffect(() => {
    const text = draft.trim().slice(0, limit);
    if (composing.current || text === committed) return;
    const timer = setTimeout(() => setParams((current) => withParam(current, name, text), { replace: true }), delay);
    return () => clearTimeout(timer);
  }, [draft, composed, committed, name, limit, delay, setParams]);

  const clear = useCallback(() => {
    setDraft("");
    setParams((current) => withParam(current, name, null), { replace: true });
  }, [name, setParams]);

  const composition = {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; setComposed((value) => value + 1); },
  };
  return { draft, setDraft, committed, clear, composition };
}

/** Marks a history entry that opening an item pushed, so closing it can pop that entry instead of stacking another. */
const PUSHED = "addressOpenedBy";

/**
 * The item open in a drawer, as one search parameter.
 *
 * Opening pushes an entry, so Back closes the drawer; closing pops it when this
 * page pushed it, and otherwise (a link or a reload landed on an open item)
 * replaces it with the list alone. Opening a second item while one is open
 * replaces, so Back still leaves for the list.
 */
export function useAddressOpen(name = "open") {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const value = params.get(name);
  const pushed = (location.state as Record<string, unknown> | null)?.[PUSHED] === name;

  const open = useCallback((key: string) => {
    const next = withParam(params, name, key);
    const search = next.toString();
    if (value !== null) navigate({ search: search ? `?${search}` : "" }, { replace: true, state: location.state });
    else navigate({ search: search ? `?${search}` : "" }, { state: { [PUSHED]: name } });
  }, [location.state, name, navigate, params, value]);

  const close = useCallback(() => {
    if (pushed) navigate(-1);
    else setParams((current) => withParam(current, name, null), { replace: true });
  }, [name, navigate, pushed, setParams]);

  return { value, open, close };
}
