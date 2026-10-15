import { useState } from "react";
import { Download } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { downloadArtifact } from "@/lib/artifactFile";
import { getGeoJourney, type GeoJourney, type GeoProject } from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import type { FilterOption } from "@/components/ui/FilterChips";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { useGeoToolbar } from "../geoFrame";
import { GeoLineChart } from "./GeoCharts";
import { StepPending, TabError, TabSkeleton, TD, TH, useGeoLoad } from "./geoTabKit";
import { ScrollRegion } from "@/components/ui/ScrollRegion";

type View = "journey" | "care" | "people";

/**
 * 旅程 (plan §3.2, mockup g04) — the view 「按旅程」 of 问题与回答 (R19 audit C A.2: step 2's home). The full 12-stage × 15-line
 * matrix is a file the run wrote; the page carries only the four columns GEO uses — the emotion, what the person is thinking, what
 * they would ask an AI, where they look for information — plus the care nodes with their red flags, and the download of the full
 * matrix, which is the toolbar's.
 *
 * Its own switch (旅程 · 就医节点 · 人群) joins the toolbar the page above hands in (`toolbar`: the page's view switch and what else it
 * has), so there is one row of controls and the journey's is the end of it.
 */
export function JourneyTab({ geoId, project, toolbar }: { geoId: string; project: GeoProject; toolbar?: ToolbarProps }) {
  const { state, reload } = useGeoLoad(`journey:${geoId}`, () => getGeoJourney(geoId));
  const [view, setView] = useState<View>("journey");
  const journey = state.kind === "ready" ? normalise(state.data) : null;
  const hasPeople = journey ? journey.subtypes.length > 0 || journey.personas.length > 0 : false;
  const empty = journey ? journey.stages.length === 0 && journey.careNodes.length === 0 && !hasPeople : false;
  const options: FilterOption<View>[] = journey
    ? [
      { value: "journey", label: "旅程" },
      ...(journey.careNodes.length ? [{ value: "care" as const, label: "就医节点" }] : []),
      ...(hasPeople ? [{ value: "people" as const, label: "人群" }] : []),
    ]
    : [];
  const current = options.some((option) => option.value === view) ? view : "journey";
  useGeoToolbar(journey && !empty
    ? {
      ...toolbar,
      filters: [
        ...(toolbar?.filters ?? []),
        // One way of seeing the journey is not a switch.
        ...(options.length > 1 ? [{ kind: "chips" as const, label: "旅程视图", options, value: current, onChange: (value: string) => setView(value as View) }] : []),
      ],
      actions: (
        <>
          {toolbar?.actions}
          {journey.files.slice(0, 2).map((file) => (
            <DownloadFile key={file.path} projectId={project.projectId} path={file.path} title={file.title || "完整旅程图"} />
          ))}
        </>
      ),
    }
    : toolbar ?? null);
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  if (!journey || empty) return <StepPending geoId={geoId} project={project} step="journey" />;
  return (
    <div data-geo-tab="journey">
      <div>
        {current === "journey" && <Stages stages={journey.stages} />}
        {current === "care" && <CareNodes nodes={journey.careNodes} />}
        {current === "people" && <People subtypes={journey.subtypes} personas={journey.personas} />}
      </div>
    </div>
  );
}

/** A subtype or persona as the page shows it: its name, then what the run said about it. */
type Person = { name: string; details: string[] };

/**
 * The server stores each entry as an object (`geoWrites.mjs` validatedJourney: name plus
 * definition/size/sizeQuality/note, or age/situation/voice/note); an older journey may still hold
 * plain strings. A field may be a string or a list of strings. An entry without a name is dropped.
 */
function person(value: unknown, fields: string[]): Person | null {
  if (typeof value === "string") return value.trim() ? { name: value.trim(), details: [] } : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const field = (key: string) => {
    const raw = entry[key];
    const parts = Array.isArray(raw) ? raw : [raw];
    return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).map((part) => part.trim()).join("；");
  };
  const name = field("name");
  if (!name) return null;
  return { name, details: fields.map((key) => key === "voice" && field(key) ? `“${field(key)}”` : field(key)).filter(Boolean) };
}

function normalise(raw: GeoJourney | null | undefined): Omit<GeoJourney, "subtypes" | "personas"> & { subtypes: Person[]; personas: Person[] } {
  const list = <T,>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);
  return {
    subtypes: list<unknown>(raw?.subtypes).map((item) => person(item, ["definition", "size", "sizeQuality", "note"])).filter((item): item is Person => item !== null),
    personas: list<unknown>(raw?.personas).map((item) => person(item, ["age", "situation", "voice", "note"])).filter((item): item is Person => item !== null),
    stages: list(raw?.stages).filter((stage) => stage && stage.stage).map((stage) => ({
      ...stage,
      questions: list(stage.questions),
      infoSources: list(stage.infoSources),
    })),
    careNodes: list(raw?.careNodes).filter((node) => node && node.node).map((node) => ({ ...node, redFlags: list(node.redFlags) })),
    files: list(raw?.files).filter((file) => file && file.path),
  };
}

/** The file is in the project's workspace: the shell moves to the project, then downloads. */
function DownloadFile({ projectId, path, title }: { projectId: string; path: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const download = () => {
    setBusy(true);
    void useProjectStore.getState().select(projectId)
      .then(() => downloadArtifact(path, "workspace"))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "文件暂时无法下载，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  return (
    <Button variant="text" size="sm" onClick={download} loading={busy}>
      {!busy && <Download size={16} aria-hidden="true" />}
      {title}
    </Button>
  );
}

/** “3/10” or “3” in the emotion text, as a number on a 10-point scale. */
function emotionScore(emotion: string | null | undefined): number | null {
  if (!emotion) return null;
  const match = /(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/.exec(emotion);
  if (!match) return null;
  const score = Number(match[1]);
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
}

function emotionText(emotion: string | null | undefined): string | null {
  if (!emotion) return null;
  const score = emotionScore(emotion);
  return score !== null && /^\s*\d+(?:\.\d+)?\s*(?:\/\s*10)?\s*$/.test(emotion) ? `情绪 ${score}/10` : emotion;
}

function Stages({ stages }: { stages: GeoJourney["stages"] }) {
  const scores = stages.map((stage) => emotionScore(stage.emotion));
  const charted = scores.filter((score) => score !== null).length >= 2;
  return (
    <>
      {charted && (
        <ScrollRegion label="用户旅程情绪曲线" className="mb-8">
          <GeoLineChart
            className="min-w-[40rem]"
            series={[{ key: "emotion", values: scores }]}
            labels={stages.map((stage) => stage.stage)}
            height={96}
            pointLabels
            axes={false}
            domain={[0, 10]}
            maxLabels={16}
          />
        </ScrollRegion>
      )}
      <ScrollRegion label="用户旅程各阶段">
        <table className="w-full min-w-[40rem] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 w-32 bg-bg`}>阶段</th>
              <th scope="col" className={TH}>在想什么</th>
              <th scope="col" className={TH}>会问 AI 的问题</th>
              <th scope="col" className={`${TH} w-40`}>从哪里看信息</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, index) => (
              <tr key={`${stage.stage}-${index}`} className="border-b border-faint">
                <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>
                  <span className="block">{stage.stage}</span>
                  {emotionText(stage.emotion) && <span className="block text-caption text-text-3">{emotionText(stage.emotion)}</span>}
                </th>
                <td className={TD}>{stage.thinking || "—"}</td>
                <td className={TD}>{stage.questions.length ? stage.questions.join("；") : "—"}</td>
                <td className={TD}>{stage.infoSources.length ? stage.infoSources.join("、") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </>
  );
}

function CareNodes({ nodes }: { nodes: GeoJourney["careNodes"] }) {
  return (
    <ul className="flex flex-col divide-y divide-faint">
      {nodes.map((node, index) => (
        <li key={`${node.node}-${index}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:gap-6">
          <span className="w-32 shrink-0 text-ui text-text">{node.node}</span>
          {node.redFlags.length > 0 ? (
            <ul className="flex min-w-0 max-w-measure flex-col gap-1">
              {node.redFlags.map((flag, flagIndex) => (
                <li key={flagIndex} className="text-ui text-text-2">{flag}</li>
              ))}
            </ul>
          ) : <span className="text-ui text-text-3">—</span>}
        </li>
      ))}
    </ul>
  );
}

function People({ subtypes, personas }: { subtypes: Person[]; personas: Person[] }) {
  return (
    <div className="flex flex-col gap-8">
      {subtypes.length > 0 && (
        <section aria-label="人群分型">
          <h2 className="mb-3 text-ui font-semibold text-text">人群分型</h2>
          <ul className="flex flex-col gap-2">
            {subtypes.map((subtype, index) => <PersonItem key={index} person={subtype} />)}
          </ul>
        </section>
      )}
      {personas.length > 0 && (
        <section aria-label="典型人物">
          <h2 className="mb-3 text-ui font-semibold text-text">典型人物</h2>
          <ul className="flex flex-col gap-2">
            {personas.map((persona, index) => <PersonItem key={index} person={persona} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function PersonItem({ person: entry }: { person: Person }) {
  return (
    <li className="max-w-measure text-ui text-text-2">
      <span className="text-text">{entry.name}</span>
      {entry.details.length > 0 && <span className="block text-caption text-text-3">{entry.details.join(" · ")}</span>}
    </li>
  );
}
