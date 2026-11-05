import type { GeoReadScope } from "@/lib/geoReadScope";
import { engineName } from "./geoText";

/** The visible controls describe the resolved selection; an opaque saved selection is never called “all”. */
export function geoScopeSummary(scope?: GeoReadScope): Array<{ id: string; label: string }> {
  const opaque = Boolean(scope?.selectionRef) && !scope?.round && !scope?.from && !scope?.to
    && !scope?.engines?.length && !scope?.groupIds?.length;
  const range = scope?.from || scope?.to ? `${scope.from ?? "不限"}–${scope.to ?? "不限"}` : scope?.round ? "指定轮次" : opaque ? "已保存范围" : "全部";
  const compare = scope?.compareFrom || scope?.compareTo ? `${scope.compareFrom ?? "不限"}–${scope.compareTo ?? "不限"}` : opaque ? "已保存范围" : "未设置";
  const engines = scope?.engines?.length === 1 ? engineName(scope.engines[0]) : scope?.engines?.length ? `${scope.engines.length} 个` : opaque ? "已保存范围" : "全部";
  const groups = scope?.groupIds?.length ? `${scope.groupIds.length} 个` : opaque ? "已保存范围" : "全部";
  return [
    { id: "time", label: `时间 · ${range}` },
    { id: "comparison", label: `对比 · ${compare}` },
    { id: "engines", label: `AI · ${engines}` },
    { id: "groups", label: `问题群 · ${groups}` },
  ];
}
