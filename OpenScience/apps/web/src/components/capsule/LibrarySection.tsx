import { useState } from "react";
import { Link } from "react-router";
import { getWebProjectId } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { LIBRARY_KIND_LABELS, LIBRARY_STATUS_LABELS, fetchLibrary, publishToCapsule, type LibraryItem } from "@/lib/libraryClient";
import { announceMemoryChanged } from "@/lib/memoryClient";
import { productErrorMessage } from "@/lib/productClient";
import { labelFor } from "@/lib/statusLabel";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { SectionShell } from "./SectionShell";
import { useCapsuleData } from "./useCapsuleData";

/** A source whose reading has finished, and so has something to put in the capsule. */
const READ = new Set(["complete", "ready"]);

function authorsLine(item: LibraryItem) {
  const authors = item.authors ?? [];
  if (authors.length === 0) return "";
  return authors.length > 3 ? `${authors.slice(0, 3).join("、")} 等` : authors.join("、");
}

/**
 * 「资料」: the personal library seen from the capsule (proposal §4.8) — each
 * source, where its reading is, and the way to put what was read into the
 * capsule. What a document contributes is facts with its source attached, and
 * any method it describes as a draft: a document never becomes the
 * researcher's preference or identity (plan §3.3 #1). The library itself is
 * managed in 知识库; this section reads it.
 */
export function LibrarySection() {
  const projectId = getWebProjectId();
  const [scope, setScope] = useState<"project" | "all">("project");
  const [busy, setBusy] = useState<string | null>(null);
  // `served: null` is a deployment without the library; `data: null` is a read in flight.
  const { data, failed, reload } = useCapsuleData(async () => ({ served: await fetchLibrary() }));

  const publish = async (item: LibraryItem) => {
    setBusy(item.sourceId);
    try {
      const result = await publishToCapsule(item.sourceId);
      const facts = typeof result?.facts === "number" ? result.facts : null;
      const methods = typeof result?.methods === "number" ? result.methods : null;
      toast.success(facts === null
        ? `已把「${item.title}」读到的内容放进胶囊`
        : `已从「${item.title}」放进胶囊 ${facts} 条事实${methods ? `、${methods} 个方法草稿` : ""}，都注明了出处`);
      announceMemoryChanged();
    } catch (error) {
      toast.error(`没有放进去：${productErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const items = (data?.served ?? []).filter((item) => scope === "all" || item.projects.includes(projectId));
  return (
    <SectionShell
      intro="你的资料在这里汇成胶囊的一部分：读完的资料可以放进胶囊，放进去的是带出处的事实，文中的方法只作为草稿，不会变成你的偏好。资料本身在「知识库」里管理。"
      loading={data === null}
      failed={failed}
      onRetry={reload}
    >
      {data?.served === null ? (
        <p className="text-ui text-muted">
          这个部署还没有接入资料库的胶囊视图。你的资料仍在 <Link to="/app/files" className="text-link hover:underline">知识库</Link> 里。
        </p>
      ) : (
        <>
          <SegmentedControl
            aria-label="资料范围"
            value={scope}
            onChange={setScope}
            options={[{ value: "project", label: "本项目" }, { value: "all", label: "全部" }]}
          />
          {items.length === 0 ? (
            <p className="text-ui text-muted">
              {scope === "project" ? "这个项目还没有资料。" : "资料库是空的。"}在 <Link to="/app/files" className="text-link hover:underline">知识库</Link> 上传代表作、方案或 SOP。
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border bg-surface">
              {items.map((item) => (
                <li key={item.sourceId} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-ui text-text">{item.title}</p>
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-caption text-muted">
                      <span>{labelFor(LIBRARY_KIND_LABELS, item.kind, "资料")}</span>
                      {authorsLine(item) && <span>{authorsLine(item)}</span>}
                      {item.doi && <span className="font-mono">{item.doi}</span>}
                      {typeof item.pageCount === "number" && <span className="tabular-nums">{item.pageCount} 页</span>}
                      <span>{labelFor(LIBRARY_STATUS_LABELS, item.status, "状态未知")}</span>
                      {item.addedAt && <span>加入于 {formatDateTime(item.addedAt, { month: "short", day: "numeric" })}</span>}
                      {scope === "all" && item.projects.length > 1 && <span>{item.projects.length} 个项目在用</span>}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === item.sourceId}
                    disabled={busy !== null || !READ.has(item.status)}
                    title={READ.has(item.status) ? undefined : "读完之后才能放进胶囊"}
                    onClick={() => void publish(item)}
                  >
                    放进胶囊
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SectionShell>
  );
}
