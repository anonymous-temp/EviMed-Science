import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useAddressOpen } from "@/lib/addressState";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { MapDrawer } from "@/components/memory/map/MapDrawer";
import { MarkGlyph } from "@/components/memory/map/MarkGlyph";
import { MemoryFrame, memoryTabAddress } from "@/components/memory/MemoryFrame";
import { MemoryHeaderActions, type HeaderDrawer } from "@/components/memory/MemoryHeaderActions";
import { GrowthCard } from "@/components/memory/overview/GrowthCard";
import type { CardState } from "@/components/memory/overview/OverviewCard";
import { ReceivedCardView, type WorkStyleRead } from "@/components/memory/overview/ReceivedCard";
import {
  aboutYouCard, growthEvents, growthOf, knowledgeCard, methodsCard, needsLook, overviewHeadline, partAddress, projectsCard, readable, receivedCard, recentGains, workStyle,
  type OverviewDoc, type ReadPart,
} from "@/components/memory/overview/memoryOverviewModel";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { MarkRows } from "@/components/memory/overview/OverviewCard";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { dayIn } from "@/components/charts/map/zone";
import { formatDay, formatNumber } from "@/lib/format";
import { fetchMyCapsule, fetchReceivedCapsules } from "@/lib/memoryClient";
import { listAllMethods } from "@/lib/methodsClient";
import { useMemoryMapFeature } from "@/lib/memoryMapFeature";
import { fetchMemoryMap, MAP_INCLUDE_OVERVIEW, type MapOpen } from "@/lib/memoryMapClient";
import { previewCapsuleExport } from "@/lib/productClient";
import { useProjectLabels } from "@/lib/projectNames";

/** What the 工作方式卡 of this account is read from: the scopes the share dialog offers by default, so the card says what a file would carry. */
const HANDOVER_SCOPES = ["workstyle", "+profile", "+knowledge"];

/** What this account could hand over, in the three categories of the 工作方式卡: the preview of an export, read and not made. */
async function readHandover() {
  const mine = await fetchMyCapsule();
  if (!mine.capsule) return workStyle([]);
  return workStyle((await previewCapsuleExport(mine.capsule.id, { scopes: HANDOVER_SCOPES })).entries);
}

/**
 * The account overview leads with its content and attention items. Received-pack
 * management is an explicit main-area mode, preserving the same producer reads,
 * activation controls and share/import dialogs. History is a compact summary;
 * the map remains the full historical and scientific detail destination.
 * Independent read failures and retained results never become a shared zero.
 * Component: MemoryOverviewPage; owner: H; rules: DS14, DS22; AT55/57.
 * Anatomy: Account headline, attention list, content summary, preview and compact history.
 * Variants: Summary and explicit received-capsule management via the section query.
 * States: Independent loading/error/stale reads; common first use requires every part read empty.
 * Hit area: Existing native ListRow links and Button controls.
 * Keyboard: Native navigation and existing drawer/async-switch behavior.
 * Long content: Bounded preview/history links to full existing destinations.
 * Theme: Existing semantic text, status and surface roles.
 * Responsive: One readable content column with wrapping row metadata.
 * Verification: MemoryOverviewPage.test.tsx; rendered state/width proof is recorded in the v3.2 plan.
 */
export function MemoryOverviewPage() {
  const feature = useMemoryMapFeature();
  // The overview reads the map's document, which a deployment that does not draw the map does not serve.
  if (feature === "loading") return <RunsSkeleton filter={false} />;
  if (feature === "off") return <Navigate to={memoryTabAddress("self")} replace />;
  return <Overview />;
}

function Overview() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const managingReceived = params.get("section") === "received";
  const previousMode = useRef(managingReceived);
  const receivedBack = useRef<HTMLAnchorElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (previousMode.current === managingReceived) return;
    previousMode.current = managingReceived;
    if (managingReceived) receivedBack.current?.focus();
    else summary.current?.querySelector<HTMLAnchorElement>("[data-received-entry]")?.focus();
  }, [managingReceived]);
  const overviewParams = new URLSearchParams(params);
  overviewParams.delete("section");
  const overviewAddress = `/app/memory/overview${overviewParams.size ? `?${overviewParams}` : ""}`;
  const receivedParams = new URLSearchParams(overviewParams);
  receivedParams.set("section", "received");
  const receivedAddress = `/app/memory/overview?${receivedParams}`;
  useMemoryWritePrompt();
  const labels = useProjectLabels();
  const drawer = useAddressOpen("open");
  const [header, setHeader] = useState<HeaderDrawer | null>(null);
  const map = useCapsuleData(() => fetchMemoryMap({ projectId: null, range: "all", focus: null, depth: 1 }, undefined, MAP_INCLUDE_OVERVIEW));
  const received = useCapsuleData(fetchReceivedCapsules);
  // The learned methods are their own read: the map folds its marks to a hundred and fifty and a method is among the first it folds (see `ReadPart`).
  const learned = useCapsuleData(() => listAllMethods("approved"));
  const handover = useCapsuleData(readHandover);
  const reloadAll = useCallback(() => { map.reload(); received.reload(); learned.reload(); handover.reload(); }, [map, received, learned, handover]);

  const doc: OverviewDoc | null = map.data;

  /** The state of a card the map's document answers for: not yet read, not readable (a source failed), or read. */
  const stateOf = (part: ReadPart): CardState => (!doc ? (map.failed ? "error" : "loading") : readable(doc, part) ? "content" : "error");
  const failure = doc ? "这一部分有资料没有读到。" : "暂时读不到记忆。";

  const open = (target: MapOpen) => {
    if (target.kind === "page") navigate(target.href);
    else drawer.open(`${target.kind}:${target.id}`);
  };
  const toChat = () => navigate("/app/chat");

  // ---- what each card draws, from what was read ----
  const events = useMemo(() => (doc ? growthEvents(doc, received.data ?? [], learned.data ?? []) : []), [doc, received.data, learned.data]);
  const growth = useMemo(() => {
    if (!doc) return null;
    // Today is the day the document was read, in the researcher's zone: the strip ends there, and the last thirty days are counted back from it.
    const now = new Date();
    return growthOf(events, dayIn(now.getTime(), doc.scope.timeZone), (day) => formatDay(day, now));
  }, [doc, events]);
  const you = doc ? aboutYouCard(doc) : null;
  const projects = doc ? projectsCard(doc) : null;
  const methods = learned.data ? methodsCard(learned.data) : null;
  const knowledge = doc ? knowledgeCard(doc) : null;
  const look = doc ? needsLook(doc) : null;
  const receivedView = received.data ? receivedCard(received.data) : null;
  const handoverRead: WorkStyleRead = handover.data ? { state: "content", style: handover.data } : handover.failed ? { state: "error" } : { state: "loading" };

  // The sentence names only what was read: a part whose source failed leaves its number out, and is not a zero in its place — and the methods are
  // their own read, so a map that could not be read does not take the number of the methods with it.
  const headline = overviewHeadline({
    memories: doc && readable(doc, "memories") ? doc.summary.memories : null,
    methods: methods ? methods.count : null,
    documents: doc && knowledge && readable(doc, "knowledge") ? knowledge.count : null,
    recent: doc && growth && readable(doc, "growth") && !map.failed
      && received.data && !received.failed && learned.data && !learned.failed ? recentGains(events, growth.today) : null,
  }, { memories: "/app/memory/map", methods: partAddress("method"), documents: partAddress("knowledge"), recent: partAddress("growth") });

  // The strip is made of four reads — the map's document, the learned methods, the packs received — and says nothing about a lane it could not read:
  // a strip without 学会 is not a strip of an account that learned nothing.
  const growthState: CardState = (() => {
    const mapState = stateOf("growth");
    if (mapState !== "content") return mapState;
    if ((received.failed && !received.data) || (learned.failed && !learned.data)) return "error";
    return received.data && learned.data ? "content" : "loading";
  })();
  const lookRows = look && doc && readable(doc, "memories") ? look : null;
  const projectName = (id: string | null) => (id ? labels.get(id) ?? null : null);
  const summaryRows = [
    { key: "you", title: "关于你", count: stateOf("memories") === "content" ? you?.count ?? null : null, unit: "件", state: stateOf("memories"), to: partAddress("you"), detail: "查看个人偏好与背景" },
    { key: "projects", title: "项目", count: stateOf("projects") === "content" ? projects?.count ?? null : null, unit: "个", state: stateOf("projects"), to: partAddress("project"), detail: projects && stateOf("projects") === "content" ? `${projects.memories} 件项目记忆` : "查看各个项目的记忆" },
    { key: "methods", title: "我的做法", count: methods?.count ?? null, unit: "种", state: methods ? "content" : learned.failed ? "error" : "loading", to: memoryTabAddress("methods"), detail: "查看已采用的做法" },
    { key: "knowledge", title: "知识", count: stateOf("knowledge") === "content" ? knowledge?.count ?? null : null, unit: "份", state: stateOf("knowledge"), to: partAddress("knowledge"), detail: "在地图中查看资料与来源" },
    { key: "received", title: "收到的胶囊", count: receivedView?.count ?? null, unit: "个", state: receivedView ? "content" : received.failed ? "error" : "loading", to: receivedAddress, detail: "管理收到的内容与启用状态" },
  ];
  const firstUse = Boolean(doc && !map.failed && !learned.failed && !received.failed && !doc.missing.length
    && doc.summary.memories === 0 && events.length === 0 && summaryRows.every(row => row.state === "content" && row.count === 0));
  const preview = you ? (you.shape === "rows" ? you.rows : you.newest).slice(0, 3) : [];
  const mapProblem = map.failed || Boolean(doc?.missing.length);
  const historyPartial = growthState !== "content" || map.failed || learned.failed || received.failed;

  return (
    <MemoryFrame
      tab="overview" map documentTitle={managingReceived ? "收到的胶囊" : "记忆胶囊总览"} toolbar={null}
      actions={<MemoryHeaderActions onChanged={reloadAll} drawer={header} onDrawer={setHeader} />}
      headline={!managingReceived && headline ? { parts: headline, id: "memory-overview-headline" } : undefined}
    >
      {managingReceived ? (
        <div data-memory-overview-mode="received" className="space-y-4">
          <Link ref={receivedBack} to={overviewAddress} className="inline-flex rounded text-ui text-link">返回记忆总览</Link>
          {received.failed && received.data && <InlineAlert tone="warning" onRetry={received.reload}>收到的胶囊暂未刷新，仍显示上次读取的内容。</InlineAlert>}
          {handover.failed && handover.data && <InlineAlert tone="warning" onRetry={handover.reload}>可分享的内容暂未刷新，仍显示上次读取的内容。</InlineAlert>}
          <ReceivedCardView
            state={received.data ? "content" : received.failed ? "error" : "loading"} card={receivedView} workStyle={handoverRead}
            errorMessage="暂时读不到收到的胶囊。" onRetry={received.reload} onRetryWorkStyle={handover.reload} onChanged={received.reload}
            onImport={() => setHeader({ kind: "share", tab: "import" })} onShare={() => setHeader({ kind: "share", tab: "export" })}
          />
        </div>
      ) : (
        <div ref={summary} data-memory-overview-mode="summary" className="space-y-6">
        {lookRows && lookRows.count > 0 && (
          <div data-overview-look={lookRows.count}>
            <Section
              title="需要看一眼" count={lookRows.count}
              toolbar={lookRows.more > 0 ? <Link to={partAddress("look")} className="rounded text-ui text-link hover:underline hover:underline-offset-4">全部 {lookRows.count} 条</Link> : undefined}
            >
              <List label="需要看一眼的记忆">
                {lookRows.rows.map((row) => (
                  <ListRow
                    key={row.id} title={<span className="line-clamp-2 max-w-measure">{row.title}</span>} leading={<MarkGlyph node={row.node} />} meta={row.reason}
                    onOpen={row.open ? () => open(row.open!) : undefined} titleProps={{ "data-overview-row": "" }}
                  />
                ))}
              </List>
            </Section>
          </div>
        )}
          {mapProblem && <InlineAlert tone="warning" onRetry={map.reload}>{!doc ? failure : map.failed ? "记忆暂未刷新，仍显示上次读取的内容。" : "部分来源暂未读到，已保留可用内容。"}</InlineAlert>}
          {learned.failed && <InlineAlert tone="warning" onRetry={learned.reload}>{learned.data ? "做法暂未刷新，仍显示上次读取的内容。" : "暂时读不到学到的做法。"}</InlineAlert>}
          {received.failed && <InlineAlert tone="warning" onRetry={received.reload}>{received.data ? "收到的胶囊暂未刷新，仍显示上次读取的内容。" : "暂时读不到收到的胶囊。"}</InlineAlert>}
          {firstUse && <EmptyState title="开始积累你的记忆" description="在对话中说出你的工作偏好，或用页头的“记住这一条”添加。" action={<Button variant="secondary" onClick={toChat}>开始对话</Button>} />}
          <Section title="记忆内容">
            <List label="记忆内容与入口" divided>
              {summaryRows.map(row => <ListRow key={row.key} title={row.title} to={row.to} meta={row.detail} titleProps={row.key === "received" ? { "data-received-entry": "" } : undefined}
                actions={row.key === "knowledge" && row.count === 0 ? <Button size="sm" variant="text" onClick={() => navigate("/app/files")}>上传资料</Button> : undefined}
                trailing={<span data-memory-summary-part={row.key} data-state={row.state} data-count={row.count ?? undefined} data-memories={row.key === "projects" && row.state === "content" ? projects?.memories : undefined} className="tabular-nums text-ui text-text-2">{row.count === null ? row.state === "error" ? "未读到" : "正在读取" : `${formatNumber(row.count)} ${row.unit}`}</span>} />)}
            </List>
          </Section>
          {stateOf("memories") === "content" && preview.length > 0 && <Section title="记忆预览">
            <MarkRows label="关于你的记忆预览" rows={preview} ask="memory" onOpen={open} />
          </Section>}
          {methods && methods.rows.length > 0 && <Section title="做法预览">
            <MarkRows label="最近采用的做法" rows={methods.rows.slice(0, 3)} ask="method" onOpen={open} />
          </Section>}
          {!firstUse && growthState === "error" && events.length === 0 && <Section title="最近变化"><p role="status" data-layout-exception="memory-growth-failed" className="text-ui text-text-2">部分来源暂未读到，暂不汇总变化。</p><Link to={partAddress("growth")} className="rounded text-ui text-link">查看完整历史</Link></Section>}
          {!firstUse && (growthState !== "error" || events.length > 0) && <GrowthCard compact partial={historyPartial} state={events.length > 0 ? "content" : growthState} growth={growth} events={events} timeZone={doc?.scope.timeZone ?? "UTC"} errorMessage={failure}
            onRetry={() => { map.reload(); received.reload(); learned.reload(); }} onChat={toChat}
            onOpen={(target, event) => {
              if (target) open(target);
              else if (event.lane === "documents") navigate(partAddress("knowledge"));
              else if (event.lane === "received") navigate(receivedAddress);
              else navigate(partAddress("growth"));
            }} />}
        </div>
      )}
      {drawer.value && (
        <MapDrawer
          open={drawer.value} projectName={projectName} onClose={drawer.close} onChanged={reloadAll}
          onOpenRecord={(id) => drawer.open(`record:${id}`)} canOpenRecord={() => true}
        />
      )}
    </MemoryFrame>
  );
}
