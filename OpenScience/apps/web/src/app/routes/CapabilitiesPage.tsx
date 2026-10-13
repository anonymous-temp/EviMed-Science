import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { capabilityListed, GENERAL_TOOL_GROUP, GENERAL_TOOLS, PROFESSIONAL_TOOL_GROUP, searchMatches } from "@evimed/domain";
import { availabilityIsDrawn, fetchWebResearchEstimates, webErrorMessage, listWebResearchAgents, type WebResearchAgent, type WebResearchEstimate } from "@/lib/apiClient";
import { researchAgentUi, type CapabilityUi } from "@/lib/researchAgentUi";
import { capabilityIcon, generalToolIcon } from "@/lib/capabilityIcons";
import { bindConversationCapability } from "@/lib/dispatch";
import { formatNumber, formatRange } from "@/lib/format";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { useResearchBilling } from "@/lib/useResearchBilling";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { SimulatedAllowanceNotice, SimulatedMark } from "@/components/settings/SimulatedAllowance";
import { FilterChips } from "@/components/ui/FilterChips";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tag } from "@/components/ui/Tag";

/**
 * The order the professional tools follow within their one group — evidence,
 * pharmacy, study design and data, writing (2026-09-23 plan §5.4) — rather than
 * by the sort order of their categories' names, which put 写作与传播 second. A
 * category the display table gains later follows these, by name.
 */
const CATEGORY_ORDER = ["临床证据", "药学评价", "研究设计与数据", "写作与传播"];

function categoryRank(name: string): number {
  const at = CATEGORY_ORDER.indexOf(name);
  return at < 0 ? CATEGORY_ORDER.length : at;
}

type GeneralTool = (typeof GENERAL_TOOLS)[number];

/** The groups of the page, in the order it lists them: what anyone does first, then the medical capabilities. */
const GROUPS = [GENERAL_TOOL_GROUP, PROFESSIONAL_TOOL_GROUP] as const;

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
 * up, because it is an 「约」 figure and `4.05～7.02` only wraps the card. A
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
 * 工具 — what the platform does, as a grid in two groups.
 *
 * 通用 first: documents, spreadsheets, slides, data analysis, web research and
 * code, which anyone does and which are not capability packages — a card opens
 * an ordinary conversation with a sentence in the composer to change before it
 * is sent. 医学专业 after: the capability packages, each with its own contract.
 * The first group is the page's own table (`@evimed/domain`'s `GENERAL_TOOLS`),
 * so it is there whether or not the catalogue could be read.
 *
 * A capability is unlike its neighbours (each does a different job), so it is a
 * card — a quiet grey ground, no border — and not a row. A card says what the
 * tool does in one complete sentence and how long it usually takes; nothing
 * else. The sentence is the capability's `display.description`, kept short
 * enough for two lines at the source rather than cut off here with an ellipsis.
 * What a tool needs from the researcher is said by the composer once the tool
 * is chosen, not on the card.
 *
 * Choosing a capability opens a new conversation with that tool on: the reader
 * types into the composer they were going to use anyway, and the tool rides
 * along as a chip above it.
 *
 * Where research is billed from a simulated wallet (`useResearchBilling`), this
 * is also where the next task's cost is met before it starts: a card adds what
 * the tool usually takes out of the allowance, marked as simulated, and a low
 * or used-up allowance is prompted above the grid. Every other deployment gets
 * the page as it was, and asks for no estimate.
 */
export function CapabilitiesPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<WebResearchAgent[]>([]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
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
  // tools itself changes (a search or a group filters what is already here).
  // A read that fails costs the page nothing: the cards stay as they are.
  const listed = useMemo(() => catalogue.map((ui) => ui.id).join(","), [catalogue]);
  useEffect(() => {
    if (!billing.simulated || !listed) return;
    let active = true;
    void fetchWebResearchEstimates(listed.split(","))
      .then((answer) => { if (active) setEstimates(new Map(answer.items.map((item) => [item.capabilityId, item]))); })
      .catch(() => {});
    return () => { active = false; };
  }, [billing.simulated, listed]);

  // A retired module name still finds the module's tools until 2027-01-07 (`searchMatches`).
  const generalTools = useMemo(
    () => GENERAL_TOOLS.filter((tool) => searchMatches(query, [tool.title, tool.description, ...tool.starterPrompts])),
    [query],
  );
  const professionalTools = useMemo(
    () => catalogue.filter((ui) => searchMatches(query, [ui.title, ui.description, ...ui.starterPrompts]))
      .sort((left, right) => categoryRank(left.category) - categoryRank(right.category)),
    [catalogue, query],
  );
  const showGeneral = (group === "all" || group === GENERAL_TOOL_GROUP) && generalTools.length > 0;
  const showProfessional = group === "all" || group === PROFESSIONAL_TOOL_GROUP;

  /**
   * A capability is chosen by opening a conversation that runs it — bound
   * before the conversation exists, because a binding is what makes the router
   * honour the choice rather than re-decide it with a classifier.
   */
  const [opening, setOpening] = useState<string | null>(null);
  const open = (agent: CapabilityUi) => {
    if (opening) return;
    setOpening(agent.id);
    void bindConversationCapability(null, { agentId: agent.id, agentVersion: agent.version })
      .then((bound) => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(undefined, bound.sessionId), capabilityId: agent.id } }))
      // A binding the control plane refused must not strand the reader on a
      // dead card: the conversation opens, and the router decides as it did
      // before there were tools.
      .catch(() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } }))
      .finally(() => setOpening(null));
  };
  // A general tool binds nothing: a new conversation with its first sentence in the composer, never sent.
  const openGeneral = (tool: GeneralTool) => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(tool.starterPrompts[0]) } });

  const professionalEmpty = !loading && !error && professionalTools.length === 0;
  const nothing = !showGeneral && (!showProfessional || professionalEmpty);

  return (
    <PageShell
      title="工具"
      actions={<SearchInput label="搜索工具" value={query} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} className="w-72" />}
    >
      {/* Only a balance just read: while it is being read again, or could not be, the one held is not drawn. */}
      {!billing.loading && !billing.error && <SimulatedAllowanceNotice allowance={billing.allowance} className="mb-6" />}
      <FilterChips
        label="分类"
        className="mb-6"
        options={[{ value: "all", label: "全部" }, ...GROUPS.map((name) => ({ value: name, label: name }))]}
        value={group}
        onChange={setGroup}
      />
      <div className="space-y-8">
        {showGeneral && (
          <section aria-labelledby="capability-group-general">
            <h2 id="capability-group-general" className="mb-2 text-ui font-semibold text-text">{GENERAL_TOOL_GROUP}</h2>
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {generalTools.map((tool) => (
                <li key={tool.id} className="flex">
                  <GeneralToolCard tool={tool} onOpen={() => openGeneral(tool)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {showProfessional && (loading ? <ToolGridSkeleton />
          // Error with a way out, not a dead end: a catalogue that failed to
          // load once is usually a control plane that was briefly away. The
          // general tools above do not wait for it.
          : error ? <LoadError message={`无法加载工具目录：${error}`} onRetry={() => setReloads((value) => value + 1)} />
            : professionalTools.length > 0 && (
              <section aria-labelledby="capability-group-professional">
                <h2 id="capability-group-professional" className="mb-2 text-ui font-semibold text-text">{PROFESSIONAL_TOOL_GROUP}</h2>
                <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {professionalTools.map((agent) => (
                    <li key={agent.id} className="flex">
                      <ToolCard agent={agent} estimate={billing.simulated ? estimates.get(agent.id) : undefined} busy={opening === agent.id} onOpen={() => open(agent)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        {nothing && <EmptyState icon={Search} title="没有符合条件的工具" />}
      </div>
    </PageShell>
  );
}

/** One general tool: its icon and name and one sentence. It opens a conversation with a sentence to start from, bound to nothing. */
function GeneralToolCard({ tool, onOpen }: { tool: GeneralTool; onOpen: () => void }) {
  const Icon = generalToolIcon(tool.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`用“${tool.title}”开始一次对话`}
      className="flex min-h-32 w-full flex-col gap-1.5 rounded-card bg-surface-1 p-4 text-left transition-colors duration-fast hover:bg-surface-2"
    >
      <span className="flex items-center gap-2 text-ui font-semibold text-text">
        <Icon size={16} className="shrink-0 text-accent" aria-hidden="true" />
        {tool.title}
      </span>
      <span className="text-ui text-text-2">{tool.description}</span>
    </button>
  );
}

/**
 * One tool: its icon and name, one sentence, how long it usually takes, what
 * this deployment can truthfully say about it when that is something to act on
 * — and, where the allowance is simulated, what it usually takes out of it,
 * with the mark every simulated amount carries. The label is a label: the card
 * opens the same conversation whatever it says (an unavailable tool reports
 * "blocked" by its own mechanism when asked).
 */
function ToolCard({ agent, estimate, busy, onOpen }: { agent: CapabilityUi; estimate?: WebResearchEstimate; busy: boolean; onOpen: () => void }) {
  const Icon = capabilityIcon(agent.id);
  const duration = durationText(agent.estimatedMinutes);
  const allowance = allowanceText(estimate);
  const availability = agent.availability ?? null;
  const sentenceId = `availability-${agent.id}`;
  // Only a state the reader can act on is drawn (`availabilityIsDrawn`); the rest is neither seen nor read out. No tool is hidden
  // or disabled for what its state says.
  const shown = availability !== null && availabilityIsDrawn(availability.state);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      aria-label={`用“${agent.title}”开始一次对话`}
      aria-describedby={shown ? sentenceId : undefined}
      className="flex min-h-32 w-full flex-col gap-1.5 rounded-card bg-surface-1 p-4 text-left transition-colors duration-fast hover:bg-surface-2 disabled:cursor-wait disabled:opacity-40"
    >
      <span className="flex items-center gap-2 text-ui font-semibold text-text">
        <Icon size={16} className="shrink-0 text-accent" aria-hidden="true" />
        {agent.title}
      </span>
      <span className="text-ui text-text-2">{agent.description}</span>
      {shown && (
        <span id={sentenceId} className="text-caption text-text-3">
          {availability.text}
        </span>
      )}
      {(duration || allowance || shown) && (
        <span className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-caption text-text-3">
          {shown && <Tag>{availability.label}</Tag>}
          {[duration, allowance].filter(Boolean).join(" · ")}
          {allowance && <SimulatedMark />}
        </span>
      )}
    </button>
  );
}

/** The grid's shape while the catalogue loads: a heading and six grey cards. */
function ToolGridSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      <div className="mb-2 h-4 w-20 rounded bg-surface-2" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-32 rounded-card bg-surface-1" />)}
      </div>
    </div>
  );
}
