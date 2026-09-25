import { useState } from "react";
import { Download } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { downloadArtifact } from "@/lib/artifactFile";
import { getGeoJourney, type GeoJourney, type GeoProject } from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { GeoLineChart } from "./GeoCharts";
import { StepPending, TabError, TabSkeleton, TD, TH, useGeoLoad } from "./geoTabKit";

type View = "journey" | "care" | "people";

/**
 * 旅程 (plan §3.2, mockup g04). The full 12-stage × 15-line matrix is a file
 * the run wrote; the page carries only the four columns GEO uses — the
 * emotion, what the person is thinking, what they would ask an AI, where they
 * look for information — plus the care nodes with their red flags, and the
 * download of the full matrix.
 */
export function JourneyTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`journey:${geoId}`, () => getGeoJourney(geoId));
  const [view, setView] = useState<View>("journey");
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const journey = normalise(state.data);
  const hasPeople = journey.subtypes.length > 0 || journey.personas.length > 0;
  if (journey.stages.length === 0 && journey.careNodes.length === 0 && !hasPeople) {
    return <StepPending geoId={geoId} project={project} step="journey" />;
  }
  const options: FilterOption<View>[] = [
    { value: "journey", label: "旅程" },
    ...(journey.careNodes.length ? [{ value: "care" as const, label: "就医节点" }] : []),
    ...(hasPeople ? [{ value: "people" as const, label: "人群" }] : []),
  ];
  const current = options.some((option) => option.value === view) ? view : "journey";
  return (
    <div data-geo-tab="journey">
      <FilterChips
        label="旅程视图"
        options={options}
        value={current}
        onChange={setView}
        trailing={journey.files.slice(0, 2).map((file) => (
          <DownloadFile key={file.path} projectId={project.projectId} path={file.path} title={file.title || "完整旅程图"} />
        ))}
      />
      <div className="mt-6">
        {current === "journey" && <Stages stages={journey.stages} />}
        {current === "care" && <CareNodes nodes={journey.careNodes} />}
        {current === "people" && <People subtypes={journey.subtypes} personas={journey.personas} />}
      </div>
    </div>
  );
}

function normalise(raw: GeoJourney | null | undefined): GeoJourney {
  const list = <T,>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);
  return {
    subtypes: list(raw?.subtypes).filter((item) => typeof item === "string" && item),
    personas: list(raw?.personas).filter((item) => typeof item === "string" && item),
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
    <Button variant="text" onClick={download} loading={busy}>
      {!busy && <Download size={16} aria-hidden="true" />}
      {title}
    </Button>
  );
}

/** 「3/10」 or 「3」 in the emotion text, as a number on a 10-point scale. */
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
        <div className="mb-8 overflow-x-auto">
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
        </div>
      )}
      <div className="overflow-x-auto">
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
      </div>
    </>
  );
}

function CareNodes({ nodes }: { nodes: GeoJourney["careNodes"] }) {
  return (
    <ul className="flex flex-col divide-y divide-faint">
      {nodes.map((node, index) => (
        <li key={`${node.node}-${index}`} className="flex flex-col gap-2 py-4 sm:flex-row sm:gap-6">
          <span className="w-32 shrink-0 text-ui font-medium text-text">{node.node}</span>
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

function People({ subtypes, personas }: { subtypes: string[]; personas: string[] }) {
  return (
    <div className="flex flex-col gap-8">
      {subtypes.length > 0 && (
        <section aria-label="人群分型">
          <h2 className="mb-3 text-ui font-medium text-text">人群分型</h2>
          <ul className="flex flex-col gap-2">
            {subtypes.map((subtype, index) => <li key={index} className="max-w-measure text-ui text-text-2">{subtype}</li>)}
          </ul>
        </section>
      )}
      {personas.length > 0 && (
        <section aria-label="典型人物">
          <h2 className="mb-3 text-ui font-medium text-text">典型人物</h2>
          <ul className="flex flex-col gap-2">
            {personas.map((persona, index) => <li key={index} className="max-w-measure text-ui text-text-2">{persona}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
