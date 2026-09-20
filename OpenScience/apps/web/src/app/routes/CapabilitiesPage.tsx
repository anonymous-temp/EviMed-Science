import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Clock3, FolderUp, RefreshCw, Search, ServerCrash } from "lucide-react";
import { webErrorMessage, hasWebApi, listWebResearchAgents, type WebResearchAgent } from "@/lib/apiClient";
import { researchAgentUi, type CapabilityUi } from "@/lib/researchAgentUi";
import { capabilityIcon } from "@/lib/capabilityIcons";
import { bindConversationCapability, minutesText } from "@/lib/dispatch";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { AgentsSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";

/**
 * The catalogue of research tools.
 *
 * It used to open a drawer per tool with a second question box and its own
 * 「开始」, which dispatched from here and left the reader on this page behind a
 * receipt banner. A researcher who had already decided what to ask was asked to
 * type it somewhere other than the composer, and the tool they picked was then
 * re-decided by the router's classifier.
 *
 * Now a row opens a new conversation with that tool on. Everything the drawer
 * said — what it does, what you get, how long it takes, what it needs, what it
 * cannot do, three example questions — is on the tool's own page above that
 * conversation's composer, which is the page the reader is going to type into.
 */
export function CapabilitiesPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<WebResearchAgent[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(hasWebApi);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    if (!hasWebApi) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void listWebResearchAgents()
      .then((list) => { if (active) setAgents(list); })
      .catch((cause: unknown) => { if (active) setError(webErrorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloads]);

  const catalogue = useMemo(() => agents.map(researchAgentUi).filter((ui): ui is CapabilityUi => ui !== null), [agents]);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => catalogue.filter((ui) => {
    if (category && ui.category !== category) return false;
    if (!needle) return true;
    return [ui.title, ui.description, ...ui.starterPrompts].some((text) => text.toLowerCase().includes(needle));
  }), [catalogue, category, needle]);
  const categories = useMemo(() => [...new Set(catalogue.map((ui) => ui.category))], [catalogue]);
  const groups = useMemo(() => {
    const byCategory = new Map<string, CapabilityUi[]>();
    for (const ui of visible) byCategory.set(ui.category, [...(byCategory.get(ui.category) ?? []), ui]);
    // By name, so the order does not move with whatever the catalogue happened
    // to return first.
    return [...byCategory.entries()].sort(([left], [right]) => left.localeCompare(right, "zh"));
  }, [visible]);

  /**
   * A tool is chosen by opening a conversation that runs it — bound before the
   * conversation exists, because a binding is what makes the router honour the
   * choice rather than re-decide it with a classifier.
   */
  const [opening, setOpening] = useState<string | null>(null);
  const open = (agent: CapabilityUi) => {
    if (opening) return;
    setOpening(agent.id);
    void bindConversationCapability(null, { agentId: agent.id, agentVersion: agent.version })
      .then((bound) => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(undefined, bound.sessionId), capabilityId: agent.id } }))
      // A binding the control plane refused must not strand the reader on a
      // dead row: the conversation opens, and the router decides as it did
      // before there were tools.
      .catch(() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } }))
      .finally(() => setOpening(null));
  };

  return (
    <PageShell
      title="科研工具"
      description="选一项工具，直接进入对话开始提问；工具的说明、示例和它做不到的事都在对话上方。"
      width="wide"
    >
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">搜索科研工具</span>
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索工具、产物或示例问题"
              className="h-9 w-full rounded-input border border-border bg-surface pl-8 pr-3 text-ui text-text placeholder:text-muted focus:border-strong focus:outline-none"
            />
          </label>
          {categories.length > 1 && (
            <div role="group" aria-label="按分类筛选" className="flex flex-wrap items-center gap-2">
              {[null, ...categories].map((name) => {
                const selected = category === name;
                return (
                  <button
                    key={name ?? "all"}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setCategory(name)}
                    className={cn(
                      "h-8 rounded-full border px-3 text-ui transition-colors duration-fast",
                      selected ? "border-text bg-surface-2 font-medium text-text" : "border-border bg-surface text-muted hover:border-strong hover:text-text",
                    )}
                  >
                    {name ?? "全部"}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-6 space-y-8">
          {loading && <AgentsSkeleton />}
          {/* Error with a way out, not a dead end: a catalogue that failed to
            * load once is usually a control plane that was briefly away. */}
          {!loading && error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-input border border-danger bg-danger-soft px-4 py-3 text-ui text-danger-strong">
              <span className="min-w-0 flex-1 break-words">无法加载工具目录：{error}</span>
              <Button size="sm" variant="ghost" onClick={() => setReloads((value) => value + 1)}>
                <RefreshCw size={12} aria-hidden /> 重试
              </Button>
            </div>
          )}
          {!loading && !error && !hasWebApi && (
            <EmptyState
              icon={ServerCrash}
              title="科研工具仅在 EviMed 在线工作空间中可用"
              description="请在 EviMed 在线工作空间中使用此功能。"
            />
          )}
          {!loading && !error && hasWebApi && visible.length === 0 && (
            <EmptyState
              icon={Search}
              title="没有符合条件的科研工具"
              description={needle ? `没有工具的名称、说明或示例里有「${query.trim()}」。` : undefined}
            />
          )}
          {!loading && !error && groups.map(([name, items]) => (
            <section key={name} aria-labelledby={`capability-group-${name}`}>
              <h2 id={`capability-group-${name}`} className="mb-3 flex items-baseline gap-2 text-ui font-semibold text-text">
                {name}<span className="text-caption font-normal text-muted">{items.length} 项</span>
              </h2>
              <ul className="grid gap-2 xl:grid-cols-2">
                {items.map((agent) => (
                  <li key={agent.id}><CapabilityRow agent={agent} busy={opening === agent.id} onOpen={() => open(agent)} /></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
    </PageShell>
  );
}

/** One compact row: icon, name, one line, how long. */
function CapabilityRow({ agent, busy, onOpen }: { agent: CapabilityUi; busy: boolean; onOpen: () => void }) {
  const Icon = capabilityIcon(agent.id);
  const minutes = minutesText({ min: agent.estimatedMinutes[0], max: agent.estimatedMinutes[1] });
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      aria-label={`用「${agent.title}」开始一次对话`}
      className="group flex min-h-[4.75rem] w-full items-start gap-3 rounded-card border border-border bg-surface p-4 text-left transition-colors duration-fast hover:border-strong hover:bg-surface-2"
    >
      <Icon size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-text">{agent.title}</span>
        <span className="mt-0.5 block truncate text-ui text-muted">{agent.description}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 text-caption text-muted">
          {minutes && <span className="inline-flex items-center gap-1"><Clock3 size={12} aria-hidden="true" />{minutes}</span>}
          {agent.materials && <span className="inline-flex items-center gap-1"><FolderUp size={12} aria-hidden="true" />需要你的资料</span>}
        </span>
      </span>
    </button>
  );
}
