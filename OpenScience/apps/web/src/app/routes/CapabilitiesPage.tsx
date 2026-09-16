import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Clock3, FileCheck2, RefreshCw, Search, ServerCrash } from "lucide-react";
import { useNavigate } from "react-router";
import { capabilityBrief } from "@evimed/domain";
import { webErrorMessage, hasWebApi, listWebResearchAgents, type WebResearchAgent, type WebResearchAgentOutput } from "@/lib/apiClient";
import { researchAgentUi } from "@/lib/researchAgentUi";
import { EmptyState } from "@/components/cards/EmptyState";
import { AgentsSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { PageTitle } from "@/components/layout/PageTitle";

/**
 * Capability templates (§9.8).
 *
 * Hidden knowledge: what changed here is the *meaning* of a click, not the
 * list. Under the retiring kernel a row bound the session to one package for
 * its whole life, so picking wrong meant starting over. Under one composition
 * the orchestrator composes capabilities itself, and a template is a
 * suggestion: picking one fills the brief and names the capability in it — a
 * high-confidence expectation the delivery gate reads (§9.4) — and the same
 * conversation can go on to ask for something else without switching anything.
 *
 * The row opens a native session and fills its draft through the scoped input
 * API. The researcher still chooses whether to submit that brief.
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
  const navigate = useNavigate();
  const [agents, setAgents] = useState<WebResearchAgent[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
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

  const open = useCallback(
    (agent: WebResearchAgent) => {
      const ui = researchAgentUi(agent);
      navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(capabilityBrief(ui.title, ui.starterPrompts[0] ?? "")) } });
    },
    [navigate],
  );

  const localizedAgents = useMemo(() => agents.map(researchAgentUi), [agents]);
  const categories = useMemo(
    () => [...new Set(localizedAgents.map((agent) => agent.category))].sort((a, b) => a.localeCompare(b)),
    [localizedAgents],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return localizedAgents.filter((agent) => {
      if (category !== "all" && agent.category !== category) return false;
      if (!needle) return true;
      return [agent.title, agent.description, agent.category, ...agent.starterPrompts]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [localizedAgents, category, query]);

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-5xl px-8 py-9">
        <div className="flex flex-col gap-6 border-b border-border pb-7 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            {/* `uppercase` on a line that is already Chinese did nothing to
              * the Chinese and shouted the one English word in it. */}
            <div className="mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.16em] text-accent">
              <Bot size={14} aria-hidden="true" /> EviMed 能力目录
            </div>
            {/* 「能力模板」 read as document templates. These are the fifteen
              * specialist research capabilities — drug safety, meta-analysis,
              * Mendelian randomization, peer review — and a researcher who was
              * told the platform ships research plugins did not find them under
              * a word that means stationery (2026-09-15 walk, C2). §9.8 renamed
              * them from "agents" because a pick became a suggestion rather
              * than a binding; that is still true, and the sentence below says
              * it, which is where it belongs. */}
            <PageTitle page="科研能力" />
            <h1 className="font-serif text-2xl font-semibold tracking-tight text-text">科研能力</h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              选一项能力，它会把题面填进对话框并点名该能力；你可以随意修改，也可以在同一次对话里接着要别的产出。
              这是建议，不是绑定。
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
            <label className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={14} aria-hidden="true" />
              <span className="sr-only">搜索科研能力</span>
              <input
                type="search"
                aria-label="搜索科研能力"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索科研能力"
                className="h-9 w-full rounded-input border border-border bg-surface pl-9 pr-3 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
              />
            </label>
            <select
              aria-label="按分类筛选"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-9 rounded-input border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent"
            >
              <option value="all">全部分类</option>
              {categories.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </div>

        <div className="mt-2 divide-y divide-border border-b border-border">
          {loading && <AgentsSkeleton />}
          {/* Error with a way out, not a dead end: a catalogue that failed to
            * load once is usually a control plane that was briefly away, and
            * the alternative to a retry button is asking the reader to reload
            * the whole app. */}
          {!loading && error && (
            <div role="alert" className="my-5 flex flex-wrap items-center gap-3 rounded-input border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
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
            <EmptyState icon={Search} title="没有符合条件的科研能力" />
          )}
          {!loading && !error && visible.map((agent) => (
            <AgentRow key={agent.id} agent={agent} onOpen={() => open(agent)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentRow({ agent, onOpen }: { agent: WebResearchAgent; onOpen: () => void }) {
  const ui = researchAgentUi(agent);
  const outputLabels = [...new Set(ui.outputs.map(outputLabel))];
  const supportsFiles = agent.optionalInputs.includes("uploadedFiles") || agent.requiredInputs.includes("uploadedFiles");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`使用${ui.title}能力`}
      className="group grid w-full grid-cols-[3rem_minmax(0,1fr)_auto] gap-4 py-6 text-left transition-colors hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-input bg-surface-2 font-mono text-xs font-semibold tracking-wide text-accent ring-1 ring-border">
        {ui.code}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-medium tracking-[0.12em] text-accent">{ui.category}</span>
          <span className="inline-flex items-center gap-1"><Clock3 size={12} aria-hidden="true" /> 约 {ui.estimatedMinutes[0]}–{ui.estimatedMinutes[1]} 分钟</span>
          {supportsFiles && <span className="inline-flex items-center gap-1"><FileCheck2 size={12} aria-hidden="true" /> 支持知识库资料</span>}
        </div>
        <h2 className="mt-2 text-title font-semibold text-text">{ui.title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{ui.description}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {outputLabels.map((label) => (
            <span key={label} className="rounded-full bg-surface-2 px-2 py-0.5 text-caption font-medium text-muted ring-1 ring-border">{label}</span>
          ))}
          <span className="truncate text-xs text-muted/80">示例：{ui.starterPrompts[0]}</span>
        </div>
      </div>
      <div className="flex h-full items-center px-3 text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent">
        <ArrowRight size={17} aria-hidden="true" />
      </div>
    </button>
  );
}

function outputLabel(output: WebResearchAgentOutput): string {
  const ext = output.path.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "pdf" || ext === "doc" || ext === "docx") return "报告";
  if (ext === "csv" || ext === "xls" || ext === "xlsx") return "表格";
  if (["png", "jpg", "jpeg", "svg", "webp"].includes(ext ?? "")) return "图表";
  if (ext === "json") return "数据";
  return "成果文件";
}
