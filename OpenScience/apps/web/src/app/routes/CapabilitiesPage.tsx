import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Search } from "lucide-react";
import { capabilityListed, RESEARCH_TOOLS_NAME, searchMatches } from "@evimed/domain";
import { drawnAvailability, fetchWebResearchEstimates, webErrorMessage, listWebResearchAgents, type WebResearchAgent, type WebResearchEstimate } from "@/lib/apiClient";
import { researchAgentUi, type CapabilityUi } from "@/lib/researchAgentUi";
import { capabilityIcon } from "@/lib/capabilityIcons";
import { bindConversationCapability } from "@/lib/dispatch";
import { formatNumber, formatRange } from "@/lib/format";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { useResearchBilling } from "@/lib/useResearchBilling";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { SimulatedAllowanceNotice } from "@/components/settings/SimulatedAllowance";
import { Button, buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";

/**
 * The groups in the product's order — evidence, pharmacy, study design and
 * data, writing (2026-09-23 plan §5.4) — rather than by the sort order of their
 * names, which put 写作与传播 second. A group the display table gains later
 * follows these, by name.
 */
const CATEGORY_ORDER = ["临床证据", "药学评价", "研究设计与数据", "写作与传播"];

function categoryRank(name: string): number {
  const at = CATEGORY_ORDER.indexOf(name);
  return at < 0 ? CATEGORY_ORDER.length : at;
}

/**
 * How long a tool usually takes: 「约 30～70 分钟」. This page is the one place a
 * duration is shown — it is useful while choosing a tool, and the conversation
 * no longer repeats it on the tool's chip (plan §5.3).
 */
function durationText([min, max]: [number, number]): string | null {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return null;
  return min >= max ? `约 ${max} 分钟` : `约 ${min}～${max} 分钟`;
}

/**
 * What a tool usually takes out of the allowance: 「约 4～8 灵豆」, in whole
 * credits (one credit is one CNY) — the low end floored, the high end rounded
 * up, because it is an 「约」 figure and `4.05～7.02` only wraps the row. A
 * range that stays under one credit keeps its cents. Null when the estimate
 * names no range — nothing supports one (`basis: "none"`), or the two ends are
 * not a range — so a price nobody estimated is left out, never shown as zero.
 */
function allowanceText(estimate: WebResearchEstimate | undefined): string | null {
  if (!estimate || estimate.basis === "none") return null;
  const { low, high } = estimate;
  if (typeof low !== "number" || typeof high !== "number" || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || low > high) return null;
  const [from, to] = high < 1 ? [low, high] : [Math.floor(low), Math.ceil(high)];
  return `约 ${from === to ? formatNumber(to) : formatRange(from, to)} 灵豆`;
}

/**
 * 科研工具 — the medical professional workflows, one list per category.
 *
 * What is here is a workflow with a contract and a deliverable, and a category to
 * choose it by (临床证据 · 药学评价 · 研究设计与数据 · 写作与传播). Documents, spreadsheets, slides, data,
 * the open web and code are what the assistant does in any conversation; they are not tools to pick and
 * have no row here (owner, 2026-10-14). The page is the product's list page: one toolbar over the list —
 * the categories as one row of chips, the search and the count — and a row per tool: its icon and name, one
 * complete sentence, how long it usually takes.
 *
 * Choosing a tool opens a new conversation with that tool on: the reader types into the composer they were
 * going to use anyway, and the tool rides along as a chip above it.
 *
 * What the row says about the tool's state is a reason the reader can act on, and only that
 * (`drawnAvailability`): a connector they have not given their own key for — with the way to the page
 * where it is added — or a module their account is not offered. A deployment whose last run of a tool
 * failed says nothing here: that is a fact about somebody's run, and every account opens this page.
 *
 * Where research is billed from a simulated wallet (`useResearchBilling`), this is also where the next
 * task's cost is met before it starts: a row adds what the tool usually takes out of the allowance, and a
 * low or used-up allowance is prompted above the list. Every other deployment gets the page as it was, and
 * asks for no estimate.
 */
export function CapabilitiesPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<WebResearchAgent[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // `fresh`: the notice draws the balance, which moves. Whether the allowance
  // can be read never decides whether the catalogue is shown.
  const billing = useResearchBilling({ fresh: true });
  const [estimates, setEstimates] = useState<ReadonlyMap<string, WebResearchEstimate>>(() => new Map());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void listWebResearchAgents()
      .then((list) => { if (active) setAgents(list); })
      .catch((cause: unknown) => { if (active) setError(webErrorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloads]);

  // A capability its own module opens (the 「循证 GEO」 ones, `display.listed:
  // false`) is not a tool to pick here; it stays public so that module can
  // bind a conversation to it.
  const catalogue = useMemo(() => agents.filter((agent) => capabilityListed(agent.id)).map(researchAgentUi), [agents]);

  // What each listed tool usually costs, in one read for all of them — asked
  // only where the allowance is simulated, and again only when the list of
  // tools itself changes (a search or a category filters what is already here).
  // A read that fails costs the page nothing: the rows stay as they are.
  const listed = useMemo(() => catalogue.map((ui) => ui.id).join(","), [catalogue]);
  useEffect(() => {
    if (!billing.simulated || !listed) return;
    let active = true;
    void fetchWebResearchEstimates(listed.split(","))
      .then((answer) => { if (active) setEstimates(new Map(answer.items.map((item) => [item.capabilityId, item]))); })
      .catch(() => {});
    return () => { active = false; };
  }, [billing.simulated, listed]);

  const categories = useMemo(
    () => [...new Set(catalogue.map((ui) => ui.category))]
      .sort((left, right) => categoryRank(left) - categoryRank(right) || left.localeCompare(right, "zh")),
    [catalogue],
  );
  const groups = useMemo(() => categories
    .filter((name) => category === "all" || name === category)
    .map((name) => [name, catalogue.filter((ui) => ui.category === name
      // A retired module name still finds the module's tools until 2027-01-07 (`searchMatches`).
      && searchMatches(query, [ui.title, ui.description, ...ui.starterPrompts]))] as const)
    .filter(([, items]) => items.length > 0), [catalogue, categories, category, query]);
  const shown = groups.reduce((sum, [, items]) => sum + items.length, 0);

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

  const filtering = category !== "all" || query.trim() !== "";
  const clear = () => { setCategory("all"); setQuery(""); };

  return (
    <PageShell
      title={RESEARCH_TOOLS_NAME}
      // One row, above the list it controls: the categories, the search and what is listed.
      toolbar={{
        label: "科研工具筛选",
        filters: categories.length > 1
          ? [{ kind: "chips", label: "分类", options: [{ value: "all", label: "全部" }, ...categories.map((name) => ({ value: name, label: name }))], value: category, onChange: setCategory }]
          : [],
        onClear: clear,
        search: { label: "搜索工具", value: query, onChange: setQuery, onClear: () => setQuery("") },
        summary: loading || error ? undefined : `${shown} 个`,
      }}
    >
      {/* Only a balance just read: while it is being read again, or could not be, the one held is not drawn. */}
      {!billing.loading && !billing.error && <SimulatedAllowanceNotice allowance={billing.allowance} className="mb-6" />}
      {loading ? <ToolListSkeleton />
        // Error with a way out, not a dead end: a catalogue that failed to
        // load once is usually a control plane that was briefly away.
        : error ? <LoadError message={`无法加载工具目录：${error}`} onRetry={() => setReloads((value) => value + 1)} />
          : groups.length === 0 ? (
            <EmptyState
              icon={Search}
              title={`没有符合条件的${RESEARCH_TOOLS_NAME}`}
              action={filtering ? <Button variant="secondary" onClick={clear}>清除筛选</Button> : undefined}
            />
          ) : (
            <div>
              {groups.map(([name, items]) => (
                <Section key={name} title={name} count={items.length}>
                  <List label={name} divided>
                    {items.map((agent) => (
                      <ToolRow key={agent.id} agent={agent} estimate={billing.simulated ? estimates.get(agent.id) : undefined} busy={opening === agent.id} onOpen={() => open(agent)} />
                    ))}
                  </List>
                </Section>
              ))}
            </div>
          )}
    </PageShell>
  );
}

/** Where the reader adds what a tool is missing, by the reason that is drawn: their own key for a data source. */
const FIX_PATH = "/app/account?tab=connectors";

/**
 * One tool: its icon and name, one sentence, and under it how long it usually
 * takes — and, where the allowance is simulated, what it usually takes out of it. A state is said only when
 * it is a reason the reader can act on, as a word and, where there is one, its sentence with the way to
 * mend it. The row opens the same conversation whatever it says (an unavailable tool reports "blocked" by its
 * own mechanism when asked).
 */
function ToolRow({ agent, estimate, busy, onOpen }: { agent: CapabilityUi; estimate?: WebResearchEstimate; busy: boolean; onOpen: () => void }) {
  const Icon = capabilityIcon(agent.id);
  const duration = durationText(agent.estimatedMinutes);
  const allowance = allowanceText(estimate);
  const drawn = drawnAvailability(agent.availability ?? null);
  const facts = [duration, allowance].filter(Boolean).join(" · ");
  const connector = agent.availability?.reason.code === "data-source-not-configured";
  return (
    <ListRow
      leading={<Icon size={20} className="text-accent" aria-hidden="true" />}
      title={agent.title}
      muted={busy}
      meta={(
        <>
          <span className="block">{agent.description}</span>
          {(facts || drawn) && (
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {drawn && <Tag>{drawn.label}</Tag>}
              {drawn?.text && <span>{drawn.text}</span>}
              {facts && <span className="tabular-nums">{facts}</span>}
            </span>
          )}
        </>
      )}
      actions={connector ? <Link to={FIX_PATH} className={buttonClasses({ variant: "text", size: "sm" })}>去添加</Link> : undefined}
      onOpen={onOpen}
    />
  );
}

/** The list's shape while the catalogue loads: a heading and six grey rows. */
function ToolListSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="mb-3 h-5 w-24 rounded bg-surface-2" />
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-start gap-3 px-2 py-3">
          <div className="mt-0.5 h-5 w-5 rounded bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/3 rounded bg-surface-2" />
            <div className="h-3 w-2/3 rounded bg-surface-1" />
          </div>
        </div>
      ))}
    </div>
  );
}
