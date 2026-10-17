import { useEffect, useState, type ReactNode } from "react";
import { Copy, Download, FileText, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { STUDY_TYPE_BADGES } from "@evimed/design-tokens";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable } from "@/components/ui/DataTable";
import { Delta } from "@/components/ui/Delta";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChip, FilterChips } from "@/components/ui/FilterChips";
import { IconButton, iconButtonClasses } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { List, ListHeader, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { SearchInput } from "@/components/ui/SearchInput";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SeverityBadge, type SeverityLevel } from "@/components/ui/SeverityBadge";
import { StatTile } from "@/components/ui/StatTile";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { Toaster } from "@/components/ui/Toaster";
import { Tooltip } from "@/components/ui/Tooltip";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton, MemorySkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { ClaimCitation } from "@/components/markdown-viewer/ClaimCitation";
import { SourceCard } from "@/components/report/SourceCards";
import { RunStatusDot } from "@/components/runs/RunStatusDot";
import type { ClaimEvidence } from "@/lib/claimCitations";
import { RUN_STATE_LABEL } from "@/lib/runPresentation";
import { toast, useToastStore } from "@/lib/toast";

/**
 * The component gallery: every primitive, in every state it has, on one page.
 *
 * It is the second of the three mechanisms that keep two front ends looking
 * like one product (fusion plan §6.2). The token package makes them agree about
 * values; this page is where they are compared as pictures — CI screenshots it
 * in both themes and diffs against the references, so changing a component's
 * look is a review with an image in it rather than a surprise three pages
 * later.
 *
 * It is also the answer to a question a design system cannot answer in prose:
 * what a loading, empty and failed version of each thing looks like. Every row
 * below draws all of them, because a page that only ever ships its happy state
 * is how four-state discipline quietly stops being true.
 *
 * The overlays — a dialog, a drawer, the toasts — are fixed-position layers
 * that would cover the page, so each is drawn inside a box with a transform:
 * a transformed ancestor is the containing block of its fixed descendants,
 * which keeps them in their row and in the photograph.
 *
 * Not in production. The route is registered only outside a production build
 * (and in the one CI builds to photograph it), so it costs a reader nothing
 * and cannot be linked to from the product.
 */
const SEVERITIES: SeverityLevel[] = ["S4", "S3", "S2", "S1", "S0"];

function Row({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <section data-gallery-row={name} className="border-t border-border py-6 first:border-t-0">
      <h2 className="text-caption text-text-3">{name}</h2>
      {note && <p className="mt-1 max-w-measure text-caption text-text-3">{note}</p>}
      <div className="mt-3 flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

/** A box its fixed-position children are positioned in (see above). */
function Stage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-label={label} role="group" className="relative h-72 w-full overflow-hidden rounded-card border border-border bg-bg [transform:translateZ(0)]">
      {children}
    </div>
  );
}

const CLAIMS = new Map<string, ClaimEvidence>([
  ["CLM-001", {
    claimId: "CLM-001",
    claim: "低剂量阿司匹林用于一级预防，出血风险高于获益。",
    claimType: "direct",
    sourceTitle: "Aspirin in the Primary Prevention of Cardiovascular Disease",
    sourceType: "rct",
    identifier: "PMID:30221597",
    supportQuote: "major hemorrhage was higher in the aspirin group",
  }],
  ["CLM-002", {
    claimId: "CLM-002",
    claim: "老年人群的绝对获益更小。",
    claimType: "synthesized",
    sourceTitle: "Aspirin for primary prevention: a meta-analysis",
    sourceType: "meta-analysis",
    supportQuote: "net benefit was not observed in adults over 70",
  }],
]);
const VERIFIED = new Map([["CLM-001", "verified"]]);
const PENDING = new Map([["CLM-002", "quote_not_found"]]);

/** Seeds the toaster once, and stops the timers: a photograph cannot wait for a toast. */
function useGalleryToasts() {
  useEffect(() => {
    const store = useToastStore.getState();
    if (store.toasts.length > 0) return;
    toast.success("已归档对话", { action: { label: "撤销", onClick: () => {} } });
    toast.error("无法下载报告：网络中断");
    for (const { id } of useToastStore.getState().toasts) useToastStore.getState().pause(id);
  }, []);
}

export function GalleryPage() {
  const [segment, setSegment] = useState("week");
  const [chips, setChips] = useState("all");
  const [tab, setTab] = useState("overview");
  const [memory, setMemory] = useState(true);
  useGalleryToasts();
  const rivals = [
    { name: "信尔美（本品）", share: 31, rank: 1, ours: true },
    { name: "竞品甲", share: 24, rank: 2, ours: false },
    { name: "竞品乙", share: 18, rank: 3, ours: false },
    { name: "其他", share: 27, rank: 4, ours: false },
  ];

  return (
    <PageShell title="组件陈列" width="wide" documentTitle="组件陈列">
      <Row name="Button" note="高 28 / 36 / 44。主操作每屏一个；次要是浅灰底、无边框；危险只用于确认删除。">
        <Button>主操作</Button>
        <Button variant="secondary">次要</Button>
        <Button variant="text">文本</Button>
        <Button variant="text" destructive>移除</Button>
        <Button variant="danger">删除</Button>
        <Button loading>正在保存</Button>
        <Button disabled>不可用</Button>
        <Button size="sm">小号</Button>
        <Button size="lg">登录</Button>
      </Row>

      <Row name="IconButton" note="列表行内 28，页头与侧栏 36；名字即工具提示。">
        <IconButton icon={Copy} label="复制 DOI" size="sm" />
        <IconButton icon={Download} label="下载报告" size="sm" />
        <IconButton icon={Trash2} label="删除这条记忆" size="sm" destructive />
        <IconButton icon={RefreshCw} label="刷新" />
        <IconButton icon={Pencil} label="编辑" active />
        <IconButton icon={FileText} label="不可用" disabled />
      </Row>

      <Row name="Tooltip" note="悬停 300 ms 或键盘聚焦时出现，离开 100 ms 后消失，Esc 关闭；反色小浮层，只放纯文字。">
        {/* Open from the first render, so the photograph has it; the room
            above the button is the tooltip's. */}
        <div className="pt-10">
          <Tooltip content="复制 DOI" kind="label" defaultOpen>
            <button type="button" aria-label="复制 DOI" className={iconButtonClasses({ size: "sm" })}>
              <Copy size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </Row>

      <Row name="Input / SearchInput" note="输入框 36；表格与工具条里 28。焦点是边框加 1 px 内线，一条轮廓。">
        <div className="w-64"><Input label="项目名称" defaultValue="阿司匹林一级预防" /></div>
        <div className="w-64"><Input label="DOI" placeholder="例：10.1136/bmj.a2752" error="这不是一个 DOI" /></div>
        <div className="w-64"><Input label="已锁定" defaultValue="只读" disabled /></div>
        <SearchInput label="搜索工具" />
        <SearchInput label="搜索记忆" size="sm" className="w-48" />
      </Row>

      <Row name="Tag / StudyType" note="标签高 22。研究类型各有一对颜色，读者在读到字之前就分得出指南和 RCT。">
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

      <Row name="Tabs / Segmented / FilterChips" note="胶囊高 28、13 px；分段控件随所在行 36 或 28。">
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
        <SegmentedControl
          aria-label="视图"
          size="sm"
          value="list"
          onChange={() => {}}
          options={[{ value: "list", label: "列表" }, { value: "grid", label: "网格" }]}
        />
        <FilterChips
          label="资料状态"
          value={chips}
          onChange={setChips}
          options={[{ value: "all", label: "全部", count: 12 }, { value: "reading", label: "正在读取", count: 2 }, { value: "failed", label: "无法读取", count: 1 }]}
          trailing={<FilterChip pressed>收藏</FilterChip>}
        />
      </Row>

      <Row name="Switch / Disclosure / Menu" note="开关靠位置表达状态；全产品只有一种折叠；菜单常显“⋯”。">
        <Switch label="记忆" showLabel checked={memory} onChange={setMemory} />
        <Switch label="不可用" showLabel checked={false} onChange={() => {}} disabled />
        <Disclosure summary="27 次工具调用 · 4 条消息">展开后是完整过程。</Disclosure>
        <Menu label="更多操作" items={[{ label: "重命名", onSelect: () => {} }, "separator", { label: "删除", destructive: true, onSelect: () => {} }]} />
      </Row>

      <Row name="ListRow / RunStatusDot" note="同类的东西用列表；未读标题 600；状态说三遍：形状、颜色、文字。能按的行行尾有标记，数字对齐成列。">
        <div className="w-full max-w-page">
          <List label="示例列表" divided>
            <ListRow
              title="阿司匹林一级预防的研究已完成"
              to="/__gallery"
              unread
              leading={<RunStatusDot state="done" />}
              meta="疳证 Meta 文献检索 · 9月26日"
              actions={<IconButton icon={Pencil} label="编辑这条通知" size="sm" />}
              menu={<Menu label="更多操作" items={[{ label: "标为已读", onSelect: () => {} }]} />}
            />
            <ListRow title="周报已生成" to="/__gallery" leading={<RunStatusDot state="review" />} meta="信尔美 · 9月25日" />
            <ListRow title="孟德尔随机化分析" to="/__gallery" muted leading={<RunStatusDot state="failed" />} meta="未完成 · 2025-12-31" />
          </List>
        </div>
        <div className="w-full max-w-page">
          {/* What a row does decides its mark; the row that does nothing has none and no hover. Hover is drawn on one row by its class. */}
          <List label="行的状态" divided>
            <ListRow title="打开抽屉或页面" onOpen={() => {}} meta="行尾 ›" />
            <ListRow title="悬停的行" onOpen={() => {}} className="bg-surface-2" meta="悬停 surface-2" />
            <ListRow title="选中的行" onOpen={() => {}} selected meta="选中 accent-soft，aria-current" />
            <ListRow title="就地展开，已收起" onOpen={() => {}} expanded={false} meta="行尾 ⌄" />
            <ListRow title="就地展开，已展开" onOpen={() => {}} expanded meta="⌄ 翻转；展开的内容回答这一行写出的数字" />
            <ListRow title="去外面的地址" href="https://example.org" meta="新标签页，行尾 ↗" />
            <ListRow title="返回上级" onOpen={() => {}} chevron={false} meta="按下不是打开什么：不画标记" />
            <ListRow title="只是一行" meta="没有标记，没有悬停" trailing={<span>10月8日</span>} />
          </List>
        </div>
        <div className="w-full max-w-page">
          {/* Numbers of one measure down a list: columns in the same widths as their header, a red count that opens what it counts. */}
          <ListHeader columns={[{ key: "cited", label: "被引用", sortable: true }, { key: "wrong", label: "讲错的回答", sortable: true }, { key: "mentions", label: "提到你", sortable: true }]} sort={{ key: "cited", descending: true }} onSort={() => {}} />
          <List label="数字列" divided>
            <ListRow
              title={<span className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate">百度百科</span><Tag>百科</Tag><span className="min-w-0 truncate text-caption text-text-3">baike.baidu.com</span></span>}
              onOpen={() => {}}
              columns={[
                { key: "cited", label: "被引用", value: "69" },
                { key: "wrong", label: "讲错的回答", value: "14", tone: "danger", onOpen: () => {} },
                { key: "mentions", label: "提到你", value: "35" },
              ]}
            />
            <ListRow
              title={<span className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate">丁香医生</span><Tag>健康媒体</Tag><span className="min-w-0 truncate text-caption text-text-3">dxy.com</span></span>}
              onOpen={() => {}}
              columns={[{ key: "cited", label: "被引用", value: "48" }, { key: "wrong", label: "讲错的回答", value: "0" }, { key: "mentions", label: "提到你", value: "0" }]}
            />
          </List>
        </div>
        <div className="flex items-center gap-4">
          {(["running", "done", "review", "failed", "canceled"] as const).map((state) => (
            <span key={state} className="inline-flex items-center gap-2 text-ui text-text-2">
              <RunStatusDot state={state} labelled />
              {RUN_STATE_LABEL[state]}
            </span>
          ))}
        </div>
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

      <Row name="ChartCard" note="标题是一句结论，不是“图 1”；四态齐备。">
        <ChartCard className="w-72" title="元宝对信尔美提及最多" meta="近 7 天" footnote="按 4 个引擎、264 次有效回答计算" height={120}>
          <div className="h-[120px] rounded bg-surface-1" />
        </ChartCard>
        <ChartCard className="w-72" title="正在加载" state="loading" height={120} />
        <ChartCard className="w-72" title="还没有可画的数据" state="empty" emptyText="本周还没有测到" height={120} />
        <ChartCard className="w-72" title="无法读取" state="error" errorMessage="无法读取这张图的数据。" onRetry={() => {}} height={120} />
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

      <Row name="Citation / SourceCard" note="“依据 ✓”是核对过的引文，“依据 ⚠”要读者再看一眼；来源卡先说研究类型。">
        <p className="max-w-measure-body text-body text-text">
          低剂量阿司匹林用于一级预防，出血风险高于获益。
          <ClaimCitation ids={["CLM-001"]} claims={CLAIMS} statuses={VERIFIED} />
          老年人群的绝对获益更小。
          <ClaimCitation ids={["CLM-002"]} claims={CLAIMS} statuses={PENDING} />
        </p>
        <ul className="w-full max-w-read space-y-2">
          <SourceCard
            entry={{
              key: "pmid-30221597",
              index: 1,
              title: "Aspirin in the Primary Prevention of Cardiovascular Disease",
              sourceType: "rct",
              journal: "NEJM",
              year: "2018",
              identifier: "PMID:30221597",
              quote: "major hemorrhage was higher in the aspirin group",
              status: "verified",
              claims: 1,
            }}
          />
        </ul>
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

      <Row name="Skeleton / EmptyState / LoadError" note="骨架与将要出现的内容同形；空态一句话加一个动作；读不到就说无法读取并能重试。">
        <div className="w-72"><FilesSkeleton /></div>
        <div className="w-72"><MemorySkeleton /></div>
        <div className="w-72 rounded-card border border-border">
          <EmptyState title="还没有资料" description="拖放文件到这里，或点右上角上传。" />
        </div>
        <LoadError className="w-72" message="无法读取记忆。" onRetry={() => {}} />
      </Row>

      <Row name="Dialog" note="确认框焦点先在“取消”；Enter 只触发获得焦点的按钮。">
        <Stage label="确认框示例">
          <ConfirmDialog
            title="删除“阿司匹林一级预防”这个对话？"
            body="对话和其中的 3 个文件都会被删除，无法恢复。"
            confirmLabel="删除"
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </Stage>
      </Row>

      <Row name="Drawer" note="从右侧 24 px 滑入；关闭是 36 px 的图标按钮；底栏贴底，离窗口底不少于 16 px。">
        <Stage label="抽屉示例">
          <Drawer
            title="科研工具"
            description="系统综述与 Meta 分析"
            onClose={() => {}}
            widthClassName="max-w-sm"
            footer={<div className="flex justify-end gap-2"><Button variant="secondary">取消</Button><Button>开始研究</Button></div>}
          >
            <p className="text-ui text-text-2">写下研究主题、目标人群与关注的结局。</p>
          </Drawer>
        </Stage>
      </Row>

      <Row name="Toast" note="成功 5 秒、带撤销 10 秒、错误不自动消失；状态只由图标说。">
        <Stage label="提示条示例">
          <Toaster />
        </Stage>
      </Row>
    </PageShell>
  );
}
