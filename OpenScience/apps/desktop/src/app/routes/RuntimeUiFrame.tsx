import { useEffect, useMemo, useRef, useState } from "react";
import { getWebProjectId, webRuntimeProfile } from "@/lib/apiClient";

/**
 * The session surface: the kernel's own browser application, framed.
 *
 * It is a frame and not a view of ours because the application is the working
 * surface this product decided to build on — the conversation, the tool cards,
 * the plan, the approvals, the trajectory and the deliverables are all its
 * work, kept current by the people who ship the kernel. What stays ours is
 * everything around it: the projects, the run ledger with its gate verdicts,
 * the knowledge base, the account.
 *
 * It is a separate origin and not a path because the application resolves
 * every URL it fetches against `location.origin`. Same host, different port:
 * a different origin, so this page cannot read into the frame; the same site,
 * so the session cookie is sent and the person inside it is the person who
 * logged in.
 *
 * The project is pinned by a query parameter on the first load only. The
 * application then owns its own URL, and re-pinning on every render would walk
 * over wherever the person had navigated to inside it.
 */
export function RuntimeUiFrame() {
  const origin = webRuntimeProfile().uiOrigin;
  const projectId = getWebProjectId();
  const [loaded, setLoaded] = useState(false);
  const pinned = useRef<string | null>(null);

  const src = useMemo(() => {
    if (!origin) return "";
    // One pin per project. Changing project changes the key below, the frame
    // is rebuilt, and the new project is pinned again.
    pinned.current = projectId;
    return `${origin.replace(/\/+$/, "")}/?project=${encodeURIComponent(projectId)}`;
  }, [origin, projectId]);

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  if (!origin) return null;

  return (
    <div className="relative h-full w-full">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center text-ui-sm text-muted">
          正在启动研究运行时…
        </div>
      )}
      <iframe
        key={src}
        src={src}
        title="研究会话"
        onLoad={() => setLoaded(true)}
        className="h-full w-full border-0"
        // The frame is the product's session surface, so it needs the same
        // powers a page has: its own scripts, its own forms, downloads of the
        // deliverables it produces, and clipboard for the citations people
        // copy out of it. It is same-site, so `allow-same-origin` grants it
        // nothing it would not already have.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
