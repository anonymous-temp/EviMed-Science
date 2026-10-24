import { useCallback, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useAddressOpen } from "@/lib/addressState";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { MapDrawer } from "@/components/memory/map/MapDrawer";
import { MarkGlyph } from "@/components/memory/map/MarkGlyph";
import { MemoryFrame, memoryTabAddress } from "@/components/memory/MemoryFrame";
import { MemoryHeaderActions, type HeaderDrawer } from "@/components/memory/MemoryHeaderActions";
import { GrowthCard } from "@/components/memory/overview/GrowthCard";
import type { CardState } from "@/components/memory/overview/OverviewCard";
import { AboutYouCardView, KnowledgeCardView, MethodsCardView, ProjectsCardView } from "@/components/memory/overview/PartCards";
import { ReceivedCardView, type WorkStyleRead } from "@/components/memory/overview/ReceivedCard";
import {
  aboutYouCard, growthEvents, growthOf, knowledgeCard, methodsCard, needsLook, overviewHeadline, partAddress, projectsCard, readable, receivedCard, recentGains, workStyle,
  type OverviewDoc, type ReadPart,
} from "@/components/memory/overview/memoryOverviewModel";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { ChartGrid } from "@/components/ui/ChartGrid";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { dayIn } from "@/components/charts/map/zone";
import { formatDay } from "@/lib/format";
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
 * 「总览」: the capsule as one picture, from the first day (R: memory-capsule rectification, plan §6; research report H §4). It leads 记忆胶囊
 * and is where `/app/memory` lands: one sentence whose numbers link to their parts, six cards of one grammar — 成长 (the strip of what the
 * capsule gained), 关于你, 项目, 我的做法, 知识, 收到的 (with the 工作方式卡 of what this account could hand over) — and a short list of what
 * needs a look. The map is what each card drills into, narrowed to its part.
 *
 * Every card reads and fails on its own: the map's document answers for five of them (and says which of its sources failed, so a card whose
 * source failed says so instead of drawing zero), the received packs and the hand-over card each have a read of their own. The sentence names
 * only what was read. A card with nothing yet is a recipe with one button, so the account whose memory is empty has a page with something
 * to do on it (the documents are there, the projects are there) and not three zeros. Marks open the same drawers as on the map and the lists.
 *
 * The page has no scope menu and no toolbar: it is the account's capsule, not a project's, and the band keeps the row it has on the tabs
 * that do (`toolbar={null}`). Header: the 记忆 switch, the 「⋯」, and 「记住这一条」 where the account's memory takes it.
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
  const native = doc?.engine === "native";

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
    recent: doc && growth && readable(doc, "growth") ? recentGains(events, growth.today) : null,
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

  return (
    <MemoryFrame
      tab="overview" map documentTitle="记忆胶囊总览" toolbar={null}
      actions={<MemoryHeaderActions native={native} onChanged={reloadAll} drawer={header} onDrawer={setHeader} />}
      headline={headline ? { parts: headline, id: "memory-overview-headline" } : undefined}
    >
      <div className="space-y-6">
        <ChartGrid rows={[
          [{ key: "growth", span: 2, node: (
            <GrowthCard
              state={growthState} growth={growth} events={events} timeZone={doc?.scope.timeZone ?? "UTC"} errorMessage={failure}
              onRetry={() => { map.reload(); received.reload(); learned.reload(); }} onChat={toChat}
              onOpen={(target, event) => {
                if (target) open(target);
                else if (event.lane === "documents") navigate(partAddress("knowledge"));
                else if (event.lane === "received") setHeader({ kind: "share", tab: "import" });
                else navigate(partAddress("you"));
              }}
            />
          ) }],
          [
            { key: "you", node: <AboutYouCardView state={stateOf("memories")} card={you} native={native} errorMessage={failure} onRetry={map.reload} onOpen={open} onRemember={() => setHeader({ kind: "remember" })} onChat={toChat} /> },
            { key: "projects", node: <ProjectsCardView state={stateOf("projects")} card={projects} errorMessage={failure} onRetry={map.reload} onChat={toChat} /> },
          ],
          [
            { key: "methods", node: <MethodsCardView state={learned.data ? "content" : learned.failed ? "error" : "loading"} card={methods} errorMessage="暂时读不到学到的做法。" onRetry={learned.reload} onOpen={open} onChat={toChat} /> },
            { key: "knowledge", node: <KnowledgeCardView state={stateOf("knowledge")} card={knowledge} errorMessage={failure} onRetry={map.reload} onUpload={() => navigate("/app/files")} /> },
          ],
          [{ key: "received", span: 2, node: (
            <ReceivedCardView
              state={received.data ? "content" : received.failed ? "error" : "loading"} card={receivedView} workStyle={handoverRead} errorMessage="暂时读不到收到的胶囊。"
              onRetry={received.reload} onRetryWorkStyle={handover.reload} onChanged={received.reload}
              onImport={() => setHeader({ kind: "share", tab: "import" })} onShare={() => setHeader({ kind: "share", tab: "export" })}
            />
          ) }],
        ]} />
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
      </div>
      {drawer.value && (
        <MapDrawer
          open={drawer.value} projectName={projectName} onClose={drawer.close} onChanged={reloadAll}
          onOpenRecord={(id) => drawer.open(`record:${id}`)} canOpenRecord={() => true}
        />
      )}
    </MemoryFrame>
  );
}
