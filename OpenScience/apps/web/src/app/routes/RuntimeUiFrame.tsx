import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { createWebRuntimeUiFrame, renewWebRuntimeUiFrame, releaseWebRuntimeUiFrame, getWebProjectId, webRuntimeProfile, type WebRuntimeUiFrame } from "@/lib/apiClient";
import { runtimeUiIntentFromState, type RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { Button } from "@/components/ui/Button";

/** The native application stays on its own origin and immutable project frame. */
export function RuntimeUiFrame() {
  const projectId = getWebProjectId();
  const origin = webRuntimeProfile().uiOrigin;
  // A project switch replaces the entire binding and all message state.
  return <BoundRuntimeUiFrame key={`${origin}:${projectId}`} projectId={projectId} origin={origin} />;
}

function BoundRuntimeUiFrame({ projectId, origin }: { projectId: string; origin: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const mirroredSession = useRef<{ sessionId: string; attempt: number } | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [binding, setBinding] = useState<WebRuntimeUiFrame | null>(null);
  const [ready, setReady] = useState(false);
  const [readyGeneration, setReadyGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const incoming = useRef(0);
  const outgoing = useRef(0);
  const currentRequest = useRef<RuntimeUiIntent | null>(null);
  const lastSent = useRef("");
  const releaseBinding = useRef<(() => void) | null>(null);
  const currentBinding = useRef<WebRuntimeUiFrame | null>(null);
  const renewBinding = useRef<(() => void) | null>(null);
  const recoveryAttempted = useRef(false);
  const nativeReady = useRef(false);
  currentBinding.current = binding;
  const frameId = binding?.frameId;
  const intent = useMemo(() => {
    const explicit = runtimeUiIntentFromState(location.state, projectId);
    if (explicit) return explicit;
    // URL updates acknowledged by the native application do not command it
    // to open itself again. Browser back/forward still yields a fresh intent.
    if (sessionId && mirroredSession.current?.sessionId === sessionId && mirroredSession.current?.attempt === attempt) return null;
    return { kind: sessionId ? "open" : "create", projectId, requestId: crypto.randomUUID(),
      sessionId: sessionId ?? crypto.randomUUID() } satisfies RuntimeUiIntent;
  }, [location.state, projectId, sessionId, attempt]);

  const navigationKey = `${location.pathname}:${runtimeUiIntentFromState(location.state, projectId)?.requestId ?? ""}`;
  const previousNavigation = useRef(navigationKey);
  useEffect(() => {
    const changed = previousNavigation.current !== navigationKey;
    previousNavigation.current = navigationKey;
    // Errors release the old cookie and document. A different target is a new
    // navigation, so recreate its binding rather than leaving the prior error sticky.
    if (changed && error) setAttempt(value => value + 1);
  }, [navigationKey, error]);

  useEffect(() => {
    let active = true;
    let frameId: string | null = null;
    const released = new Set<string>();
    releaseBinding.current = null;
    const release = (id: string) => {
      if (released.has(id)) return;
      released.add(id);
      void releaseWebRuntimeUiFrame(id).catch(() => {
        // Cookie cleanup is best effort; login expiry and revocation remain authoritative.
      });
    };
    setBinding(null); setReady(false); setPending(false); setNavigated(false); setError(null); setLeaseError(null); setRenewing(false);
    recoveryAttempted.current = false;
    nativeReady.current = false;
    incoming.current = 0; outgoing.current = 0; lastSent.current = ""; currentRequest.current = null;
    void createWebRuntimeUiFrame(projectId).then(value => {
      if (!active) { release(value.frameId); return; }
      frameId = value.frameId;
      releaseBinding.current = () => release(value.frameId);
      const url = new URL(value.frameUrl);
      if (url.origin !== origin || url.pathname !== `/__evimed/f/${value.frameId}/` || url.search || url.hash
        || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
        || typeof value.renewalToken !== "string" || !value.renewalToken) throw new Error("Invalid frame binding");
      setBinding(value);
    }).catch(() => { if (active) setError("研究会话暂时无法连接"); });
    return () => { active = false; if (frameId) release(frameId); };
  }, [projectId, origin, attempt]);

  useEffect(() => {
    if (!frameId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;
    const schedule = (expiresAt: number) => {
      clearTimeout(timer);
      // Renew with enough margin for a background browser's throttled timers.
      timer = setTimeout(() => { void renew(); }, Math.max(1000, Math.min(120_000, (expiresAt - Date.now()) * 0.6)));
    };
    const renew = (): Promise<void> => {
      if (inFlight) return inFlight;
      const prior = currentBinding.current;
      if (!active || !prior || prior.frameId !== frameId) return Promise.resolve();
      clearTimeout(timer);
      setRenewing(true);
      inFlight = renewWebRuntimeUiFrame(prior).then(value => {
        if (!active) { void releaseWebRuntimeUiFrame(prior.frameId).catch(() => {}); return; }
        if (value.frameId !== prior.frameId || value.frameUrl !== prior.frameUrl
          || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
          || typeof value.renewalToken !== "string" || !value.renewalToken) throw new Error("Invalid renewed binding");
        currentBinding.current = value;
        setBinding(value);
        setLeaseError(null);
        schedule(value.expiresAt);
        if (!nativeReady.current) iframe.current?.contentWindow?.postMessage({
          type: "evimed.runtime-ui.resume", version: 1, frameId, projectId, seq: ++outgoing.current,
        }, origin);
      }).catch(() => {
        if (active) setLeaseError("研究连接暂时无法续期，请重试");
      }).finally(() => {
        inFlight = null;
        if (active) setRenewing(false);
      });
      return inFlight;
    };
    const resume = () => { void renew(); };
    const foreground = () => { if (document.visibilityState === "visible") resume(); };
    renewBinding.current = resume;
    schedule(currentBinding.current?.expiresAt ?? Date.now());
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("online", resume);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", resume);
      if (renewBinding.current === resume) renewBinding.current = null;
    };
  }, [frameId, origin, projectId]);

  useEffect(() => {
    if (error) releaseBinding.current?.();
  }, [error, binding]);

  useEffect(() => {
    if (navigated || error) return;
    const timeout = setTimeout(() => setError("研究会话暂时无法连接"), 30_000);
    return () => clearTimeout(timeout);
  }, [navigated, error, attempt]);

  useLayoutEffect(() => {
    if (!binding) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.version !== 1 || message.frameId !== binding.frameId || message.projectId !== projectId
        || !Number.isSafeInteger(message.seq) || message.seq <= incoming.current) return;
      if (message.type === "evimed.runtime-ui.ready") {
        nativeReady.current = true;
        recoveryAttempted.current = false;
        setLeaseError(null);
        incoming.current = message.seq; lastSent.current = ""; setReady(true);
        setReadyGeneration(value => value + 1);
      } else if (message.type === "evimed.runtime-ui.connecting") {
        nativeReady.current = false;
        incoming.current = message.seq; setReady(false);
        if (navigated && !recoveryAttempted.current) { recoveryAttempted.current = true; renewBinding.current?.(); }
      } else if (message.type === "evimed.runtime-ui.error") {
        nativeReady.current = false;
        incoming.current = message.seq;
        if (navigated) {
          setReady(false);
          if (!recoveryAttempted.current) { recoveryAttempted.current = true; renewBinding.current?.(); }
          else setLeaseError("研究连接暂时无法恢复，请重试");
        } else setError("研究会话暂时无法连接");
      } else if (message.type === "evimed.runtime-ui.ack") {
        const request = currentRequest.current;
        if (!request || message.requestId !== request.requestId || typeof message.ok !== "boolean"
          || (message.ok && (typeof message.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(message.sessionId)
            || (request.kind === "open" && message.sessionId !== request.sessionId)))) return;
        incoming.current = message.seq;
        if (!message.ok) { setError("研究任务暂时无法打开"); return; }
        currentRequest.current = null; setPending(false); setNavigated(true);
        mirroredSession.current = { sessionId: message.sessionId, attempt };
        // Remove only this acknowledged request. A later navigation intent
        // must survive an acknowledgement from the previous operation.
        if (intent?.requestId === request.requestId) {
          const nextState = { ...location.state };
          delete nextState.runtimeUiIntent;
          navigate(`/app/chat/${encodeURIComponent(message.sessionId)}`, { replace: true, state: nextState });
        }
      } else if (message.type === "evimed.runtime-ui.session" && (message.sessionId === null
        || (typeof message.sessionId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(message.sessionId)))) {
        incoming.current = message.seq;
        if (currentRequest.current || !navigated || mirroredSession.current?.sessionId === message.sessionId) return;
        mirroredSession.current = message.sessionId === null ? null : { sessionId: message.sessionId, attempt };
        navigate(message.sessionId === null ? "/app/chat" : `/app/chat/${encodeURIComponent(message.sessionId)}`, { replace: true, state: null });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [binding, origin, projectId, intent, location, navigate, navigated, attempt]);

  useEffect(() => {
    if (!ready || error || !binding || !intent || !iframe.current?.contentWindow) return;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(intent.sessionId)) { setError("研究任务暂时无法打开"); return; }
    const key = `${binding.frameId}:${intent.requestId}`;
    if (lastSent.current === key) return;
    lastSent.current = key; currentRequest.current = intent; setPending(true);
    iframe.current.contentWindow.postMessage({
      type: "evimed.runtime-ui.navigate", version: 1, frameId: binding.frameId, projectId,
      requestId: intent.requestId, seq: ++outgoing.current,
      intent: { kind: intent.kind, sessionId: intent.sessionId, ...(intent.draft === undefined ? {} : { draft: intent.draft }) },
    }, origin);
  }, [ready, readyGeneration, error, binding, intent, projectId, origin]);

  useEffect(() => {
    if (!pending || error) return;
    const timeout = setTimeout(() => setError("研究任务暂时无法打开"), 20_000);
    return () => clearTimeout(timeout);
  }, [pending, error, attempt, intent?.requestId]);

  return (
    <div className="relative h-full w-full">
      {error ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-ui-sm text-error">
          <p>{error}</p>
          <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button>
        </div>
      ) : (
        <>
          {navigated && (leaseError || !ready || (renewing && binding && binding.expiresAt <= Date.now())) && (
            <div role={leaseError ? "alert" : "status"} className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg/90 text-ui-sm text-muted">
              <p>{leaseError ?? "正在恢复研究连接…"}</p>
              {leaseError && <Button variant="ghost" onClick={() => renewBinding.current?.()} disabled={renewing}>重新连接</Button>}
            </div>
          )}
          {(!navigated || pending) && <div role="status" className="absolute inset-0 z-10 flex items-center justify-center bg-bg/90 text-ui-sm text-muted">
            {pending ? "正在打开研究任务…" : "正在启动研究运行时…"}
          </div>}
          {binding && <iframe
            key={binding.frameId} ref={iframe} src={binding.frameUrl} title="研究会话"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
            allow="clipboard-read; clipboard-write"
          />}
        </>
      )}
    </div>
  );
}
