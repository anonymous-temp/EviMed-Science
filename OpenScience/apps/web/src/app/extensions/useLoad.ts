import { useCallback, useEffect, useRef, useState } from "react";
import { productErrorMessage } from "@/lib/productClient";

/** One read's four states: loading, a sentence when it failed, or the data. */
export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/**
 * One read for a page or a drawer, with the guard every hand-rolled copy of it
 * needed: an answer that arrives after a newer read began, or after the reader
 * left, is dropped instead of landing on top of what is on screen.
 *
 * `load` must be stable (a `useCallback` with its own dependencies): a new
 * function is a new read, which is how a project switch re-reads everything.
 * `replace` puts a changed copy in place without another read, for an action
 * whose answer already is the new state.
 */
export function useLoad<T>(load: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const generation = useRef(0);
  const run = useCallback((quiet = false) => {
    const mine = ++generation.current;
    if (!quiet) setState({ status: "loading" });
    load().then(
      (data) => { if (mine === generation.current) setState({ status: "ready", data }); },
      (error: unknown) => { if (mine === generation.current) setState({ status: "error", message: productErrorMessage(error) }); },
    );
  }, [load]);
  useEffect(() => {
    run();
    return () => { generation.current += 1; };
  }, [run]);
  const replace = useCallback((data: T) => { generation.current += 1; setState({ status: "ready", data }); }, []);
  return { state, reload: run, replace };
}
