import { useEffect, useState, useSyncExternalStore } from "react";
import { WebApiError } from "@/lib/apiClient";
import { readGeoArticleVersion, readGeoPublicationVersion } from "@/lib/geoClient";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";

export type GeoVersionTarget = {
  kind: "article" | "orders" | "owned-links";
  recordId: string;
  versionId: string;
  digest: string;
  revision?: number;
};

/** Read only the version the server proves belongs to this GEO object. */
export function GeoScopedVersionPreview({ geoId, target, onClose }: { geoId: string; target: GeoVersionTarget; onClose(): void }) {
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  const identity = JSON.stringify([generation, geoId, target.kind, target.recordId, target.versionId, target.digest, target.revision ?? null]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ identity: string; text: string | null; error: string | null }>({ identity, text: null, error: null });
  const shown = state.identity === identity ? state : { text: null, error: null };
  useEffect(() => {
    let current = true;
    setState({ identity, text: null, error: null });
    const read = target.kind === "article"
      ? readGeoArticleVersion(geoId, target.recordId, target.versionId, target.digest)
      : readGeoPublicationVersion(geoId, target.kind, target.recordId, target.versionId, target.digest, target.revision);
    void read.then(value => { if (current && sessionGeneration() === generation) setState({ identity, text: value.text, error: null }); }, (error: unknown) => {
      if (current && sessionGeneration() === generation) setState({ identity, text: null, error: error instanceof WebApiError && error.code === "geo_article_text_unsupported"
        ? "此格式暂不支持文本预览（支持 Markdown 和 Word）。" : "所选版本暂时无法读取。" });
    });
    return () => { current = false; };
  }, [geoId, target.kind, target.recordId, target.versionId, target.digest, target.revision, generation, identity, attempt]);
  return <FormDialog title="查看内容版本" onClose={onClose}>
    {shown.error ? <div role="alert" className="flex flex-wrap items-center gap-2"><span>{shown.error}</span><Button size="sm" variant="secondary" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>
      : shown.text === null ? <p>正在读取内容版本</p> : <><p className="mb-3 text-ui">文本预览；Word 文件显示解析内容，排版可能不同。</p><pre className="whitespace-pre-wrap break-words font-sans text-ui">{shown.text}</pre></>}
  </FormDialog>;
}
