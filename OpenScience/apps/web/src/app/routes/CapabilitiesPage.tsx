import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Clock3, FileCheck2, RefreshCw, Search, ServerCrash } from "lucide-react";
import { useNavigate } from "react-router";
import { hasWebApi, listWebResearchAgents, webRuntimeProfile, type WebResearchAgent, type WebResearchAgentOutput } from "@/lib/apiClient";
import { researchAgentUi } from "@/lib/researchAgentUi";
import { EmptyState } from "@/components/cards/EmptyState";
import { AgentsSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { useUiStore } from "@/lib/store";

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
 * So the row prefills and navigates; it binds nothing. Which behaviour a
 * deployment gets is the kernel's answer, not a build flag, because the kernel
 * has a one-line rollback and the retiring page still needs its binding.
 */

/**
 * The brief a template hands the composer.
 *
 * The capability is named in the sentence rather than in a request field on
 * purpose: there is no capability parameter on the dispatch route, the
 * orchestrator reads the brief, and a person can edit or delete the naming line
 * — which is exactly the difference between a suggestion and a binding.
 *
 * @param title the capability's own title @param prompt the starter brief
 * @returns the text to prefill
 */
export function capabilityBrief(title: string, prompt: string): string {
  return `请以「${title}」能力完成以下任务：\n\n${prompt}`;
}

export function CapabilitiesPage() {
  const navigate = useNavigate();
  const setComposerDraft = useUiStore((state) => state.setComposerDraft);
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
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
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
      // The retiring session view still binds a session to a package, and its
      // rollback must not need a new bundle — so the old link survives there
      // and only the new view gets the prefill.
      if (webRuntimeProfile().sessionView === "legacy") {
        navigate(`/live?agent=${encodeURIComponent(agent.id)}`);
        return;
      }
      setComposerDraft(capabilityBrief(ui.title, ui.starterPrompts[0] ?? ""));
      navigate("/live");
    },
    [navigate, setComposerDraft],
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
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-accent">
              <Bot size={14} /> EviMed 能力目录
            </div>
            <h1 className="font-serif text-2xl font-semibold tracking-tight text-text">能力模板</h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              选一个模板，它会把题面填进对话框并点名该能力；你可以随意修改，也可以在同一次对话里接着要别的产出。
              模板是建议，不是绑定。
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
            <label className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={14} />
              <span className="sr-only">搜索能力模板</span>
              <input
                type="search"
                aria-label="搜索能力模板"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索能力模板"
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
              title="能力模板仅在 EviMed 在线工作空间中可用"
              description="请在 EviMed 在线工作空间中使用此功能。"
            />
          )}
          {!loading && !error && hasWebApi && visible.length === 0 && (
            <EmptyState icon={Search} title="没有符合条件的能力模板" />
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
      aria-label={`使用${ui.title}模板`}
      className="group grid w-full grid-cols-[3rem_minmax(0,1fr)_auto] gap-4 py-6 text-left transition-colors hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-input bg-surface-2 font-mono text-xs font-semibold tracking-wide text-accent ring-1 ring-border">
        {ui.code}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-medium tracking-[0.12em] text-accent">{ui.category}</span>
          <span className="inline-flex items-center gap-1"><Clock3 size={12} /> 约 {ui.estimatedMinutes[0]}–{ui.estimatedMinutes[1]} 分钟</span>
          {supportsFiles && <span className="inline-flex items-center gap-1"><FileCheck2 size={12} /> 支持知识库资料</span>}
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
        <ArrowRight size={17} />
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
