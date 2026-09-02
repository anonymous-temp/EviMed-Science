import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  LogIn,
  Loader2,
  NotebookPen,
  Search,
} from "lucide-react";
import type {
  McpServer,
  OAuthAuthorization,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
} from "@ai4s/sdk";
import { useUiStore } from "@/lib/store";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import {
  importOpenCodeLogin,
  isTauri,
  jupyterStatus,
  openExternal,
  openWorkspaceBase,
  pickFolder,
  removeConfigEntry,
  setupJupyter,
  setWorkspaceBase,
  startJupyter,
  workspaceBase,
  type JupyterStatus,
} from "@/lib/tauri";
import { setupScienceMcp } from "@/lib/tauri";
import { ClusterCard } from "@/components/settings/ClusterCard";
import { ModalCard } from "@/components/settings/ModalCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { WebTasksCard } from "@/components/settings/WebTasksCard";
import { WebResourcesCard } from "@/components/settings/WebResourcesCard";
import { WebAuditCard } from "@/components/settings/WebAuditCard";
import { WebErrorsCard } from "@/components/settings/WebErrorsCard";
import { WebSecurityCard } from "@/components/settings/WebSecurityCard";
import { WebProjectsCard } from "@/components/settings/WebProjectsCard";
import { WebAccountCard } from "@/components/settings/WebAccountCard";
import { WebReadinessCard } from "@/components/settings/WebReadinessCard";
import { SCIENCE_CONNECTORS, connectorConfig } from "@/lib/scienceConnectors";
import {
  fetchWebAuthMethods,
  fetchWebMe,
  getWebOidcStartUrl,
  hasCommandBackend,
  hasWebApi,
  loginWeb,
  webRuntimeProfile,
  WEB_SESSION_ENDED_EVENT,
  type WebAuthMethods,
} from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { buttonClasses } from "@/components/ui/Button";
import { Card as CardPrimitive } from "@/components/ui/Card";
import { inputClasses } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

/**
 * Settings. ONE configuration surface: in the retiring session view everything
 * talks to a local kernel's own config/auth API — no separate "model key".
 *
 * Under the managed runtime three of those cards describe something that does
 * not exist (§18.3, F1 「设置清理」). The runtime URL, the provider catalogue
 * and the MCP server list are all a local kernel's config API; a hosted
 * deployment has a server-managed runtime, a gateway-pinned model and a
 * bundle-mounted tool set, so those cards would let a person configure nothing
 * and read as though they still could. Account, projects, resources and
 * readiness stay — they are the control plane's, not the kernel's.
 *
 * Hidden rather than deleted, and keyed on what the server says it serves
 * rather than on a build flag, because the same page also renders in the
 * desktop shell, where there is no control plane to ask and the local cards
 * are all there is.
 */
export function SettingsPage() {
  const { status, serverUrl, setServerUrl, connect, disconnect, clearHostedSession, defaultModel, loadCatalog } =
    useRuntimeStore();
  const connected = status === "ready";
  const hostedWeb = hasWebApi && !isTauri;
  // Defaults to the retiring view, for the same reason `SessionRoute` does:
  // it is what the desktop shell renders, and in a browser it holds only until
  // `/api/me` answers.
  const [sessionView, setSessionView] = useState(() => webRuntimeProfile().sessionView);
  /** In a hosted deployment the runtime, its models and its tools are the server's. */
  const managedRuntime = hostedWeb && sessionView === "run-stream";

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [jupyter, setJupyter] = useState<JupyterStatus | null>(null);
  const [settingUpJupyter, setSettingUpJupyter] = useState(false);
  // Which curated science connector is currently being provisioned, by id.
  const [enablingConnector, setEnablingConnector] = useState<string | null>(null);
  // API keys typed for key-requiring connectors, keyed by connector id.
  const [connectorKeys, setConnectorKeys] = useState<Record<string, string>>({});

  // Add-MCP-server form.
  const [mName, setMName] = useState("");
  const [mType, setMType] = useState<"local" | "remote">("local");
  const [mTarget, setMTarget] = useState("");
  const [wsPath, setWsPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [webUsername, setWebUsername] = useState("");
  const [webPassword, setWebPassword] = useState("");
  const [webAccount, setWebAccount] = useState<string | null>(null);
  const [webAuthMethods, setWebAuthMethods] = useState<WebAuthMethods | null>(null);
  const [webProjectKey, setWebProjectKey] = useState(0);

  // Custom endpoint form (self-hosted / Ollama / OpenAI- or Anthropic-compatible).
  const [showCustom, setShowCustom] = useState(false);
  const [cName, setCName] = useState("");
  const [cNpm, setCNpm] = useState("@ai-sdk/openai-compatible");
  const [cUrl, setCUrl] = useState("");
  const [cKey, setCKey] = useState("");
  const [cModels, setCModels] = useState("");

  // Connect-a-provider flow state.
  const [connectQuery, setConnectQuery] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState<
    (OAuthAuthorization & { providerID: string; methodIndex: number }) | null
  >(null);
  const [codeInput, setCodeInput] = useState("");
  // A pending browser-login wait: `oauthGen` invalidates it (cancel, restart,
  // or connecting some other way), `oauthAbort` also cancels its in-flight
  // callback request so retries never stack pending waits on the sidecar.
  const oauthGen = useRef(0);
  const oauthAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const client = getClient();
    if (!client) return;
    try {
      const [p, m, c, custom, mcp] = await Promise.all([
        client.listProviders(),
        client.listAuthMethods(),
        client.listProviderCatalog(),
        client.listCustomProviderIds(),
        client.listMcpServers().catch(() => []),
      ]);
      setProviders(p);
      setAuthMethods(m);
      setCatalog(c.all);
      setCustomIds(custom);
      setMcpServers(mcp);
      if (hostedWeb) setJupyter(null);
      else setJupyter(await jupyterStatus());
    } catch {
      /* runtime not ready yet */
    }
  }, [hostedWeb]);

  const refreshWorkspaceBase = useCallback(async () => {
    try {
      setWsPath(await workspaceBase());
    } catch {
      setWsPath(null);
    }
  }, []);

  const handleHostedProjectChange = useCallback(() => {
    setWebProjectKey((key) => key + 1);
    void refreshWorkspaceBase();
  }, [refreshWorkspaceBase]);

  const clearHostedAccountState = useCallback(() => {
    setWebAccount(null);
    setWsPath(null);
  }, []);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  useEffect(() => {
    window.addEventListener(WEB_SESSION_ENDED_EVENT, clearHostedAccountState);
    return () => window.removeEventListener(WEB_SESSION_ENDED_EVENT, clearHostedAccountState);
  }, [clearHostedAccountState]);
  useEffect(() => {
    if (!hasWebApi) return;
    void fetchWebMe()
      .then((me) => {
        setWebAccount(me ? me.user.name || me.user.id : null);
        setSessionView(webRuntimeProfile().sessionView);
      })
      .catch(() => setWebAccount(null));
    void fetchWebAuthMethods()
      .then(setWebAuthMethods)
      .catch(() => setWebAuthMethods(null));
  }, []);
  useEffect(() => {
    // The BASE folder — the parent every session's dated subfolder is created
    // under. (The per-session active folder shows in the conversation header.)
    void refreshWorkspaceBase();
  }, [refreshWorkspaceBase]);

  const changeWorkspaceBase = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    try {
      setWsPath(await setWorkspaceBase(picked));
      toast.success("新会话将创建在此文件夹中。");
    } catch (err) {
      toast.error(`无法设置文件夹：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // The one post-change sequence — run() and the background OAuth wait must
  // stay in lockstep, so they share it instead of each keeping a copy.
  const refreshAll = async () => {
    await refresh();
    await loadCatalog();
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refreshAll();
    } catch (e) {
      toast.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Any action that cancels, restarts or bypasses the oauth flow must call
  // this: it invalidates the pending browser wait and aborts its request.
  const invalidateOauthWait = () => {
    oauthGen.current++;
    oauthAbort.current?.abort();
    oauthAbort.current = null;
  };

  const saveModel = (model: string) =>
    run("无法设置模型", async () => {
      if (hostedWeb) {
        toast.error("托管部署的模型选择由服务端统一管理。");
        return;
      }
      if (model) await getClient()!.setDefaultModel(model);
      toast.success(`默认模型已设为 ${model}。`);
    });

  const saveKey = (providerID: string) =>
    run("无法保存密钥", async () => {
      await getClient()!.setProviderApiKey(providerID, keyInput.trim());
      cancelOAuth(); // a pending browser login for this panel is now moot
      setKeyInput("");
      setConnectQuery("");
      toast.success(`${providerID} 已连接。`);
    });

  const startOAuth = (providerID: string, methodIndex: number, inputs?: Record<string, string>) =>
    run("无法发起登录", async () => {
      invalidateOauthWait(); // this flow replaces any pending one
      const gen = oauthGen.current;
      const auth = await getClient()!.oauthAuthorize(providerID, methodIndex, inputs);
      if (gen !== oauthGen.current) return; // cancelled while starting
      setOauth({ ...auth, providerID, methodIndex });
      await openExternal(auth.url);
      // "auto" flows finish on the browser redirect — the callback call below
      // WAITS for it, so run it in the background (never through `busy`, which
      // would lock the whole page for as long as the browser tab stays open).
      if (auth.method !== "code" && gen === oauthGen.current)
        void waitForBrowserLogin(providerID, methodIndex, gen);
    });

  const waitForBrowserLogin = async (providerID: string, methodIndex: number, gen: number) => {
    const abort = new AbortController();
    oauthAbort.current = abort;
    try {
      await getClient()!.oauthCallback(providerID, methodIndex, undefined, abort.signal);
      if (gen !== oauthGen.current) {
        // Cancelled in the UI, but the login DID complete — refresh silently
        // so the now-connected provider still shows up in the list.
        await refreshAll();
        return;
      }
      setOauth(null);
      toast.success(`${providerID} 已连接。`);
      await refreshAll();
    } catch (e) {
      if (gen !== oauthGen.current) return; // cancelled — the abort is expected
      setOauth(null);
      toast.error(`登录未完成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (oauthAbort.current === abort) oauthAbort.current = null;
    }
  };

  const cancelOAuth = () => {
    invalidateOauthWait();
    setOauth(null);
    setCodeInput("");
  };

  const completeOAuth = () =>
    run("登录未完成", async () => {
      if (!oauth) return;
      const { providerID, methodIndex } = oauth;
      invalidateOauthWait(); // the pasted code supersedes any browser wait
      await getClient()!.oauthCallback(providerID, methodIndex, codeInput.trim() || undefined);
      toast.success(`${providerID} 已连接。`);
      setOauth(null);
      setCodeInput("");
    });

  const disconnectProvider = (providerID: string) =>
    run("无法移除", async () => {
      if (customIds.includes(providerID)) {
        // Custom endpoints live in the config file; removal restarts the sidecar.
        await removeConfigEntry("provider", providerID);
        await useRuntimeStore.getState().connectRetry();
      } else {
        await getClient()!.removeProviderAuth(providerID);
      }
      toast.success(`${providerID} 已移除。`);
    });

  const saveCustom = () =>
    run("无法添加接入点", async () => {
      const id = cName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const models = cModels.split(",").map((s) => s.trim()).filter(Boolean);
      if (!id || !cUrl.trim() || models.length === 0) {
        toast.error("请填写名称、Base URL 和至少一个模型 id。");
        return;
      }
      await getClient()!.addCustomProvider(id, {
        name: cName.trim(),
        npm: cNpm,
        baseURL: cUrl.trim(),
        apiKey: cKey.trim() || undefined,
        models,
      });
      toast.success(`已添加 ${cName.trim()} — 其模型现在可在上方选择。`);
      setShowCustom(false);
      setCName("");
      setCUrl("");
      setCKey("");
      setCModels("");
    });

  const addMcp = () =>
    run("无法添加 MCP 服务器", async () => {
      const name = mName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const target = mTarget.trim();
      if (!name || !target) {
        toast.error("请填写名称和命令/URL。");
        return;
      }
      await getClient()!.addMcpServer(
        name,
        mType === "local"
          ? { type: "local", command: target.split(/\s+/), enabled: true }
          : { type: "remote", url: target, enabled: true },
      );
      toast.success(`MCP 服务器 ${name} 已添加。`);
      setMName("");
      setMTarget("");
    });

  // One click: uv provisions the isolated Jupyter env, the app starts the
  // server, and the MCP entry (URL + token) is written into OpenCode's config.
  const enableJupyter = async () => {
    setSettingUpJupyter(true);
    try {
      toast.success("正在配置 Jupyter — 首次运行需要下载几百 MB，请稍候…");
      await setupJupyter();
      const s = await startJupyter();
      if (!s.url || !s.token || !s.mcp_command) throw new Error("setup finished incomplete");
      await getClient()!.addMcpServer("jupyter", {
        type: "local",
        command: [s.mcp_command],
        enabled: true,
        environment: { JUPYTER_URL: s.url, JUPYTER_TOKEN: s.token, ALLOW_IMG_OUTPUT: "true" },
      });
      toast.success("Jupyter MCP 已启用 — 智能体现在可以操作笔记本。");
      await refreshAll();
    } catch (e) {
      toast.error(`Jupyter 配置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSettingUpJupyter(false);
    }
  };

  // One click: uv provisions the open-source connector into the shared science
  // env, then its MCP entry is written into OpenCode's config.
  const enableConnector = async (id: string) => {
    const c = SCIENCE_CONNECTORS.find((x) => x.id === id);
    if (!c) return;
    setEnablingConnector(id);
    try {
      toast.success(`正在配置 ${c.label} — 首次运行需要下载托管的 Python 环境，请稍候…`);
      const python = await setupScienceMcp(c.pkg);
      await getClient()!.addMcpServer(c.id, connectorConfig(c, python, connectorKeys[c.id]));
      toast.success(`${c.label} 已启用 — 智能体现在可以在对话中使用它。`);
      setConnectorKeys((k) => ({ ...k, [c.id]: "" })); // don't keep the key in UI state
      await refreshAll();
    } catch (e) {
      toast.error(`${c.label} 配置失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEnablingConnector(null);
    }
  };

  const removeMcp = (name: string) =>
    run("无法移除 MCP 服务器", async () => {
      await removeConfigEntry("mcp", name);
      await useRuntimeStore.getState().connectRetry();
      toast.success(`MCP 服务器 ${name} 已移除。`);
    });

  const importLogin = () =>
    run("导入失败", async () => {
      const found = await importOpenCodeLogin();
      if (!found) {
        toast.error("未在本机找到 OpenCode CLI 的登录信息。");
        return;
      }
      // The sidecar restarted with the imported credentials — reconnect.
      await useRuntimeStore.getState().connectRetry();
      toast.success("已导入你的 OpenCode CLI 登录信息。");
    });

  const webLogin = () =>
    run("登录失败", async () => {
      await loginWeb(webUsername.trim(), webPassword);
      const me = await fetchWebMe();
      setWebAccount(me ? me.user.name || me.user.id : webUsername.trim());
      setWebPassword("");
      await refreshWorkspaceBase();
      await useRuntimeStore.getState().bootstrap();
      toast.success("登录成功。");
    });

  // Resolve the search box to a catalog entry (by id or exact name).
  const q = connectQuery.trim().toLowerCase();
  const selected =
    catalog.find((p) => p.id === q) ?? catalog.find((p) => p.name.toLowerCase() === q) ?? null;
  // Every provider takes an API key via PUT /auth; special flows (OAuth) add to that.
  const methods: ProviderAuthMethod[] = selected
    ? [
        ...(authMethods[selected.id] ?? []).filter((m) => m.type === "oauth"),
        { type: "api", label: "API key" },
      ]
    : [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 pb-16 pt-8">
        <h1 className="font-serif text-xl text-text">设置</h1>
        <p className="mt-0.5 text-xs text-muted">
          {hostedWeb
            ? "托管 API 会话、项目运行时，以及由服务端管理的工作区。"
            : "这里的所有配置都作用于所连接的智能体运行时 — 单一配置，无副本。"}
        </p>

        {hasWebApi && (
          <Card title="Web 账户" hint="托管 API 会话与项目访问">
            {webAccount ? (
              <div className="flex items-center justify-between gap-3 text-ui">
                <span className="text-muted">
                  当前登录：<span className="font-medium text-text">{webAccount}</span>
                </span>
                <button
                  className={btnGhost()}
                  onClick={() => void useRuntimeStore.getState().bootstrap()}
                  disabled={busy}
                >
                  刷新
                </button>
              </div>
            ) : webAuthMethods?.mode === "oidc" && webAuthMethods.oidc ? (
              <a className={btnAccent()} href={getWebOidcStartUrl("/settings")}>
                <LogIn size={14} aria-hidden="true" />
                {webAuthMethods.oidc.label}
              </a>
            ) : (
              <div className="flex gap-2">
                <input
                  value={webUsername}
                  onChange={(e) => setWebUsername(e.target.value)}
                  placeholder="用户名"
                  className={inputCls("flex-1")}
                />
                <input
                  type="password"
                  value={webPassword}
                  onChange={(e) => setWebPassword(e.target.value)}
                  placeholder="密码"
                  className={inputCls("flex-1")}
                />
                <button
                  className={btnAccent()}
                  onClick={() => void webLogin()}
                  disabled={busy || !webUsername.trim() || !webPassword}
                >
                  登录
                </button>
              </div>
            )}
          </Card>
        )}

        {hostedWeb && webAccount && (
          <>
            <WebAccountCard
              onAccountDeleted={() => {
                clearHostedSession();
                clearHostedAccountState();
              }}
              onSignedOut={() => {
                clearHostedSession();
                clearHostedAccountState();
              }}
            />
            <WebReadinessCard />
            <WebProjectsCard onProjectChange={handleHostedProjectChange} />
            <WebResourcesCard key={`resources-${webProjectKey}`} />
            <WebTasksCard key={`tasks-${webProjectKey}`} />
            <WebAuditCard key={`audit-${webProjectKey}`} />
            <WebErrorsCard key={`errors-${webProjectKey}`} />
            <WebSecurityCard key={`security-${webProjectKey}`} />
          </>
        )}

        {/* The retiring kernel's own three configuration surfaces. Under DSH
          * there is nothing here a person could set: the runtime is started by
          * the control plane, the model is pinned at the gateway, and the tool
          * set is mounted by the bundle. */}
        {managedRuntime ? (
          <Card title="智能体运行时" hint="由控制面启动并管理">
            <p className="text-ui text-muted">
              本部署的运行时、模型与工具集都由服务端配置：运行时随项目启动，模型经网关固定，工具由能力包挂载。
              这里没有需要你设置的项；运行状态见上方的「就绪」卡片。
            </p>
          </Card>
        ) : (
          <>
        {/* ---- Agent runtime ---- */}
        <Card
          title="智能体运行时"
          hint={hostedWeb ? "本项目的服务端托管运行时代理" : "本机运行时，通过其 HTTP + SSE 接口驱动"}
        >
          <div className="flex items-center gap-2">
            <input
              value={serverUrl}
              onChange={(e) => {
                if (!hostedWeb) setServerUrl(e.target.value);
              }}
              readOnly={hostedWeb}
              placeholder={hostedWeb ? "托管运行时代理" : "http://127.0.0.1:4096"}
              className={inputCls(cn("flex-1 font-mono", hostedWeb && "bg-surface-2 text-muted"))}
            />
            {connected ? (
              <button onClick={disconnect} className={btnGhost()}>
                断开
              </button>
            ) : (
              <button onClick={connect} className={btnAccent()}>
                {hostedWeb ? "重新连接" : "连接"}
              </button>
            )}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-ok" : status === "error" ? "bg-error" : "bg-muted",
              )}
            />
            <span className="capitalize">{status}</span>
            {connected && defaultModel && (
              <>
                <span className="text-border">·</span>
                <span className="font-mono">{defaultModel}</span>
              </>
            )}
          </div>
        </Card>

        {/* ---- Models & providers ---- */}
        <Card
          title="模型"
          hint={
            hostedWeb
              ? "提供方由平台统一管理；用户模型密钥的加密存储暂未开放"
              : "下方接入的提供方决定了这里可选的模型"
          }
        >
          {!connected ? (
            <p className="text-ui text-muted">连接运行时后即可配置模型。</p>
          ) : (
            <>
              <div className="relative">
                <select
                  value={defaultModel ?? ""}
                  onChange={(e) => void saveModel(e.target.value)}
                  disabled={busy || hostedWeb}
                  className={cn(inputCls("w-full appearance-none pr-9"), !hostedWeb && "cursor-pointer")}
                >
                  <option value="">未设置 — 请选择默认模型</option>
                  {providers.map((p) => (
                    <optgroup key={p.id} label={p.name}>
                      {p.models.map((m) => (
                        <option key={m.id} value={`${p.id}/${m.id}`}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                />
              </div>

              <Divider label="提供方" />

              <div className="overflow-hidden rounded-input border border-border">
                {providers.map((p, i) => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex h-10 items-center gap-2.5 bg-surface px-3 text-ui",
                      i > 0 && "border-t border-border",
                    )}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                    <span className="font-medium text-text">{p.name}</span>
                    <span className="text-xs text-muted">
                      {p.models.length} 个模型
                    </span>
                    <div className="flex-1" />
                    {p.id === "opencode" ? (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-caption uppercase tracking-wide text-muted ring-1 ring-border">
                        内置 · 免费
                      </span>
                    ) : hostedWeb ? (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-caption uppercase tracking-wide text-muted ring-1 ring-border">
                        平台托管
                      </span>
                    ) : (
                      <button
                        className="text-xs text-muted transition-colors hover:text-error"
                        onClick={() => void disconnectProvider(p.id)}
                        disabled={busy}
                        title="移除该提供方的凭据/配置"
                      >
                        移除
                      </button>
                    )}
                  </div>
                ))}

                {/* Connect a provider */}
                {hostedWeb ? (
                  <p className="border-t border-border bg-surface-2/50 px-3 py-2.5 text-ui text-muted">
                    托管模型的凭据暂不在此界面管理。请在服务端运行时上配置提供方访问权限，
                    勿在浏览器可见的设置中输入 API key。
                  </p>
                ) : (
                  <>
                    <div className="border-t border-border bg-surface-2/50 p-3">
                      <div className="relative">
                        <Search
                          size={13}
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                        />
                        <input
                          list="provider-catalog"
                          value={connectQuery}
                          onChange={(e) => {
                            setConnectQuery(e.target.value);
                            cancelOAuth();
                            setPromptInputs({});
                          }}
                          placeholder={`接入提供方 — 在 ${catalog.length} 个候选中搜索（anthropic、openrouter、deepseek…）`}
                          className={inputCls("w-full pl-8")}
                        />
                        <datalist id="provider-catalog">
                          {catalog.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </datalist>
                      </div>

                      {selected && (
                        <div className="mt-2 space-y-2">
                          {methods.map((m, i) =>
                            m.type === "oauth" ? (
                              <div key={i} className="space-y-1.5">
                                {(m.prompts ?? []).map((pr) =>
                                  pr.type === "select" ? (
                                    <select
                                      key={pr.key}
                                      value={promptInputs[pr.key] ?? ""}
                                      onChange={(e) =>
                                        setPromptInputs((s) => ({ ...s, [pr.key]: e.target.value }))
                                      }
                                      className={inputCls("w-full")}
                                    >
                                      <option value="">{pr.message}</option>
                                      {(pr.options ?? []).map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                          {o.hint ? ` — ${o.hint}` : ""}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      key={pr.key}
                                      value={promptInputs[pr.key] ?? ""}
                                      onChange={(e) =>
                                        setPromptInputs((s) => ({ ...s, [pr.key]: e.target.value }))
                                      }
                                      placeholder={pr.message}
                                      className={inputCls("w-full")}
                                    />
                                  ),
                                )}
                                <button
                                  className={btnGhost("gap-1.5")}
                                  onClick={() => void startOAuth(selected.id, i, promptInputs)}
                                  disabled={busy}
                                >
                                  <ExternalLink size={12} /> {m.label}
                                </button>
                              </div>
                            ) : null,
                          )}

                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              value={keyInput}
                              onChange={(e) => setKeyInput(e.target.value)}
                              placeholder={`${selected.name} API key${selected.env[0] ? ` (${selected.env[0]})` : ""}`}
                              className={inputCls("flex-1 font-mono")}
                            />
                            <button
                              className={btnAccent()}
                              onClick={() => void saveKey(selected.id)}
                              disabled={busy || !keyInput.trim()}
                            >
                              <Check size={13} /> 保存
                            </button>
                          </div>
                        </div>
                      )}

                      {oauth && (
                        <div className="mt-2 space-y-2 rounded-input border border-border bg-surface p-3">
                          <p className="text-xs leading-relaxed text-muted">{oauth.instructions}</p>
                          {oauth.method === "code" ? (
                            <>
                              <input
                                value={codeInput}
                                onChange={(e) => setCodeInput(e.target.value)}
                                placeholder="粘贴浏览器中显示的验证码"
                                className={inputCls("w-full font-mono")}
                              />
                              <button
                                className={btnAccent()}
                                onClick={() => void completeOAuth()}
                                disabled={busy || !codeInput.trim()}
                              >
                                {busy ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Check size={13} />
                                )}
                                完成登录
                              </button>
                            </>
                          ) : (
                            <div className="flex items-center gap-2 text-xs text-muted">
                              <Loader2 size={12} className="shrink-0 animate-spin" />
                              等待你在浏览器中完成操作…
                              <button
                                className="text-muted underline transition-colors hover:text-text"
                                onClick={cancelOAuth}
                              >
                                取消
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Custom endpoint */}
                    <div className="border-t border-border">
                      <button
                        className="flex h-10 w-full items-center gap-2 px-3 text-left text-ui text-muted transition-colors hover:text-text"
                        onClick={() => setShowCustom((s) => !s)}
                        aria-expanded={showCustom}
                      >
                        <ChevronRight
                          size={13}
                          className={cn("transition-transform", showCustom && "rotate-90")}
                        />
                        自定义接入点
                        <span className="text-xs text-muted/70">
                          自托管 · 本地 Ollama · OpenAI/Anthropic 兼容
                        </span>
                      </button>
                      {showCustom && (
                        <div className="space-y-2 px-3 pb-3">
                          <div className="flex gap-2">
                            <input
                              value={cName}
                              onChange={(e) => setCName(e.target.value)}
                              placeholder="名称 — 例如 Ollama、我的 DeepSeek 网关"
                              className={inputCls("flex-1")}
                            />
                            <select
                              value={cNpm}
                              onChange={(e) => setCNpm(e.target.value)}
                              className={inputCls("w-[190px]")}
                            >
                              <option value="@ai-sdk/openai-compatible">OpenAI-compatible</option>
                              <option value="@ai-sdk/anthropic">Anthropic-compatible</option>
                            </select>
                          </div>
                          <input
                            value={cUrl}
                            onChange={(e) => setCUrl(e.target.value)}
                            placeholder="Base URL — Ollama: http://127.0.0.1:11434/v1"
                            className={inputCls("w-full font-mono")}
                          />
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={cKey}
                              onChange={(e) => setCKey(e.target.value)}
                              placeholder="API key — 可选，Ollama 不需要"
                              className={inputCls("flex-1 font-mono")}
                            />
                            <input
                              value={cModels}
                              onChange={(e) => setCModels(e.target.value)}
                              placeholder="模型 id，逗号分隔"
                              className={inputCls("flex-1 font-mono")}
                            />
                          </div>
                          <button className={btnAccent()} onClick={() => void saveCustom()} disabled={busy}>
                            添加接入点
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {isTauri && (
                <button
                  className="mt-3 flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-text"
                  onClick={() => void importLogin()}
                  disabled={busy}
                >
                  <Download size={12} />
                  已在使用 OpenCode CLI？导入其登录信息
                </button>
              )}
            </>
          )}
        </Card>

        {/* ---- MCP servers ---- */}
        <Card
          title="MCP 服务器"
          hint={
            hostedWeb
              ? "由服务端管理的运行时工具；浏览器端的配置已禁用"
              : "为智能体提供额外工具（Model Context Protocol）— 例如 Jupyter 或浏览器 MCP"
          }
        >
          {!connected ? (
            <p className="text-ui text-muted">连接运行时后即可配置 MCP 服务器。</p>
          ) : (
            <div className="overflow-hidden rounded-input border border-border">
              {/* Curated open-source science connectors — one-click enable. */}
              {hostedWeb && (
                <p className="border-b border-border bg-surface px-3 py-2.5 text-ui text-muted">
                  7 个科学连接器由服务端默认管理；Jupyter 与自定义 MCP 仍需部署方审核后配置。
                </p>
              )}
              {!hostedWeb &&
                hasCommandBackend &&
                SCIENCE_CONNECTORS.filter((c) => !mcpServers.some((s) => s.name === c.id)).map(
                  (c) => {
                    const keyMissing = Boolean(c.apiKeyEnv) && !connectorKeys[c.id]?.trim();
                    return (
                      <div
                        key={c.id}
                        className="border-b border-border bg-surface px-3 py-2.5 text-ui"
                      >
                        <div className="flex items-center gap-2.5">
                          <Search size={14} className="shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <span className="font-medium text-text">{c.label}</span>
                            <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-caption uppercase tracking-wide text-muted ring-1 ring-border">
                              {c.discipline}
                            </span>
                            <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-caption uppercase tracking-wide text-muted ring-1 ring-border">
                              开源
                            </span>
                            <div className="truncate text-xs text-muted">{c.description}</div>
                            <div className="truncate font-mono text-caption text-muted/70">
                              {c.source}
                              {c.installNote ? ` · ${c.installNote}` : ""}
                            </div>
                          </div>
                          <button
                            className={btnAccent("h-8")}
                            onClick={() => void enableConnector(c.id)}
                            disabled={enablingConnector !== null || busy || keyMissing}
                            title={keyMissing ? "请先填写 API key" : undefined}
                          >
                            {enablingConnector === c.id ? (
                              <>
                                <Loader2 size={12} className="animate-spin" /> 正在配置…
                              </>
                            ) : (
                              "启用"
                            )}
                          </button>
                        </div>
                        {c.apiKeyEnv && (
                          <div className="mt-2 flex items-center gap-2 pl-6">
                            <input
                              type="password"
                              value={connectorKeys[c.id] ?? ""}
                              onChange={(e) =>
                                setConnectorKeys((k) => ({ ...k, [c.id]: e.target.value }))
                              }
                              placeholder={`${c.apiKeyEnv}（免费 key）`}
                              className="h-8 min-w-0 flex-1 rounded-input border border-border bg-surface-2 px-2 font-mono text-ui-sm text-text placeholder:text-muted/60"
                            />
                            {c.apiKeyUrl && (
                              <a
                                href={c.apiKeyUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 whitespace-nowrap text-caption text-accent hover:underline"
                              >
                                <ExternalLink size={11} /> 获取免费 key
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              {/* Featured: one-click Jupyter (shown until its MCP entry exists). */}
              {!hostedWeb && hasCommandBackend && !mcpServers.some((s) => s.name === "jupyter") && (
                <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-2.5 text-ui">
                  <NotebookPen size={14} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-text">Jupyter</span>
                    <span className="ml-2 text-xs text-muted">
                      让智能体操作真实笔记本 · 隔离环境，首次运行约 300 MB
                    </span>
                  </div>
                  <button
                    className={btnAccent("h-8")}
                    onClick={() => void enableJupyter()}
                    disabled={settingUpJupyter || busy}
                  >
                    {settingUpJupyter ? (
                      <>
                        <Loader2 size={12} className="animate-spin" /> 正在配置…
                      </>
                    ) : jupyter?.installed ? (
                      "启用"
                    ) : (
                      "配置并启用"
                    )}
                  </button>
                </div>
              )}
              {mcpServers.map((s, i) => (
                <div
                  key={s.name}
                  className={cn(
                    "flex h-10 items-center gap-2.5 bg-surface px-3 text-ui",
                    i > 0 && "border-t border-border",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      s.status === "connected"
                        ? "bg-ok"
                        : s.status === "failed"
                          ? "bg-error"
                          : "bg-muted",
                    )}
                  />
                  <span className="font-medium text-text">{s.name}</span>
                  <span className="text-xs text-muted">
                    {hostedWeb ? "服务端托管" : s.config?.type ?? "?"} · {s.status}
                  </span>
                  <span className="max-w-[260px] flex-1 truncate text-right font-mono text-caption text-muted/70">
                    {hostedWeb
                      ? "由部署方配置"
                      : s.config?.type === "local"
                        ? s.config.command.join(" ")
                        : s.config?.type === "remote"
                          ? s.config.url
                          : ""}
                  </span>
                  {!hostedWeb && (
                    <button
                      className="shrink-0 text-xs text-muted transition-colors hover:text-error"
                      onClick={() => void removeMcp(s.name)}
                      disabled={busy}
                    >
                      移除
                    </button>
                  )}
                </div>
              ))}

              {!hostedWeb && (
                <div
                  className={cn(
                    "space-y-2 bg-surface-2/50 p-3",
                    mcpServers.length > 0 && "border-t border-border",
                  )}
                >
                  <div className="flex gap-2">
                    <input
                      value={mName}
                      onChange={(e) => setMName(e.target.value)}
                      placeholder="名称 — 例如 jupyter、playwright"
                      className={inputCls("flex-1")}
                    />
                    <select
                      value={mType}
                      onChange={(e) => setMType(e.target.value as "local" | "remote")}
                      className={inputCls("w-[110px]")}
                    >
                      <option value="local">local</option>
                      <option value="remote">remote</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={mTarget}
                      onChange={(e) => setMTarget(e.target.value)}
                      placeholder={
                        mType === "local"
                          ? "命令 — 例如 npx -y @playwright/mcp"
                          : "URL — 例如 https://example.com/mcp"
                      }
                      className={inputCls("flex-1 font-mono")}
                    />
                    <button className={btnAccent()} onClick={() => void addMcp()} disabled={busy}>
                      添加服务器
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
          </>
        )}

        {/* ---- Workspace ---- */}
        <Card
          title="工作区"
          hint={hostedWeb ? "由服务端管理的项目工作区" : "本地优先 — 每个会话都在此处创建的独立日期子文件夹中工作"}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                inputCls("flex-1 truncate font-mono leading-9"),
                "select-all bg-surface-2 text-muted",
              )}
            >
              {wsPath ?? "在桌面应用中可用"}
            </span>
            {!hostedWeb && wsPath && (
              <>
                <button className={btnGhost("gap-1.5")} onClick={() => void changeWorkspaceBase()}>
                  更改…
                </button>
                <button className={btnGhost("gap-1.5")} onClick={() => void openWorkspaceBase()}>
                  <FolderOpen size={13} /> 在文件夹中显示
                </button>
              </>
            )}
          </div>
        </Card>

        {/* ---- Cluster (HPC) ---- */}
        {!hostedWeb && <ClusterCard />}

        {!hostedWeb && <ModalCard />}

        {/* ---- Privacy & data flow ---- */}
        <DataFlowCard model={defaultModel} workspace={wsPath} hosted={hostedWeb} />

        {/* ---- Appearance ---- */}
        <Card title="外观">
          <ThemeSegmentedControl />
        </Card>
      </div>
    </div>
  );
}

/** The one three-way theme switch — used by both the desktop settings page and
 *  the hosted account page so there is no second implementation to drift. */
export function ThemeSegmentedControl() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  return (
    <SegmentedControl
      aria-label="外观主题"
      value={theme}
      onChange={setTheme}
      options={[
        { value: "light", label: "浅色" },
        { value: "dark", label: "深色" },
        { value: "system", label: "跟随系统" },
      ]}
    />
  );
}

/* ---- Shared bits: one look for every control on this page ----
 * Thin wrappers over the components/ui primitives (P2-1) so the ~30 call
 * sites on this page keep their class-string shape. */

const inputCls = (extra = "") => inputClasses({ className: extra });

const btnGhost = (extra = "") => buttonClasses({ variant: "ghost", className: extra });

const btnAccent = (extra = "") => buttonClasses({ variant: "primary", className: extra });

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <CardPrimitive title={title} hint={hint} className="mt-5">
      {children}
    </CardPrimitive>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="mb-3 mt-5 flex items-center gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
