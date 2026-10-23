import { useState } from "react";
import { Link, useLocation } from "react-router";
import {
  getGeoAnalysisMembers,
  type GeoAnalysisMembers,
  type GeoAnalysisMemberItem,
} from "@/lib/geoAnalysisClient";
import { FactList } from "@/components/ui/FactList";
import { EmptyState } from "@/components/cards/EmptyState";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { Disclosure } from "@/components/ui/Disclosure";
import { useGeoLoad } from "./geoProjectData";
import { useGeoFrame } from "./geoFrame";
import { answerPath } from "./tabs/geoTabText";
import { useGeoPath } from "./useGeoPath";
import { engineName } from "./geoText";
const units: Record<string, string> = {
  answers: "回答",
  asks: "采集任务",
  questions: "问题",
  statements: "陈述",
  records: "记录",
};
export function GeoAnalysisMembersDrawer({
  geoId,
  members,
  onClose,
}: {
  geoId: string;
  members: GeoAnalysisMembers;
  onClose(): void;
}) {
  const frame = useGeoFrame(),
    [offset, setOffset] = useState(0);
  const { state, reload } = useGeoLoad(
    `analysis-members:${geoId}:${JSON.stringify(members)}:${offset}`,
    () => getGeoAnalysisMembers(geoId, members, offset),
  );
  const refresh = () => {
    frame?.refreshScope?.();
    onClose();
  };
  return (
    <Drawer title={`${units[members.unit] ?? "记录"}明细`} onClose={onClose}>
      {state.kind === "loading" ? (
        <FilesSkeleton />
      ) : state.kind === "error" ? (
        state.stale ? (
          <Note
            tone="warn"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                更新分析
              </Button>
            }
          >
            这批数据已有更新，请重新查看分析。
          </Note>
        ) : (
          <LoadError message={state.message} onRetry={reload} />
        )
      ) : (
        <div className="flex flex-col gap-4">
          <Note
            result={[
              "共 ",
              { n: state.data.total },
              ` 个${units[state.data.unit] ?? "记录"}，显示 `,
              { n: offset + 1 },
              " 至 ",
              { n: offset + state.data.items.length },
              " 个。",
            ]}
          />
          {state.data.items.length ? (
            state.data.items.map((item) => (
              <Member key={item.id} geoId={geoId} item={item} />
            ))
          ) : (
            <EmptyState title="这个分类没有记录" />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一批
            </Button>
            {state.data.nextOffset !== null && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setOffset(state.data.nextOffset!)}
              >
                下一批
              </Button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
function Member({
  geoId,
  item,
}: {
  geoId: string;
  item: GeoAnalysisMemberItem;
}) {
  const contextPath = useGeoPath();
  const location = useLocation(),
    question = item.question ?? item;
  return (
    <article className="flex flex-col gap-2">
      <p className="text-ui">
        {item.statement?.text ?? question.text ?? "采集任务"}
      </p>
      <p className="text-caption text-text-3">
        {[
          item.engine ? engineName(item.engine) : null,
          item.roundId,
          item.repeatIndex != null ? `第 ${item.repeatIndex + 1} 次` : null,
          item.askedAt ?? item.answer?.asked_at ?? "采样时间未知",
          item.status,
          item.reason,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {(question.originalId != null || question.originalRow != null) && (
        <FactList
          rows={[
            { label: "原始编号", value: question.originalId ?? "未记录" },
            { label: "原始行", value: question.originalRow ?? "未记录" },
            { label: "原分类", value: question.originalGroup ?? "未分类" },
            {
              label: "客户标签",
              value: question.clientTags?.join("、") || "未标注",
            },
          ]}
        />
      )}
      {item.statement && (
        <FactList
          rows={[
            {
              label: "判定",
              value:
                (
                  {
                    correct: "正确",
                    wrong: "错误",
                    unverifiable: "无法核实",
                  } as Record<string, string>
                )[item.statement.verdict] ?? "未知",
            },
            { label: "主张版本", value: item.statement.claimVersion ?? "未知" },
            {
              label: "临床条件",
              value: JSON.stringify(item.statement.applicability ?? null),
            },
            { label: "引文依据", value: item.statement.evidence ?? "未保留" },
          ]}
        />
      )}
      {item.unit === "asks" && item.roundId && (
        <Link
          className="text-accent"
          to={contextPath(
            `/app/geo/${encodeURIComponent(geoId)}/questions?diagnosisRound=${encodeURIComponent(item.roundId)}`,
          )}
        >
          查看采集进度与恢复选项
        </Link>
      )}
      {item.snapshotId && (
        <Link
          className="text-accent"
          to={`${answerPath(geoId, item.snapshotId)}${location.search}`}
        >
          查看原始回答与依据
        </Link>
      )}
      {item.answer && (
        <Disclosure summary="完整回答与引用">
          <p className="whitespace-pre-wrap text-ui">
            {item.answer.answer_text}
          </p>
          <FactList
            rows={[
              { label: "采样方式", value: JSON.stringify(item.answer.surface) },
            ]}
          />
          {item.answer.citations?.map((citation, index) =>
            safeCitationUrl(citation.url) ? (
              <a
                key={index}
                className="block text-accent"
                href={citation.url}
                target="_blank"
                rel="noreferrer"
              >
                {citation.url}
              </a>
            ) : null,
          )}
        </Disclosure>
      )}
    </article>
  );
}

function safeCitationUrl(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
