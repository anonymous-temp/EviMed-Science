import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { getGeoObservations, type GeoObservationPage } from "@/lib/geoClient";
import type { GeoMetricMembers } from "@/lib/geoReadScope";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { useGeoLoad } from "./geoProjectData";
import { engineName } from "./geoText";
import { useGeoFrame, useGeoReadScope } from "./geoFrame";
import { answerPath } from "./tabs/geoTabText";

export function GeoMetricMembersDrawer({ geoId, members, label, onClose }: {
  geoId: string; members: GeoMetricMembers; label?: string; onClose(): void;
}) {
  const frame = useGeoFrame();
  const refreshView = () => {
    if (frame?.refreshScope) frame.refreshScope(); else { frame?.reload(); frame?.data.invalidate(); }
    onClose();
  };
  const { state, reload } = useGeoLoad(`members:${geoId}:${members.selectionRef}:${JSON.stringify(members.metric)}`,
    () => getGeoObservations(geoId, members.selectionRef, members.metric));
  return <Drawer title={label ? `${label} · 回答明细` : "指标的回答明细"} onClose={onClose}>
    {state.kind === "loading" ? <FilesSkeleton /> : state.kind === "error" ? state.stale
      ? <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={refreshView}>更新图表</Button>}>这批回答已有更新，请从更新后的图表查看明细。</Note>
      : <LoadError message={state.message} onRetry={reload} />
      : <MemberPages key={`${members.selectionRef}:${JSON.stringify(members.metric)}`} geoId={geoId} members={members} first={state.data} refreshView={refreshView} />}
  </Drawer>;
}

function MemberPages({ geoId, members, first, refreshView }: { geoId: string; members: GeoMetricMembers; first: GeoObservationPage; refreshView(): void }) {
  const location = useLocation();
  const timeZone = useGeoReadScope()?.timeZone ?? "Asia/Shanghai";
  const [rows, setRows] = useState(first.items);
  const [next, setNext] = useState(first.nextOffset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const more = async () => {
    if (busy || next === null) return;
    setBusy(true); setError("");
    try {
      const page = await getGeoObservations(geoId, members.selectionRef, members.metric, next);
      if (!mounted.current) return;
      setRows(previous => [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))]);
      setNext(page.nextOffset);
    } catch (caught) { if (mounted.current) {
      setStale(caught instanceof WebApiError && caught.status === 409);
      setError(webErrorMessage(caught, { fallback: "回答明细暂时无法继续读取。" }));
    } }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className="flex flex-col gap-4">
    <Note result={["当前指标基于 ", { n: first.total }, " 个回答，已显示 ", { n: rows.length }, " 个。"]} />
    <List label="构成指标的回答" divided>{rows.map(row => <ListRow key={row.id}
      title={row.question ?? "原问题"} to={`${answerPath(geoId, row.id)}${location.search}`}
      meta={[engineName(row.engine), row.askedAt ? new Date(row.askedAt).toLocaleString("zh-CN", { timeZone }) : "时间未记录",
        row.status === "failed" ? "采集失败" : row.status === "refusal" ? "拒答" : null].filter(Boolean).join(" · ")} />)}</List>
    {stale ? <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={refreshView}>更新图表</Button>}>回答已有更新，已读取的这一页仍保留；更新图表后可重新查看。</Note>
      : error && <LoadError message={error} onRetry={() => { void more(); }} />}
    {next !== null && !stale && <Button variant="secondary" size="sm" loading={busy} onClick={() => { void more(); }}>继续读取回答</Button>}
  </div>;
}
