import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import { encode } from "uqr";
import { webErrorMessage } from "@/lib/apiClient";
import {
  ACTIVE_REGISTRATION_STATES,
  cancelFeishuRegistration,
  fetchFeishuRegistration,
  fetchImStatus,
  setFeishuNotifications,
  startFeishuRegistration,
  unbindFeishu,
  type FeishuBinding,
  type FeishuRegistration,
  type ImStatus,
} from "@/lib/imClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu } from "@/components/ui/Menu";
import { PanelRow } from "@/components/ui/Panel";
import { Switch } from "@/components/ui/Switch";
import { toast } from "@/lib/toast";

/** How often a waiting registration is asked about; the SDK itself polls Feishu every 5 s. */
const REGISTRATION_POLL_MS = 2_000;

/**
 * The IM module's status, read by whichever of the two Feishu rows is on
 * screen: binding lives under 账户, the push switch under 通知 (2026-09-23
 * plan §5.9). The page is a view of the server's state, never a second copy
 * of it: the QR code renders the link the SDK built, and every state and
 * sentence of a failure comes from the control plane.
 */
function useImStatus() {
  const [status, setStatus] = useState<ImStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try {
      const next = await fetchImStatus();
      if (!mounted.current) return null;
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (mounted.current) setLoadError(webErrorMessage(error, { fallback: "无法读取飞书连接状态，请稍后重试。" }));
      return null;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  const binding = status?.feishu && status.feishu.bound ? status.feishu : null;
  return { status, binding, loadError, load, mounted };
}

const CONNECTION_LABELS: Record<string, string> = {
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "正在重连",
  failed: "连接中断",
  stopped: "未连接",
};

function bindingState(binding: FeishuBinding): { text: string; healthy: boolean } {
  if (binding.activation === "pending") return { text: "等待企业管理员启用", healthy: false };
  if (binding.activation === "disabled") return { text: "已被飞书企业停用", healthy: false };
  const state = binding.connection?.state ?? "connecting";
  return { text: CONNECTION_LABELS[state] ?? "正在连接", healthy: state === "connected" };
}

/**
 * 「飞书」 under 账户: scan once, and the researcher has a bot of their own in
 * their own Feishu — questions sent to it run like questions asked here, and
 * results and notices arrive there (plan §3.6). 绑定 opens the QR code under
 * the row; a bound bot says its state, and its 「⋯」 holds where each chat's
 * questions go and 解除绑定.
 */
export function FeishuAccountRow() {
  const { status, binding, loadError, load, mounted } = useImStatus();
  const [registration, setRegistration] = useState<FeishuRegistration | null>(null);
  const [busy, setBusy] = useState<"start" | "cancel" | "unbind" | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [showChats, setShowChats] = useState(false);

  useEffect(() => {
    if (status?.registration && ACTIVE_REGISTRATION_STATES.has(status.registration.state)) setRegistration(status.registration);
  }, [status]);

  // While a scan is pending, ask the server how it is going.
  const waiting = registration != null && ACTIVE_REGISTRATION_STATES.has(registration.state);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      void fetchFeishuRegistration()
        .then((next) => {
          if (!mounted.current) return;
          setRegistration(next);
          if (next.state === "succeeded") {
            toast.success(next.result?.pendingApproval ? "机器人已创建，等待企业管理员启用" : "飞书已绑定");
            void load();
          }
        })
        .catch(() => {
          // A missed poll is retried on the next tick; the state stays as shown.
          if (mounted.current) setRegistration((current) => (current ? { ...current } : current));
        });
    }, REGISTRATION_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, registration, load, mounted]);

  const start = async () => {
    setBusy("start");
    try {
      setRegistration(await startFeishuRegistration());
    } catch (error) {
      toast.error(`无法生成二维码：${webErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy("cancel");
    try {
      setRegistration(await cancelFeishuRegistration());
    } catch (error) {
      toast.error(webErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const unbind = async () => {
    setBusy("unbind");
    try {
      await unbindFeishu();
      setRegistration(null);
      setShowChats(false);
      toast.success("已解除飞书绑定");
      await load();
    } catch (error) {
      toast.error(`解除绑定失败：${webErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const dialog = confirmUnbind && createPortal(
    <ConfirmDialog
      title="解除飞书机器人的绑定？"
      body="解除后，飞书里的消息不再派发研究任务，通知也不再推送到飞书；已经完成的研究不受影响。机器人应用仍在你的飞书里，不再需要时可以在飞书开发者后台删除。"
      confirmLabel="解除绑定"
      onConfirm={() => { setConfirmUnbind(false); void unbind(); }}
      onCancel={() => setConfirmUnbind(false)}
    />,
    document.body,
  );

  if (loadError) {
    return (
      <PanelRow
        label="飞书"
        description={<span role="alert" className="text-error">{loadError}</span>}
        control={<Button variant="text" onClick={() => void load()}>重试</Button>}
      />
    );
  }
  if (!status) return <PanelRow label="飞书" />;

  if (binding) {
    const state = bindingState(binding);
    return (
      <PanelRow
        label="飞书"
        description={`${binding.botName ?? "EviMed 研究助手"} · 绑定于 ${new Date(binding.boundAt).toLocaleDateString("zh-CN")}`}
        control={(
          <>
            <span className={state.healthy ? undefined : "text-warn-strong"}>{state.text}</span>
            <Menu
              label="飞书的更多操作"
              items={[
                { label: showChats ? "收起对话去向" : "对话去向", onSelect: () => setShowChats((value) => !value) },
                { label: "解除绑定", destructive: true, disabled: busy !== null, onSelect: () => setConfirmUnbind(true) },
              ]}
            />
            {dialog}
          </>
        )}
      >
        {(binding.activation === "pending" || showChats) && (
          <div className="space-y-2 text-caption text-text-3">
            {binding.activation === "pending" && <p className="text-ui text-text">需要企业管理员在飞书管理后台启用这个应用，启用后自动连上。</p>}
            {showChats && (
              <ul className="space-y-1" aria-label="对话去向">
                {binding.chats.length === 0 && <li>还没有收到消息。</li>}
                {binding.chats.map((chat, index) => (
                  <li key={`${chat.chatType}-${index}`}>
                    {chat.chatType === "p2p" ? "单聊" : "群聊"} · {chat.projectName ? `项目「${chat.projectName}」` : "跟随你最近使用的项目"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PanelRow>
    );
  }

  if (waiting && registration) {
    const url = registration.qrCodeUrl;
    const saving = registration.state === "saving";
    const minutes = registration.remainingSeconds != null ? Math.max(1, Math.ceil(registration.remainingSeconds / 60)) : null;
    return (
      <PanelRow
        label="飞书"
        description={saving ? "已在飞书里创建，正在连接你的机器人。" : "用飞书扫描二维码，在飞书里确认创建。"}
        control={<Button variant="text" onClick={() => void cancel()} loading={busy === "cancel"} disabled={saving}>取消</Button>}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {url && !saving ? <FeishuQrCode value={url} /> : (
            <div className="grid h-48 w-48 shrink-0 place-items-center rounded bg-surface-2 text-caption text-text-3" role="status">
              {saving ? "正在保存机器人…" : "正在生成二维码…"}
            </div>
          )}
          <div className="flex flex-col gap-1 text-caption text-text-3">
            {url && !saving && (
              <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1 text-ui text-accent hover:underline">
                在手机上直接打开飞书
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            )}
            {minutes != null && !saving && <p>二维码约 {minutes} 分钟内有效。</p>}
          </div>
        </div>
      </PanelRow>
    );
  }

  const ended = registration && ["expired", "cancelled", "error"].includes(registration.state) ? registration : null;
  return (
    <PanelRow
      label="飞书"
      description={ended?.error
        ? <span role="alert" className="text-error">{ended.error.message}</span>
        : "研究完成和每日前沿推送到飞书"}
      control={<Button variant="secondary" onClick={() => void start()} loading={busy === "start"}>{ended ? "重新绑定" : "绑定"}</Button>}
    />
  );
}

/**
 * 「飞书」 under 通知: whether notices are pushed to the bound bot. A switch, as
 * every on/off in the product is now; an account that has not bound Feishu is
 * sent to 账户 to do it.
 */
export function FeishuPushRow() {
  const { status, binding, loadError, load } = useImStatus();
  const [busy, setBusy] = useState(false);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await setFeishuNotifications(on);
      toast.success(on ? "通知会推送到飞书" : "已停止推送到飞书");
      await load();
    } catch (error) {
      toast.error(webErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <PanelRow
        label="飞书"
        description={<span role="alert" className="text-error">{loadError}</span>}
        control={<Button variant="text" onClick={() => void load()}>重试</Button>}
      />
    );
  }
  return (
    <PanelRow
      label="飞书"
      control={!status ? undefined : binding
        ? <Switch label="推送到飞书" checked={binding.notifications} disabled={busy} onChange={(on) => void toggle(on)} />
        : <Link to="/app/account" className={buttonClasses({ variant: "secondary" })}>绑定</Link>}
    />
  );
}

/**
 * The link as a QR code, drawn from the encoder's module matrix with the
 * page's own SVG: dark on white in both themes, like every figure (a scanner
 * reads an inverted code badly).
 */
export function FeishuQrCode({ value }: { value: string }) {
  const matrix = useMemo(() => encode(value, { ecc: "M", border: 2 }), [value]);
  const path = useMemo(() => {
    let d = "";
    matrix.data.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }));
    return d;
  }, [matrix]);
  return (
    <svg
      role="img"
      aria-label="飞书扫码创建机器人的二维码"
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      shapeRendering="crispEdges"
      className="h-48 w-48 shrink-0 rounded bg-white text-black ring-1 ring-border"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
