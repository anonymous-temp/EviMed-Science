import { Link } from "react-router";
import { Check, Minus, X } from "lucide-react";
import type { GeoClusterView, GeoEngine } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import { List } from "@/components/ui/ListRow";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { engineName } from "../geoText";
import { answerPath } from "../tabs/geoTabText";
import { answerOf, answerStance, type AnswerStance } from "./clusterModel";

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  typical: "典型问句",
  real: "真实问法",
  label_safety: "说明书安全题",
  client: "客户提供",
});

const STANCE_WORDS: Readonly<Record<AnswerStance, string>> = Object.freeze({
  named: "提到了",
  wrong: "讲错了",
  silent: "没有提到",
  unmeasured: "没测",
});

/** The engine's name beside its mark, for the rows that have no header over them (a phone). */
function EngineWord({ engine }: { engine: string }) {
  return <span aria-hidden="true" data-geo-engine-word="" className="text-meta text-text-3 sm:hidden">{engineName(engine)}</span>;
}

function StanceMark({ stance }: { stance: AnswerStance }) {
  if (stance === "named") return <Check size={16} aria-hidden="true" className="text-accent" />;
  if (stance === "wrong") return <X size={16} aria-hidden="true" className="text-danger" />;
  if (stance === "silent") return <Minus size={16} aria-hidden="true" className="text-text-3" />;
  return <span aria-hidden="true" className="text-text-3">·</span>;
}

/**
 * The questions of a group, each with what every engine's latest answer did: named us ✓, misstated us ✗, did not name us –, not
 * asked ·. Each mark is the way to that answer. The same rows are in the group's drawer (all its measured questions) and in an
 * action's (the few it names): a question is one thing wherever it is listed.
 *
 * `menuFor` gives a row its 「⋯」; the engine in `focus` is the column the drawer rests on.
 *
 * From 640 px the rows are a table: the question, then one narrow column for each engine under a header that names them. Under it
 * (a phone's drawer is the width of the screen) the columns would leave the question a letter's width, so the question takes its
 * own line and its marks follow it, each with its engine's name beside it, and the header goes.
 */
export function QuestionRows({
  geoId,
  questions,
  engines,
  focus = null,
  menuFor,
  label = "测量问句",
}: {
  geoId: string;
  questions: readonly GeoClusterView["questions"][number][];
  engines: readonly GeoEngine[];
  focus?: string | null;
  menuFor?: (question: GeoClusterView["questions"][number]) => MenuItem[] | null;
  label?: string;
}) {
  if (questions.length === 0) return null;
  return (
    <div data-geo-cluster-questions="">
      <div className="flex items-end gap-1 px-2 pb-1 text-meta text-text-3 max-sm:hidden">
        <span className="min-w-0 flex-1">问句</span>
        {engines.map((engine) => (
          <span key={engine} className={cn("w-14 shrink-0 text-center", focus === engine && "font-semibold text-text")}>{engineName(engine)}</span>
        ))}
        {menuFor && <span className="w-8 shrink-0" />}
      </div>
      <List label={label} divided>
        {questions.map((question) => {
          const kind = KIND_WORDS[question.kind] ?? null;
          const items = menuFor?.(question) ?? null;
          return (
            <li key={question.id} data-geo-question={question.id} className="flex flex-wrap items-start gap-1 px-2 py-2 sm:flex-nowrap">
              <span className="min-w-0 flex-1 text-ui text-text max-sm:basis-full">
                {question.text}
                {kind && <span className="ml-2 text-caption text-text-3">{kind}</span>}
              </span>
              <span className="flex items-start gap-1 max-sm:w-full max-sm:flex-wrap max-sm:gap-x-3 sm:contents">
                {engines.map((engine) => {
                  const answer = answerOf(question, engine);
                  const stance = answerStance(answer);
                  const body = (
                    <>
                      <StanceMark stance={stance} />
                      <span className="sr-only">{`${engineName(engine)}：${STANCE_WORDS[stance]}${answer ? "，看回答" : ""}`}</span>
                    </>
                  );
                  return (
                    <span key={engine} className={cn("flex h-7 w-14 shrink-0 items-center justify-center rounded max-sm:w-auto max-sm:gap-1 max-sm:px-1", focus === engine && "bg-accent-soft")}>
                      {answer?.snapshotId
                        ? <Link to={answerPath(geoId, answer.snapshotId)} data-geo-answer-link={answer.snapshotId} className="flex h-7 w-full items-center justify-center gap-1 rounded hover:bg-surface-2">{body}<EngineWord engine={engine} /></Link>
                        : <>{body}<EngineWord engine={engine} /></>}
                    </span>
                  );
                })}
              </span>
              {menuFor && (
                <span className="flex w-8 shrink-0 justify-end max-sm:ml-auto">
                  {items && items.length > 0 && <Menu label={`“${question.text}”的操作`} items={items} />}
                </span>
              )}
            </li>
          );
        })}
      </List>
    </div>
  );
}
