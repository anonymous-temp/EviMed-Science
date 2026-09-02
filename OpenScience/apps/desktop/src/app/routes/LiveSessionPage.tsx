import { useEffect, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowDown, Bot, FolderOpen, Loader2, PanelLeft, PlugZap } from "lucide-react";
import { DRAFT_KEY, rootSessionOf, subagentActivity, useRuntimeStore } from "@/lib/runtime";
import { useUiStore } from "@/lib/store";
import { isTauri } from "@/lib/tauri";
import { isMacPlatform } from "@/lib/platform";
import { hasWebApi } from "@/lib/apiClient";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { useScrollMemory } from "@/lib/scrollMemory";
import { useChatScrollFollow } from "@/lib/useChatScrollFollow";
import { BlockList, type BlockHandlers } from "@/components/thread/BlockList";
import { Elapsed } from "@/components/thread/ToolGroup";
import { Composer } from "@/components/thread/Composer";
import { baseName } from "@/components/thread/WorkspaceChip";
import { WorkflowStarters } from "@/components/thread/WorkflowStarters";
import { OnboardingGuide } from "@/components/thread/OnboardingGuide";
import { ConnectingCard } from "@/components/thread/ConnectingCard";
import { InteractionPrompt } from "@/components/thread/InteractionPrompt";
import { InspectorShell } from "@/components/inspector/InspectorShell";
import { MaximizePaneButton, RightPane } from "@/components/inspector/RightPane";
import { SessionFilesPane } from "./FilesPage";
import { cn } from "@/lib/cn";
import { researchAgentUi, researchInputLabel } from "@/lib/researchAgentUi";
import { displaySessionTitle } from "@/lib/sessionTitle";

/** Live agent session, driven by the SDK client against whatever runtime it
 *  is pointed at. `/live` (no id) is a blank draft;
 *  the session is created lazily on the first message, then the URL updates to /live/:id. */
export function LiveSessionPage() {
  const { sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const requestedAgentId = searchParams.get("agent");
  const navigate = useNavigate();
  const {
    status,
    switching,
    sending,
    runningSessions,
    serverUrl,
    sessions,
    researchAgents,
    researchSessionBindings,
    draftResearchAgent,
    specialtySelectionPending,
    currentId,
    threads,
    error,
    questions,
    permissions,
    sessionParents,
    workspace,
    panes,
    commands,
    sessionTitles,
    connect,
    bootstrap,
    openSession,
    startDraft,
    startSpecialistDraft,
    sendPrompt,
    runShell,
    runCommand,
    openArtifact,
    closeArtifact,
    setShowFiles,
    answerQuestion,
    rejectQuestion,
    replyPermission,
    interrupt,
    reconcileRunning,
    approvalMode,
    setApprovalMode,
  } = useRuntimeStore();

  // A deliberate workspace move restarts the sidecar — expected and brief, so
  // the UI stays "connected" (no badge flip, no Connect button, no help card).
  // Only a real failure (retry window exhausted, switching cleared) surfaces.
  const connected = status === "ready" || switching;
  const connecting = status === "connecting" && !switching;
  const displayStatus = switching ? "ready" : status;
  const hostedWeb = hasWebApi && !isTauri;

  useEffect(() => {
    if (sessionId) {
      // A direct page load can resolve the route before the hosted runtime has
      // created its runtime client. Retry once the connection becomes ready;
      // otherwise openSession returns early and the thread skeleton never ends.
      if (connected) void openSession(sessionId);
    } else if (requestedAgentId) void startSpecialistDraft(requestedAgentId);
    else startDraft(); // blank open-domain draft — no session created yet (#3)
  }, [sessionId, requestedAgentId, connected, openSession, startDraft, startSpecialistDraft]);

  // All three composer paths reflect a freshly-created session in the URL.
  const afterTurn = (id: string | null) => {
    if (id && !sessionId) navigate(`/live/${id}`);
  };
  const onSend = async (text: string) => afterTurn(await sendPrompt(text));
  const onRunShell = async (command: string) => afterTurn(await runShell(command));
  const onRunCommand = async (name: string, args: string) => afterTurn(await runCommand(name, args));

  // Interactions from the thread/inspector fold back into the conversation as follow-up prompts.
  const handlers: BlockHandlers = {
    onArtifactOpen: openArtifact,
    onFigureComment: (a, title) =>
      void sendPrompt(`On the figure ${title}, at (${a.x.toFixed(0)}%, ${a.y.toFixed(0)}%): ${a.note}`),
    // Subagent events fold into their own thread; a running task row reads
    // its child's latest step from there.
    subagentActivity: (childId) => subagentActivity(threads[childId]?.blocks),
    // A failed turn's resend replays its echo through the normal dispatch —
    // the same prefix rules the composer applies to typed input.
    onRetry: (text) => {
      if (!hostedWeb && text.startsWith("! ")) return void onRunShell(text.slice(2).trim());
      const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!hostedWeb && m && commands.some((c) => c.name === m[1])) {
        return void onRunCommand(m[1], m[2]?.trim() ?? "");
      }
      return void onSend(text);
    },
  };
  const onEvaluate = (expr: string) => void sendPrompt(`Evaluate in the notebook kernel:\n\`\`\`python\n${expr}\n\`\`\``);

  // A draft shows its local thread (the first message echoes there instantly,
  // before any session exists) — it is grafted onto the session id on create.
  const thread = currentId ? threads[currentId] : threads[DRAFT_KEY];
  // Opening a session fetches its history (cross-folder opens also restart the
  // sidecar) — show skeleton shapes meanwhile, never a blank page.
  const historyLoading = connected && !!sessionId && !thread?.loaded;
  const title = displaySessionTitle(
    (currentId && sessionTitles[currentId]) ?? sessions.find((s) => s.id === currentId)?.title,
  );
  const sessionBinding = currentId ? researchSessionBindings[currentId] : null;
  const specialtyAgentSource = draftResearchAgent ?? (
    sessionBinding?.mode === "specialist"
      ? researchAgents.find((agent) => (
          agent.id === sessionBinding.agentId && agent.version === sessionBinding.agentVersion
        )) ?? null
      : null
  );
  const specialtyAgent = specialtyAgentSource ? researchAgentUi(specialtyAgentSource) : null;
  const isEmpty = !thread || thread.blocks.length === 0;
  // The turn lifecycle: `sending` covers click → POST accepted (incl. the
  // dated-folder setup on a first message); `running` covers the agent
  // working until session.idle. Together they lock the composer and show the
  // working indicator, so a sent message is never silently "nowhere".
  const running = !!(currentId && runningSessions[currentId]);
  const working = specialtySelectionPending || sending || running;
  // What the agent is doing right now — the newest still-running tool call.
  const currentTool = working
    ? [...(thread?.blocks ?? [])]
        .reverse()
        .find((b): b is Extract<typeof b, { kind: "tool-call" }> =>
          b.kind === "tool-call" && b.status === "running",
        )
    : undefined;

  // Esc interrupts the running turn (like a terminal agent). Modals and open
  // menus/popovers own Esc while open; handled Esc presses (marked via
  // preventDefault, e.g. the composer's palette) never reach here.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      void interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, interrupt]);

  // Backstop while "Working…": if session.idle got lost (SSE reconnect
  // windows), a slow poll re-checks the server so the spinner can never
  // outlive the turn.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void reconcileRunning(), 15_000);
    return () => window.clearInterval(t);
  }, [running, reconcileRunning]);

  // The oldest unanswered request blocks the run — surface it. Requests from
  // subagents carry their CHILD session id; resolve through the parent chain
  // so they still land in the conversation the user is looking at.
  const belongsHere = (sid: string) =>
    !!currentId && (sid === currentId || rootSessionOf(sessionParents, sid) === currentId);
  const activeQuestion = questions.find((q) => belongsHere(q.sessionId));
  const activePermission = permissions.find((p) => belongsHere(p.sessionId));
  const activeRequest = activeQuestion ?? activePermission;
  // Name the subagent on the card when the ask isn't from the main agent.
  const requestOrigin =
    activeRequest && activeRequest.sessionId !== currentId
      ? displaySessionTitle(sessions.find((s) => s.id === activeRequest.sessionId)?.title ?? "子任务")
      : undefined;

  // The right pane belongs to the session: each one remembers its own open
  // artifact or Files browser (mutually exclusive, enforced by the store) and
  // gets it back when the user returns.
  const pane = panes[currentId ?? DRAFT_KEY];
  const activeArtifact = pane?.artifact ?? null;
  const showFiles = !activeArtifact && !!pane?.showFiles;

  // Conversation scroll position, per session — restored once history is in.
  // useScrollMemory owns the restore; useChatScrollFollow owns pinning the
  // tail while the user is at the bottom (and stands down on the restore
  // commit, so a remembered mid-thread position is never yanked down).
  const chatRef = useRef<HTMLDivElement>(null);
  const scrollKey = `chat:${currentId ?? DRAFT_KEY}`;
  const onChatScroll = useScrollMemory(chatRef, scrollKey, !historyLoading);
  const { following, newCount, handleScroll, backToBottom } = useChatScrollFollow(chatRef, {
    restoreKey: scrollKey,
    ready: !historyLoading,
    blocks: thread?.blocks,
    working,
  });
  const handleChatScroll = (e: React.UIEvent<HTMLDivElement>) => {
    onChatScroll(e);
    handleScroll(e);
  };

  // With the sidebar collapsed this header doubles as the titlebar (macOS
  // overlay): it clears the traffic lights, hosts the sidebar expand button,
  // and empty stretches drag the window — one row, never two.
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const isMac = isMacPlatform();
  const overlayTitlebar = isTauri && isMac;

  return (
    <div className="flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          className={cn(
            "flex h-12 shrink-0 items-center gap-2 px-6",
            // A draft is a clean page — no separator; an open session gets a
            // faint one so the title row reads as part of the conversation.
            sessionId && "border-b border-faint",
            sidebarCollapsed && overlayTitlebar && "pl-[78px]",
          )}
        >
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              aria-label="展开侧边栏"
              title={`展开侧边栏 (${isMac ? "⌘B" : "Ctrl+B"})`}
              className="fade-in rounded p-1 text-text hover:bg-surface-2"
            >
              <PanelLeft size={14} strokeWidth={1.5} />
            </button>
          )}
          {/* A draft has no session folder yet, so no Files toggle until the
              first message creates the session. */}
          {sessionId && (
            <button
              onClick={() => setShowFiles(!showFiles)}
              className={cn(
                "flex items-center gap-1 rounded-input px-2 py-0.5 text-xs ring-1 ring-border hover:bg-surface-2",
                showFiles ? "bg-surface-2 text-text" : "bg-surface text-muted",
              )}
              title={`查看本次任务文件${workspace ? ` — ${workspace}` : ""}`}
              aria-pressed={showFiles}
            >
              <FolderOpen size={12} />
              {/* An open session's folder is a fact — the toggle names it, replacing
                  a separate folder chip (one element for "this session's files"). */}
              <span className="max-w-[160px] truncate">
                {workspace ? baseName(workspace) : "任务文件"}
              </span>
            </button>
          )}
          {/* A draft shows no title and no folder — the workspace picker lives
              in the composer's action row until the session exists. */}
          {sessionId && (
            <h1 className="truncate text-ui font-medium text-text">{title}</h1>
          )}
          <div data-tauri-drag-region={overlayTitlebar || undefined} className="flex-1" />
          <ConnBadge status={displayStatus} />
          {!connected && (
            <button
              onClick={hostedWeb ? bootstrap : connect}
              disabled={connecting}
              className="flex items-center gap-1.5 rounded-input bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
              aria-label={hostedWeb ? "启动科研服务" : "连接科研服务"}
            >
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
              {hostedWeb ? "启动" : "连接"}
            </button>
          )}
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={chatRef} onScroll={handleChatScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-content flex-col gap-4 px-8 py-6">
            {specialtyAgent && (
              <section className="overflow-hidden rounded-card border border-accent/25 bg-surface shadow-card">
                <div className="flex items-start gap-3 border-b border-border px-5 py-4">
                  <div className="mt-0.5 rounded-input bg-accent/10 p-2 text-accent">
                    <Bot size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-caption font-medium uppercase tracking-[0.14em] text-accent">
                      {specialtyAgent.category} · 多轮专项科研
                    </div>
                    <h2 className="mt-1 text-base font-semibold text-text">{specialtyAgent.title}</h2>
                    <p className="mt-1 text-sm leading-5 text-muted">{specialtyAgent.description}</p>
                    <p className="mt-2 text-xs text-muted">
                      建议提供：{[...specialtyAgent.requiredInputs, ...specialtyAgent.optionalInputs]
                        .map(researchInputLabel)
                        .join("、")}
                    </p>
                  </div>
                </div>
                {isEmpty && specialtyAgent.starterPrompts.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-5 py-3">
                    {specialtyAgent.starterPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => void onSend(prompt)}
                        className="rounded-full bg-surface-2 px-3 py-1.5 text-left text-xs text-text ring-1 ring-border hover:bg-accent/10 hover:ring-accent/40 disabled:opacity-50"
                        disabled={working}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
            {/* Deliberate workspace switches don't render anything at all (they're
                masked as connected). A genuine boot/reconnect shows the header
                badge's pulsing dot plus one stable ConnectingCard explaining
                first-launch initialization (it can take minutes); the card sits
                in the otherwise-empty content area, so nothing swaps or jumps
                when the thread/starters arrive. The help card below is for
                real error/offline states. */}
            {connecting && <ConnectingCard />}
            {!connected && !connecting && (
              <div className="rounded-card border border-border bg-surface p-5 shadow-card">
                <div className="text-sm font-medium text-text">EviMed 科研服务</div>
                {hostedWeb ? (
                  <div className="mt-3">
                    <button
                      onClick={bootstrap}
                      className="inline-flex items-center gap-1.5 rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
                    >
                      <PlugZap size={14} />
                      启动科研服务
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mt-1 text-sm text-muted">
                      科研服务尚未连接，请检查本地服务状态后重试。
                    </p>
                    <div className="mt-3 rounded-input bg-surface-2 px-3 py-2 font-mono text-xs text-text">
                      {serverUrl}
                    </div>
                  </>
                )}
              </div>
            )}
            {error && (
              <div className="rounded-input border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </div>
            )}
            {connected && isEmpty && !sessionId && !specialtySelectionPending && (
              <>
                <OnboardingGuide hasPriorSessions={sessions.length > 0} />
                <WorkflowStarters onPick={(p) => void onSend(p)} />
              </>
            )}
            {historyLoading && <ThreadSkeleton />}
            {!historyLoading && thread && <BlockList blocks={thread.blocks} handlers={handlers} />}
            {working && (
              // Typing-indicator at the bottom of the conversation: the message
              // just echoed above it, so the user always sees the send is alive.
              <div className="flex min-w-0 items-center gap-2 text-sm text-muted">
                <Loader2 size={14} className="shrink-0 animate-spin" />
                <span className="shrink-0">
                  {activeRequest
                    ? "任务已暂停，请在下方补充信息"
                    : specialtySelectionPending
                      ? "正在加载科研工作流…"
                    : sending && !currentId
                      ? "正在创建任务空间…"
                      : "正在执行…"}
                </span>
                {!activeRequest && currentTool && (
                  <>
                    <span
                      className="truncate font-mono text-xs"
                      title={currentTool.command ?? currentTool.title}
                    >
                      {currentTool.title}
                    </span>
                    {currentTool.startedAt !== undefined && (
                      <Elapsed start={currentTool.startedAt} />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Follow-the-tail is paused (user scrolled up): a floating way back —
            with the count of conversation messages that arrived meanwhile. */}
        {!following && (
          <button
            type="button"
            onClick={backToBottom}
            aria-label="回到底部"
            className="fade-in absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text shadow-card hover:bg-surface-2"
          >
            <ArrowDown size={13} />
            {newCount > 0 ? `回到底部 · ${newCount} 条新消息` : "回到底部"}
          </button>
        )}
        </div>

        <div className="px-8 pb-5 pt-2">
          <div className="mx-auto max-w-content space-y-3">
            {activeRequest && (
              <InteractionPrompt
                question={activeQuestion}
                permission={activeQuestion ? undefined : activePermission}
                origin={requestOrigin}
                onAnswer={(id, answers) => void answerQuestion(id, answers)}
                onReject={(id) => void rejectQuestion(id)}
                onPermission={(id, reply) => void replyPermission(id, reply)}
              />
            )}
            <Composer
              onSend={onSend}
              onRunShell={hostedWeb ? undefined : (c) => void onRunShell(c)}
              onRunCommand={hostedWeb ? undefined : (n, a) => void onRunCommand(n, a)}
              commands={hostedWeb ? [] : commands}
              disabled={!connected || working}
              working={running || specialtySelectionPending}
              onStop={() => void interrupt()}
              placeholder={
                specialtySelectionPending
                  ? "正在加载科研工作流…"
                  : working
                    ? "正在等待回复…"
                    : connected
                      ? "请输入问题或科研任务"
                      : "科研服务连接后即可开始"
              }
              approvalMode={hostedWeb ? undefined : approvalMode}
              onApprovalModeChange={hostedWeb ? undefined : (mode) => void setApprovalMode(mode)}
              approvalLocked={hostedWeb}
            />
          </div>
        </div>
      </div>

      {(activeArtifact || showFiles) && (
        <RightPane onClose={activeArtifact ? closeArtifact : () => setShowFiles(false)}>
          {activeArtifact ? (
            <InspectorShell
              inspector={fileInspectorFromBlock(activeArtifact, { hostedRuntime: hostedWeb })}
              onClose={closeArtifact}
              onEvaluate={onEvaluate}
              controls={<MaximizePaneButton />}
            />
          ) : (
            <div className="h-full border-l border-border bg-surface">
              <SessionFilesPane
                onClose={() => setShowFiles(false)}
                controls={<MaximizePaneButton />}
              />
            </div>
          )}
        </RightPane>
      )}
    </div>
  );
}

/** Loading placeholder mirroring the thread's real shapes: a user card, agent
 *  text lines, a quiet tool row — so the page never sits blank while history
 *  loads and nothing jumps when the content arrives. */
function ThreadSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden>
      <div className="h-11 rounded-card bg-surface-2" />
      <div className="space-y-2.5 px-1 pt-1">
        <div className="h-3.5 w-11/12 rounded bg-surface-2" />
        <div className="h-3.5 w-4/5 rounded bg-surface-2" />
        <div className="h-3.5 w-2/3 rounded bg-surface-2" />
      </div>
      <div className="ml-2 h-4 w-2/5 rounded bg-surface-2 opacity-60" />
      <div className="h-11 rounded-card bg-surface-2" />
      <div className="space-y-2.5 px-1 pt-1">
        <div className="h-3.5 w-5/6 rounded bg-surface-2" />
        <div className="h-3.5 w-3/5 rounded bg-surface-2" />
      </div>
    </div>
  );
}

function ConnBadge({ status }: { status: string }) {
  // Ready is the norm — render nothing; anything else gets a dot and, for
  // states that need attention, a short label (hover for detail).
  if (status === "ready") return null;
  const tone = status === "error" ? "text-error" : "text-muted";
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", tone)} title="EviMed 科研服务状态">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "error" ? "bg-error" : "bg-muted",
          status === "connecting" && "animate-pulse",
        )}
      />
      {status === "error" ? "服务异常" : status === "connecting" ? "正在连接" : "服务未连接"}
    </span>
  );
}
