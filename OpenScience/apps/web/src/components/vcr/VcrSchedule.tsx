import { soaDayText, soaWindowText } from "@evimed/domain";
import type { VcrSchedule, VcrScheduleVisit } from "@/lib/vcrClient";
import { Card } from "@/components/ui/Card";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";

/** What is done at a visit, the way a protocol's table prints it: the names in order, an activity's note beside it. */
const activitiesText = (visit: VcrScheduleVisit): string =>
  visit.procedures.map((entry) => (entry.note ? `${entry.name}（${entry.note}）` : entry.name)).join("、");

const COLUMNS: Array<DataColumn<VcrScheduleVisit>> = [
  {
    key: "visit",
    header: "访视",
    rowHeader: true,
    cell: (visit) => (
      <span className="flex flex-col gap-0.5">
        <span className="text-text">{visit.visit}</span>
        {visit.note && <span className="text-caption text-text-3">{visit.note}</span>}
      </span>
    ),
  },
  {
    key: "day",
    header: "计划日",
    isEmpty: (visit) => visit.day === null,
    cell: (visit) => <span className="whitespace-nowrap tabular-nums text-text-2">{soaDayText(visit.day)}</span>,
  },
  {
    key: "window",
    header: "窗口",
    isEmpty: (visit) => visit.windowDays === null,
    cell: (visit) => <span className="whitespace-nowrap tabular-nums text-text-2">{soaWindowText(visit.windowDays)}</span>,
  },
  {
    key: "activities",
    header: "评估与操作",
    cell: (visit) => <span className="text-text">{activitiesText(visit)}</span>,
  },
];

/**
 * 访视日程: the protocol's visits, by day, with the window around each and what is done at it — a record of the protocol, written by
 * the conversation, never a result of a computation, so it carries no source label and no number to click. It is drawn only while the
 * study has one: a card titled 「访视日程」 over 「还没有」 is a title over an empty box.
 */
export function VcrScheduleCard({ schedule }: { schedule: VcrSchedule }) {
  const { totals } = schedule;
  return (
    <Card
      padding="p-3"
      header={(
        <div className="flex items-center gap-2">
          <h2 className="text-ui font-semibold text-text">访视日程</h2>
          {schedule.protocolVersion !== null && <Tag>{`方案 v${schedule.protocolVersion}`}</Tag>}
        </div>
      )}
    >
      <div data-vcr-schedule="">
        <DataTable
          label="访视日程"
          ground="surface"
          columns={COLUMNS}
          rows={schedule.visits}
          rowKey={(visit) => visit.visit}
          rowAttrs={(visit) => ({ "data-vcr-visit": visit.visit })}
          footnote={`共 ${totals.visits} 次访视，涉及 ${totals.activities} 项评估与操作`}
        />
      </div>
    </Card>
  );
}
