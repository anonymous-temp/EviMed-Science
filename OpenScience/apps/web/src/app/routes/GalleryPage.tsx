import { useState } from "react";
import { STUDY_TYPE_BADGES } from "@evimed/design-tokens";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable } from "@/components/ui/DataTable";
import { Delta } from "@/components/ui/Delta";
import { FilterChips } from "@/components/ui/FilterChips";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SeverityBadge, type SeverityLevel } from "@/components/ui/SeverityBadge";
import { StatTile } from "@/components/ui/StatTile";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";

/**
 * The component gallery: every primitive, in every state it has, on one page.
 *
 * It is the second of the three mechanisms that keep two front ends looking
 * like one product (fusion plan §6.2). The token package makes them agree about
 * values; this page is where they are compared as pictures — CI screenshots it
 * and diffs against the reference, so changing a component's look is a review
 * with an image in it rather than a surprise three pages later.
 *
 * It is also the answer to a question a design system cannot answer in prose:
 * what a loading, empty and failed version of each thing looks like. Every row
 * below draws all of them, because a page that only ever ships its happy state
 * is how four-state discipline quietly stops being true.
 *
 * Not in production. The route is registered only outside a production build,
 * so it costs a reader nothing and cannot be linked to from the product.
 */
const SEVERITIES: SeverityLevel[] = ["S4", "S3", "S2", "S1", "S0"];

function Row({ name, note, children }: { name: string; note?: string; children: React.ReactNode }) {
  return (
    <section data-gallery-row={name} className="border-t border-border py-6 first:border-t-0">
      <h2 className="text-caption uppercase tracking-wide text-text-3">{name}</h2>
      {note && <p className="mt-1 max-w-measure text-caption text-text-3">{note}</p>}
      <div className="mt-3 flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

export function GalleryPage() {
  const [segment, setSegment] = useState("week");
  const [chips, setChips] = useState("all");
  const [tab, setTab] = useState("overview");
  const rivals = [
    { name: "信尔美（本品）", share: 31, rank: 1, ours: true },
    { name: "竞品甲", share: 24, rank: 2, ours: false },
    { name: "竞品乙", share: 18, rank: 3, ours: false },
    { name: "其他", share: 27, rank: 4, ours: false },
  ];

  return (
    <PageShell title="组件陈列" width="wide" documentTitle="组件陈列">
      <Row name="Button" note="主操作每屏一个；次要是白底一线；危险只用于确认删除。">
        <Button>主操作</Button>
        <Button variant="secondary">次要</Button>
        <Button variant="text">文本</Button>
        <Button loading>进行中</Button>
        <Button disabled>不可用</Button>
        <Button size="sm">小号</Button>
      </Row>

      <Row name="Tag / StudyType" note="研究类型各有一对颜色，读者在读到字之前就分得出指南和 RCT。">
        <Tag>普通</Tag>
        <Tag tone="safety">用药安全</Tag>
        {Object.entries(STUDY_TYPE_BADGES).map(([kind, badge]) => (
          <span
            key={kind}
            data-study-kind={kind}
            className="inline-flex h-tag items-center rounded-tag px-2 text-meta"
            style={{ color: `var(--study-${kind}-fg)`, background: `var(--study-${kind}-bg)` }}
          >{badge.label}</span>
        ))}
      </Row>

      <Row name="Tabs / Segmented / FilterChips">
        <Tabs
          label="示例页签"
          value={tab}
          onChange={setTab}
          items={[{ value: "overview", label: "总览" }, { value: "visibility", label: "可见度" }, { value: "accuracy", label: "准确与安全" }]}
        />
        <SegmentedControl
          aria-label="时间范围"
          value={segment}
          onChange={setSegment}
          options={[{ value: "week", label: "本周" }, { value: "month", label: "本月" }, { value: "quarter", label: "本季" }]}
        />
        <FilterChips
          label="资料状态"
          value={chips}
          onChange={setChips}
          options={[{ value: "all", label: "全部", count: 12 }, { value: "reading", label: "读取中", count: 2 }, { value: "failed", label: "没能读取", count: 1 }]}
        />
      </Row>

      <Row name="StatTile / Delta" note="指标带一次声明分母；名次和目标是让 31% 可读的东西。">
        <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile lead label="品牌提及率" value="31" unit="%" rank="第 1 / 4" delta={<Delta value={4.2} noise={2} />} note="目标 40%" hint="按 264 次有效回答计算" />
          <StatTile label="推荐位占比" value="18" unit="%" rank="第 2 / 4" delta={<Delta value={-0.4} noise={2} />} />
          <StatTile label="严重讲错" value="2" unit="条" tone="safety" delta={<Delta value={-1} polarity="down" />} />
          <StatTile label="豆包" value="未测" placeholder note="探测账号需重新登录" />
        </div>
        <div className="flex items-center gap-4">
          <Delta value={4.2} noise={2} />
          <Delta value={-3.1} noise={2} />
          <Delta value={0.6} noise={2} />
          <Delta value={-1} polarity="down" />
        </div>
      </Row>

      <Row name="ChartCard" note="标题是一句结论，不是「图 1」；四态齐备。">
        <ChartCard className="w-72" title="元宝对信尔美提及最多" meta="近 7 天" footnote="按 4 个引擎、264 次有效回答计算" height={120}>
          <div className="h-[120px] rounded bg-surface-1" />
        </ChartCard>
        <ChartCard className="w-72" title="加载中" state="loading" height={120} />
        <ChartCard className="w-72" title="还没有可画的数据" state="empty" emptyText="本周还没有测到" height={120} />
        <ChartCard className="w-72" title="没有读到" state="error" errorMessage="没有读到这张图的数据。" onRetry={() => {}} height={120} />
      </Row>

      <Row name="DataTable" note="我方是品牌蓝，对手一律灰阶；整列没有数据就不画这一列。">
        <DataTable
          label="同类药可见度"
          rows={rivals}
          rowKey={(row) => row.name}
          highlight={(row) => row.ours}
          columns={[
            { key: "rank", header: "名次", align: "right", width: "w-16", cell: (row) => row.rank },
            { key: "name", header: "品牌", rowHeader: true, cell: (row) => row.name },
            { key: "share", header: "提及份额", align: "right", cell: (row) => `${row.share}%` },
            { key: "gone", header: "空列（整列无数据，不画）", isEmpty: () => true, cell: () => "—" },
          ]}
        />
      </Row>

      <Row name="SeverityBadge" note="先说后果，等级只是跟在后面；红只给严重度和安全。">
        {SEVERITIES.map((level) => <SeverityBadge key={level} level={level} label />)}
      </Row>

      <Row name="ProgressRail" note="八步是页头的进度轨，不是导航。">
        <ProgressRail
          label="示例进度"
          className="w-full"
          steps={[
            { key: "a", name: "立项", note: "已确认", state: "done" },
            { key: "b", name: "诊断", note: "86 条事实", state: "done" },
            { key: "c", name: "内容", note: "32 篇", state: "active" },
            { key: "d", name: "投放", note: "待你确认预算", state: "waiting" },
            { key: "e", name: "复测", state: "todo" },
          ]}
        />
      </Row>

      <Row name="EmptyState / LoadError" note="空态一句话加一个动作；错误说人话并能重试。">
        <div className="w-72 rounded-card border border-border">
          <EmptyState title="还没有资料。" description="拖进来，或点右上角上传。" />
        </div>
        <LoadError className="w-72" message="暂时读不到记忆。" onRetry={() => {}} />
      </Row>
    </PageShell>
  );
}
