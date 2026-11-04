import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { VCR_MATCH_STANCE_LABELS_ZH } from "@evimed/domain";
import { cancelVcrJob, startVcrJudge, VCR_VERDICTS, type VcrJudgedFunnelRow, type VcrJudgedPair, type VcrJudgedProtocol, type VcrStudy, type VcrVerdict } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { useWide } from "@/lib/useMediaQuery";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { Tag } from "@/components/ui/Tag";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrFunnelBar } from "../VcrDiagrams";
import { fitText, JudgedPairDetail, VerdictTag } from "./JudgedPair";
import { JudgedFailures, JudgedProgressNote } from "./JudgedProgress";
import { MatchingExport } from "./MatchingExport";

const COLUMNS = "md:grid md:grid-cols-[minmax(0,1.3fr)_6rem_minmax(0,1.1fr)_3.5rem_3.5rem_3.5rem] md:items-center md:gap-x-4";
const FUNNEL_COLUMNS = "md:grid md:grid-cols-[3rem_minmax(0,1.6fr)_4rem_4.5rem_4rem_4rem] md:items-start md:gap-x-4";
/** The hatch that means 「还没定」, the one the platform's other charts use for it. */
const UNDECIDED_HATCH = "repeating-linear-gradient(135deg, var(--warn) 0 3px, var(--warn-soft) 3px 7px)";

/** The clause a funnel row is about, shortened to a line. */
const brief = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A person in the table: a button for the key (the keyboard's way in), and the whole row takes a press. */
function PersonRow({ person, current, onPick }: { person: VcrJudgedPair; current: boolean; onPick: () => void }) {
  const counts = person.counts;
  const cell = (value: number | undefined) => (value === undefined ? "—" : String(value));
  return (
    <li
      data-vcr-person={person.subjectKey}
      className={cn("relative flex flex-wrap items-center gap-x-3 gap-y-1 rounded border-b border-border px-2 py-2.5 hover:bg-surface-2", current && "bg-accent-soft", COLUMNS)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* The key is the row's button, and its hit area is the whole row: one control to reach by keyboard, the row to press with a pointer. */}
        <button type="button" aria-current={current ? "true" : undefined} onClick={onPick} className="rounded text-left text-ui font-semibold text-text after:absolute after:inset-0">{person.label}</button>
        {person.basisChanged && <Tag tone="warn">{person.basisChanged.kind === "registry_record" ? person.basisChanged.label : "病历已更新"}</Tag>}
      </div>
      <VerdictTag pair={person} />
      <span className="text-caption text-text-2">{fitText(person) || "—"}</span>
      <div className="flex gap-4 text-caption tabular-nums text-text-2 max-md:basis-full md:contents">
        <span><span className="md:hidden">满足 </span>{cell(counts?.support)}</span>
        <span className={cn(counts && counts.against > 0 && "text-danger-strong")}><span className="md:hidden">不满足 </span>{cell(counts?.against)}</span>
        <span><span className="md:hidden">待查 </span>{cell(counts?.open)}</span>
      </div>
      {person.why && <p className="min-w-0 basis-full truncate text-caption text-text-3 md:col-span-full">{person.why}</p>}
    </li>
  );
}

/** One clause of the protocol: who it satisfies, who it disqualifies, who the record is silent on, who it leaves open. */
function FunnelRow({ row, people }: { row: VcrJudgedFunnelRow; people: number }) {
  const undecided = row.silent + row.open;
  const share = (value: number) => `${people > 0 ? (value / people) * 100 : 0}%`;
  return (
    <li data-vcr-funnel-clause={row.number} className={cn("flex flex-col gap-1 border-b border-border py-2.5", FUNNEL_COLUMNS)}>
      <div className="flex items-baseline gap-2 text-caption text-text-3 md:flex-col md:gap-0">
        <span className="tabular-nums">{row.number}</span>
        <span>{row.kind === "exclusion" ? "排除" : "入选"}</span>
      </div>
      <div className="min-w-0">
        <p className="text-ui text-text">{row.clause}</p>
        <span
          role="img"
          aria-label={`${row.clause}：不满足 ${row.against}，未见记载 ${row.silent}，待查 ${row.open}，满足 ${row.support}`}
          data-forced-colors="preserve"
          className="mt-1.5 flex h-2 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <span className="h-2 bg-text-2" style={{ width: share(row.against) }} />
          <span className="h-2" style={{ width: share(undecided), backgroundImage: UNDECIDED_HATCH }} />
        </span>
      </div>
      <div className="flex gap-4 text-caption tabular-nums text-text-2 md:contents">
        <span className={cn(row.against > 0 && "text-danger-strong")}><span className="md:hidden">不满足 </span>{row.against}</span>
        <span><span className="md:hidden">未见记载 </span>{row.silent}</span>
        <span><span className="md:hidden">待查 </span>{row.open}</span>
        <span><span className="md:hidden">满足 </span>{row.support}</span>
      </div>
    </li>
  );
}

/**
 * 给试验找患者, once the model has judged people against the protocol: every person in a paged table, filtered by verdict, and for each clause
 * how many people it satisfies, disqualifies, finds the record silent on or leaves open — the clause that loses the most people first.
 *
 * Hidden knowledge:
 *  - **The table is every person, a page at a time** (the server cuts and orders it; five thousand people are not five thousand rows in the
 *    page). The verdict filter and the page are the tab's, so the band carries the filter and a reload keeps both.
 *  - **The clause table counts the people judged clause by clause**, and says how many that is: a person with only a trial-level score
 *    is in the table above and not in these counts. It is the answer to which clause loses the most candidates; it is not a funnel of
 *    recruitment and counts nobody who has been contacted.
 *  - **Starting and stopping are this job's.** The judging starts from the band's 「开始评估」; the note here says how far it is, what it
 *    has cost, and stops this job, not the study.
 *  - A person opens in a drawer on a narrow page and beside the table on a wide one, as a trial does for a patient.
 */
export function MatchingPeople({ studyId, study, judged, verdict, onVerdict, onPage, picked, onPick, onPatient, onChanged }: {
  studyId: string;
  study: VcrStudy;
  judged: VcrJudgedProtocol;
  verdict: VcrVerdict | null;
  onVerdict: (next: VcrVerdict | null) => void;
  onPage: (offset: number) => void;
  picked: string | null;
  onPick: (key: string | null) => void;
  /** Go to this patient's trials: the other direction, opened on the same person. */
  onPatient: (key: string) => void;
  onChanged: () => void;
}) {
  const [working, setWorking] = useState(false);
  const wide = useWide();
  const mayRun = study.abilities.includes("run") && study.abilities.includes("read_patient_level");
  const { progress, tallies, clauses, selected, people } = judged;
  const shown = useShowMore(clauses.rows, { first: 8, step: 8, resetKey: judged.protocolVersionId });
  const all = VCR_VERDICTS.reduce((sum, key) => sum + tallies[key], 0);
  const open = (key: VcrVerdict) => ({ n: tallies[key], onOpen: () => onVerdict(key), label: `${tallies[key]} 位，只看这些` });

  const act = (work: () => Promise<unknown>, failure: string) => {
    if (working) return;
    setWorking(true);
    void work().then(onChanged).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure }))).finally(() => setWorking(false));
  };
  const resume = () => act(() => startVcrJudge(studyId, { direction: "trial_to_patient", protocolVersionId: judged.protocolVersionId, resume: true }), "暂时无法继续判定，请稍后重试。");
  const stop = () => { if (progress.jobId) act(() => cancelVcrJob(studyId, progress.jobId!), "暂时无法停止，请稍后重试。"); };

  const first = judged.total === 0 ? 0 : judged.offset + 1;
  const last = judged.offset + people.length;
  const top = clauses.rows[0];
  const detail = selected && picked === selected.subjectKey
    ? (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-ui font-semibold text-text">{selected.label}</h3>
          <Button variant="text" size="sm" onClick={() => onPatient(selected.subjectKey)}>查看这位患者的全部试验</Button>
        </div>
        <JudgedPairDetail studyId={studyId} pair={selected} mayReadRecord={study.abilities.includes("read_patient_level")} subject={selected.subjectKey} showTitle={false} compact />
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {all > 0 && (
          <Note result={["已判定 ", { n: all }, " 位患者：符合 ", open("eligible"), " 位，可能符合 ", open("possible"), " 位，证据不足 ", open("insufficient"), " 位，不符合 ", open("ineligible"), " 位。"]} />
        )}
        <VcrFunnelBar eligible={tallies.eligible} insufficient={tallies.possible + tallies.insufficient} ineligible={tallies.ineligible} />
        <JudgedProgressNote progress={progress} noun="位患者" mayRun={mayRun} busy={working} onResume={resume} onStop={stop} />
        <JudgedFailures failures={judged.failed} noun="位患者" titled={false} />
      </div>

      {clauses.rows.length > 0 && (
        <Section title="各条款的情况" count={`${clauses.rows.length} 条`}>
          <div className="flex flex-col gap-3">
            {top && top.against > 0
              ? <Note result={["按逐条判定的 ", { n: clauses.judgedPeople }, " 位患者计，淘汰最多的是第 ", { n: top.number }, ` 条（${brief(top.clause)}），`, { n: top.against }, " 位不满足。"]} />
              : <Note result={["按逐条判定的 ", { n: clauses.judgedPeople }, " 位患者计，没有哪一条明确淘汰了谁。"]} />}
            <div>
              <div aria-hidden="true" className={cn("border-b border-border pb-2 text-caption text-text-3 max-md:hidden", FUNNEL_COLUMNS)}>
                <span>条款</span><span>入排原文</span><span>{VCR_MATCH_STANCE_LABELS_ZH.against}</span><span>{VCR_MATCH_STANCE_LABELS_ZH.silent}</span><span>{VCR_MATCH_STANCE_LABELS_ZH.open}</span><span>{VCR_MATCH_STANCE_LABELS_ZH.support}</span>
              </div>
              <ol aria-label="各条款的情况">
                {shown.visible.map((row) => <FunnelRow key={row.number} row={row} people={clauses.judgedPeople} />)}
              </ol>
              <ShowMore remaining={shown.remaining} unit="条" onMore={shown.more} />
            </div>
          </div>
        </Section>
      )}

      <Section
        title="患者"
        count={verdict ? `${judged.total} / ${all}` : judged.total}
        toolbar={<MatchingExport studyId={studyId} where={{ direction: "trial_to_patient", protocolVersionId: judged.protocolVersionId }} abilities={study.abilities} />}
      >
        <div className={cn("grid grid-cols-1 gap-4", selected && wide && "xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]")}>
          <div className="min-w-0">
            {people.length > 0
              ? (
                <>
                  <div aria-hidden="true" className={cn("border-b border-border px-2 pb-2 text-caption text-text-3 max-md:hidden", COLUMNS)}>
                    <span>患者</span><span>结论</span><span>匹配度</span><span>满足</span><span>不满足</span><span>待查</span>
                  </div>
                  <ul aria-label="患者名单">
                    {people.map((person) => <PersonRow key={person.subjectKey} person={person} current={picked === person.subjectKey} onPick={() => onPick(person.subjectKey)} />)}
                  </ul>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-caption tabular-nums text-text-3">{`第 ${first}–${last} 位，共 ${judged.total} 位`}</span>
                    <span className="flex items-center gap-1">
                      <IconButton icon={ChevronLeft} label="上一页" size="sm" disabled={judged.offset === 0} onClick={() => onPage(Math.max(0, judged.offset - judged.limit))} />
                      <IconButton icon={ChevronRight} label="下一页" size="sm" disabled={!judged.more} onClick={() => onPage(judged.offset + judged.limit)} />
                    </span>
                  </div>
                </>
              )
              : <EmptyState title={verdict ? "没有这个结论的患者" : "还没有判完的患者"} action={verdict ? <Button variant="secondary" onClick={() => onVerdict(null)}>看全部</Button> : undefined} />}
          </div>
          {wide && detail && <Card>{detail}</Card>}
        </div>
        {!wide && detail && selected && <Drawer title={selected.label} onClose={() => onPick(null)} widthClassName="max-w-2xl">{detail}</Drawer>}
      </Section>
    </div>
  );
}
