import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { ChevronDown } from "lucide-react";
import { listGeoProjects, type GeoProject } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { geoTabPath, resolveGeoTab, type GeoTabKey } from "./geoTabs";
import { withStartDate } from "./geoText";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";

/** One project selector for the entire work area; history filters never call it. */
export function GeoProjectPicker({ project, destination }: { project: Pick<GeoProject, "id" | "name">; destination?: GeoTabKey }) {
  const location = useLocation();
  const [listing, setListing] = useState<Awaited<ReturnType<typeof listGeoProjects>>>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration);
  useEffect(() => {
    let live = true;
    setFailed(false);
    setListing([]);
    void listGeoProjects().then(rows => { if (live) setListing(rows); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [project.id, attempt, generation]);
  const labels = useMemo(() => withStartDate(listing), [listing]);
  const part = location.pathname.split("/")[4];
  const tab = destination ?? (part === "answers" ? "questions" : resolveGeoTab(part === "chat" ? new URLSearchParams(location.search).get("result") : part).tab);
  const items: MenuEntry[] = [
    { label: "全部 GEO 项目", to: "/app/geo", onSelect: () => {} },
    ...(listing.length ? ["separator" as const] : []),
    ...listing.map(row => ({ label: labels.get(row.id) ?? row.name, checked: row.id === project.id,
      // A different project keeps the destination, never this project's objects, pending intent or sampling selection.
      ...(row.id === project.id ? {} : { to: geoTabPath(row.id, tab) }), onSelect: () => {} })),
  ];
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-geo-project-picker="">
    <Link className="rounded text-ui text-link hover:underline" to="/app/geo">循证 GEO</Link>
    <span aria-hidden="true" className="text-text-3">/</span>
    <Menu label="切换整个 GEO 项目" align="start" items={items}>
      <Button variant="text" className="max-w-full" aria-label={`当前项目：${project.name}，切换项目`}>
        <span className="truncate">{project.name}</span><ChevronDown size={16} aria-hidden="true" />
      </Button>
    </Menu>
    {failed && <Button variant="text" size="sm" onClick={() => setAttempt(value => value + 1)}>重试项目列表</Button>}
  </div>;
}
