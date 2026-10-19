import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { sourceCitationProse } from "@evimed/domain";
import { getWebConversationHistory, webErrorMessage, type PreservedConversationHistory } from "@/lib/apiClient";
import type { ProgrammeRun } from "@/lib/programmeRuns";
import { withoutPlatformText } from "@/lib/platformText";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { cn } from "@/lib/cn";

export const PROGRAMME_RUN_STATE_LABELS: Readonly<Record<ProgrammeRun["state"], string>> = { running: "进行中", finished: "已完成", stopped: "未完成" };

/** How often the list is read again while a step is under way. */
const WATCH_MS = 10_000;

type Load = { kind: "loading" } | { kind: "ready"; runs: ProgrammeRun[] } | { kind: "error"; message: string };

/** A row's meta line: the state word and the time. */
const metaOf = (run: ProgrammeRun) => [PROGRAMME_RUN_STATE_LABELS[run.state], run.at].filter(Boolean).join(" · ");

/**
 * 「AI 运行」: what a module's programme did for the person in the background (the evidence, the analysis, a batch of articles, a weekly
 * report). It is **a record** — each row opens what that run said and wrote, read where the reader is, and there is no session to be sent
 * to and no composer in it: the module's own conversation is the one that is the person's (R19, audit B §2.1 for 虚拟临床研究, the same
 * shape in 循证 GEO: a step used to carry the reader into the run's conversation, which they could neither leave nor take part in).
 *
 * The two modules are consumers of this one drawer: each hands it the way to read its runs and the control-plane project the runs
 * are in (a run's transcript is read from there), and a `version` that changes when its page has read something new — a run began or
 * ended — so the list is read again in place.
 */
export function ProgrammeRunsDrawer({ projectId, load, version = null, onClose }: {
  projectId: string;
  load: () => Promise<ProgrammeRun[]>;
  version?: string | number | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [round, setRound] = useState(0);
  const [record, setRecord] = useState<ProgrammeRun | null>(null);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => loader.current())
      .then(
        (runs) => { if (live) setState({ kind: "ready", runs }); },
        // A list that was read once is kept when a later read fails: a poll is not a reason to take the record away.
        (error: unknown) => { if (live) setState((current) => (current.kind === "ready" ? current : { kind: "error", message: webErrorMessage(error, { fallback: "暂时无法读取，请稍后重试。" }) })); },
      );
    return () => { live = false; };
  }, [round, version]);
  const reload = useCallback(() => { setState({ kind: "loading" }); setRound((value) => value + 1); }, []);
  // The list reads itself while a step is going on: a run that ends is on it as ended, without anyone asking.
  const going = state.kind === "ready" && state.runs.some((run) => run.state === "running");
  useEffect(() => {
    if (!going) return undefined;
    const timer = window.setInterval(() => setRound((value) => value + 1), WATCH_MS);
    return () => window.clearInterval(timer);
  }, [going]);

  return (
    <Drawer title={record ? record.label : "AI 运行"} onClose={onClose} widthClassName="max-w-md">
      {record ? (
        <ProgrammeRunRecord run={record} projectId={projectId} onBack={() => setRecord(null)} />
      ) : (
        <div data-programme-runs="">
          {state.kind === "loading" ? <RunsSkeleton />
            : state.kind === "error" ? <LoadError message={state.message} onRetry={reload} />
              : state.runs.length === 0 ? <p className="py-6 text-ui text-text-3">AI 还没有在后台做过什么。</p>
                : (
                  <List label="AI 运行" divided>
                    {state.runs.map((run) => (
                      <ListRow key={run.sessionId} title={run.label} onOpen={() => setRecord(run)} meta={metaOf(run)} />
                    ))}
                  </List>
                )}
        </div>
      )}
    </Drawer>
  );
}

function RunsSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true" data-programme-runs-loading="">
      {["w-2/3", "w-1/2", "w-3/5"].map((width) => (
        <div key={width} className="flex h-9 items-center px-2"><div className={cn("h-3.5 rounded bg-surface-2", width)} /></div>
      ))}
    </div>
  );
}

/**
 * A link in what a run wrote: an address on the web opens in a tab of its own, so the reader keeps their place; a path inside the run's
 * workspace (「[claims.json](deliverables/…)」) is its name. The record is read where the reader is, and such a path is no page of this app
 * — pressed, it took the reader to a page that does not exist.
 */
const recordLink = (href: string | undefined, children: ReactNode): ReactNode => (/^https?:\/\//i.test(href ?? "")
  ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2">{children}</a>
  : <span>{children}</span>);

/** What one run said and wrote, as the platform kept it: read-only, with no way into the conversation it was made in. */
function ProgrammeRunRecord({ run, projectId, onBack }: { run: ProgrammeRun; projectId: string; onBack: () => void }) {
  const [history, setHistory] = useState<PreservedConversationHistory | "error" | null>(null);
  useEffect(() => {
    let live = true;
    setHistory(null);
    void getWebConversationHistory(run.sessionId, projectId).then(
      (value) => { if (live) setHistory(value); },
      () => { if (live) setHistory("error"); },
    );
    return () => { live = false; };
  }, [run.sessionId, projectId]);
  return (
    <div data-programme-run-record="" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Button variant="text" size="sm" onClick={onBack} className="pl-0"><ChevronLeft size={16} aria-hidden="true" />全部运行</Button>
        <span className="text-caption tabular-nums text-text-3">{metaOf(run)}</span>
      </div>
      {history === null ? <RunsSkeleton />
        : history === "error" ? <p className="py-6 text-ui text-text-3">这次运行的记录暂时读不到。</p>
          : history.messages.length === 0 ? <p className="py-6 text-ui text-text-3">这次运行还没有留下文字记录。</p>
            : history.messages.map((message) => ({ ...message, text: withoutPlatformText(message.text) })).filter((message) => message.text).map((message) => (
              <article key={message.seq} aria-label={message.role === "user" ? "要求" : "结果"}>
                {message.role === "user"
                  ? <p className="whitespace-pre-wrap text-ui font-semibold text-text">{message.text}</p>
                  : <MarkdownViewer renderLink={recordLink}>{sourceCitationProse(message.text)}</MarkdownViewer>}
              </article>
            ))}
    </div>
  );
}
