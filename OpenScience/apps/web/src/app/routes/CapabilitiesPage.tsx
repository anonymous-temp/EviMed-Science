import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronRight, Clock3, FolderUp, RefreshCw, Search, ServerCrash } from "lucide-react";
import { capabilityBrief } from "@evimed/domain";
import { webErrorMessage, hasWebApi, listWebResearchAgents, type WebAgentRun, type WebResearchAgent } from "@/lib/apiClient";
import { researchAgentUi, type CapabilityUi } from "@/lib/researchAgentUi";
import { capabilityIcon } from "@/lib/capabilityIcons";
import { minutesText } from "@/lib/dispatch";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { AgentsSkeleton } from "@/components/cards/Skeletons";
import { CapabilityCard } from "@/components/capabilities/CapabilityCard";
import { DispatchReceipt } from "@/components/runs/DispatchReceipt";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";

/**
 * The capability catalogue (plan §8.4, appendix D §5.2 and §10.4).
 *
 * Fifteen capabilities are too many for chips and too important for a
 * dropdown, and fifteen 220 px cards showed three to a screen. So: grouped by
 * what they are for, searchable, one compact row each — a line icon, the name,
 * one line of what it does, how long it usually takes. A row opens the
 * capability's model card: what it does, how well it has done (from `evals/`),
 * what it cannot do, what the researcher receives, and a way to start.
 *
 * Starting dispatches at once (owner decision 3) and the receipt at the top of
 * the page shows the route line; 在对话里写 is kept for the researcher who
 * would rather shape the brief in the conversation first.
 *
 * `?capability=<id>` opens a card directly, so a capability can be linked to.
 */

/**
 * The brief a capability card hands the composer.
 *
 * Re-exported from `@evimed/domain` rather than written here: the kernel's own
 * hero renders the same cards inside the session frame, and a brief that two
 * surfaces spell differently is two different high-confidence expectations for
 * the delivery gate to read.
 */
export { capabilityBrief };

export function CapabilitiesPage() {
  const [agents, setAgents] = useState<WebResearchAgent[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(hasWebApi);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [receipt, setReceipt] = useState<{ run: WebAgentRun; question: string } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("capability");

  useEffect(() => {
    let active = true;
    if (!hasWebApi) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void listWebResearchAgents()
      .then((catalog) => {
        if (active) setAgents(catalog);
      })
      .catch((reason) => {
        if (active) setError(webErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloads]);

  const capabilities = useMemo(() => agents.map(researchAgentUi), [agents]);
  const categories = useMemo(
    () => [...new Set(capabilities.map((agent) => agent.category))].sort((a, b) => a.localeCompare(b, "zh")),
    [capabilities],
  );
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => capabilities.filter((agent) => {
      if (category && agent.category !== category) return false;
      if (!needle) return true;
      return [agent.title, agent.description, agent.category, ...agent.starterPrompts, ...agent.deliverables]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    }),
    [capabilities, category, needle],
  );
  const groups = useMemo(() => {
    const byCategory = new Map<string, CapabilityUi[]>();
    for (const agent of visible) byCategory.set(agent.category, [...(byCategory.get(agent.category) ?? []), agent]);
    return [...byCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "zh"))
      .map(([name, items]) => [name, items.sort((a, b) => a.title.localeCompare(b.title, "zh"))] as const);
  }, [visible]);

  const opened = openId ? capabilities.find((agent) => agent.id === openId) ?? null : null;
  const openCard = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("capability", id);
    else next.delete("capability");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-content-full px-8 py-9">
        <PageHeader
          title="科研能力"
          description="选一项能力，看它做什么、实测做得怎样、有哪些局限，写下问题就能直接开始；开始后会说明按哪条线处理、通常要多久，不合适可以一键改线。"
        />

        <div className="mt-6 flex flex-col gap-3 border-b border-border pb-5 md:flex-row md:items-center">
          <label className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={14} aria-hidden="true" />
            <span className="sr-only">搜索科研能力</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索能力、产物或示例问题"
              className="h-9 w-full rounded-input border border-strong bg-surface pl-9 pr-3 text-ui text-text outline-none placeholder:text-muted focus:border-focus"
            />
          </label>
          {categories.length > 1 && (
            <div role="group" aria-label="按分类筛选" className="flex flex-wrap gap-1.5">
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

        {receipt && (
          <div className="mt-6">
            <DispatchReceipt run={receipt.run} question={receipt.question} catalog={agents} onDismiss={() => setReceipt(null)} />
          </div>
        )}

        <div className="mt-6 space-y-8">
          {loading && <AgentsSkeleton />}
          {/* Error with a way out, not a dead end: a catalogue that failed to
            * load once is usually a control plane that was briefly away. */}
          {!loading && error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-input border border-danger bg-danger-soft px-4 py-3 text-ui text-danger-strong">
              <span className="min-w-0 flex-1 break-words">无法加载能力目录：{error}</span>
              <Button size="sm" variant="ghost" onClick={() => setReloads((value) => value + 1)}>
                <RefreshCw size={12} aria-hidden /> 重试
              </Button>
            </div>
          )}
          {!loading && !error && !hasWebApi && (
            <EmptyState
              icon={ServerCrash}
              title="科研能力仅在 EviMed 在线工作空间中可用"
              description="请在 EviMed 在线工作空间中使用此功能。"
            />
          )}
          {!loading && !error && hasWebApi && visible.length === 0 && (
            <EmptyState
              icon={Search}
              title="没有符合条件的科研能力"
              description={needle ? `没有能力的名称、说明或示例里有「${query.trim()}」。` : undefined}
            />
          )}
          {!loading && !error && groups.map(([name, items]) => (
            <section key={name} aria-labelledby={`capability-group-${name}`}>
              <h2 id={`capability-group-${name}`} className="mb-3 flex items-baseline gap-2 text-ui font-semibold text-text">
                {name}<span className="text-caption font-normal text-muted">{items.length} 项</span>
              </h2>
              <ul className="grid gap-2 xl:grid-cols-2">
                {items.map((agent) => (
                  <li key={agent.id}><CapabilityRow agent={agent} onOpen={() => openCard(agent.id)} /></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      {opened && (
        <Drawer
          title={opened.title}
          description={`${opened.category} · 版本 ${opened.version}`}
          onClose={() => openCard(null)}
          widthClassName="max-w-xl"
        >
          <CapabilityCard
            agent={agents.find((agent) => agent.id === opened.id) ?? opened}
            onDispatched={(run, question) => {
              openCard(null);
              setReceipt({ run, question });
            }}
          />
        </Drawer>
      )}
    </div>
  );
}

/** One compact row (appendix D §10.4): icon, name, one line, how long. */
function CapabilityRow({ agent, onOpen }: { agent: CapabilityUi; onOpen: () => void }) {
  const Icon = capabilityIcon(agent.id);
  const minutes = minutesText({ min: agent.estimatedMinutes[0], max: agent.estimatedMinutes[1] });
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${agent.title}：查看说明并开始`}
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
      <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted transition-transform duration-fast group-hover:translate-x-0.5" aria-hidden="true" />
    </button>
  );
}
