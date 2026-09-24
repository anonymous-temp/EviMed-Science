import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, ExternalLink, MessageSquareText, QrCode, Smartphone, Unlink } from "lucide-react";
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
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/** How often a waiting registration is asked about; the SDK itself polls Feishu every 5 s. */
const REGISTRATION_POLL_MS = 2_000;

/**
 * Feishu on the phone: scan once, and the researcher has a bot of their own in
 * their own Feishu tenant — questions sent to it run like questions asked
 * here, progress shows on one card, and results, files and inbox notices
 * arrive in Feishu (plan §3.6).
 *
 * The page is a view of the server's state, never a second copy of it: the
 * QR code renders the link the SDK built (the bare verification link shows
 * 「链接已过期」), and every state and sentence of a failure comes from the
 * control plane.
 */
export function FeishuCard() {
  const [status, setStatus] = useState<ImStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [registration, setRegistration] = useState<FeishuRegistration | null>(null);
  const [busy, setBusy] = useState<"start" | "cancel" | "notify" | "unbind" | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await fetchImStatus();
      if (!mounted.current) return;
      setStatus(next);
      setLoadError(null);
      if (next.registration && ACTIVE_REGISTRATION_STATES.has(next.registration.state)) setRegistration(next.registration);
    } catch (error) {
      if (mounted.current) setLoadError(webErrorMessage(error, { fallback: "无法读取飞书连接状态，请稍后重试。" }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

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
            toast.success(next.result?.pendingApproval
              ? "机器人已创建，等待你所在企业的管理员启用。"
              : "飞书机器人已连接，现在可以在飞书里提问了。");
            void load();
          }
        })
        .catch(() => {
          // A missed poll is retried on the next tick; the state stays as shown.
          if (mounted.current) setRegistration((current) => (current ? { ...current } : current));
        });
    }, REGISTRATION_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, registration, load]);

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

  const toggleNotifications = async (binding: FeishuBinding) => {
    setBusy("notify");
    try {
      await setFeishuNotifications(!binding.notifications);
      toast.success(binding.notifications ? "已停止把通知推送到飞书。" : "通知会推送到飞书。");
      await load();
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
      toast.success("已解除飞书机器人的绑定。");
      await load();
    } catch (error) {
      toast.error(`解除绑定失败：${webErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const binding = status?.feishu && status.feishu.bound ? status.feishu : null;

  return (
    <Card
      title="飞书"
      hint="在手机上用飞书向 EviMed 提问、派发研究任务，并接收完成通知。"
    >
      {loadError && (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-ui text-error">{loadError}</p>
          <Button size="sm" variant="ghost" onClick={() => void load()}>重试</Button>
        </div>
      )}
      {!loadError && !status && (
        <div className="flex flex-col gap-2" role="status" aria-label="正在读取飞书连接状态">
          <div className="h-4 w-2/3 animate-pulse rounded-input bg-surface-2" />
          <div className="h-4 w-1/2 animate-pulse rounded-input bg-surface-2" />
        </div>
      )}
      {status && !loadError && (
        binding
          ? <BoundView binding={binding} busy={busy} onToggle={() => void toggleNotifications(binding)} onUnbind={() => setConfirmUnbind(true)} />
          : waiting && registration
            ? <ScanView registration={registration} cancelling={busy === "cancel"} onCancel={() => void cancel()} />
            : <UnboundView registration={registration} starting={busy === "start"} onStart={() => void start()} />
      )}
      {confirmUnbind && (
        <ConfirmDialog
          title="解除飞书机器人的绑定？"
          body="解除后，飞书里的消息不再派发研究任务，通知也不再推送到飞书；已经完成的研究不受影响。机器人应用仍在你的飞书里，不再需要时可以在飞书开发者后台删除。"
          confirmLabel="解除绑定"
          onConfirm={() => {
            setConfirmUnbind(false);
            void unbind();
          }}
          onCancel={() => setConfirmUnbind(false)}
        />
      )}
    </Card>
  );
}

function UnboundView({ registration, starting, onStart }: {
  registration: FeishuRegistration | null;
  starting: boolean;
  onStart: () => void;
}) {
  const ended = registration && ["expired", "cancelled", "error"].includes(registration.state) ? registration : null;
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2 text-ui text-text">
        <li className="flex items-start gap-2">
          <QrCode size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          用飞书扫一次码，就会在你自己的飞书里创建一个专属的 EviMed 研究助手，个人版飞书也可以。
        </li>
        <li className="flex items-start gap-2">
          <MessageSquareText size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          直接把问题发给它：简单问题当场回答，深度任务在一张卡片上显示进度，完成后发来结果和报告文件。
        </li>
        <li className="flex items-start gap-2">
          <BellRing size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          收件箱通知和主动科研的晨间简报也会推送到飞书，夜间免打扰时段顺延到早上。
        </li>
      </ul>
      {ended?.error && (
        <p className="text-ui text-error" role="alert">{ended.error.message}</p>
      )}
      <div>
        <Button onClick={onStart} loading={starting}>
          <QrCode size={16} aria-hidden="true" />
          {ended ? "重新生成二维码" : "扫码创建飞书机器人"}
        </Button>
      </div>
    </div>
  );
}

function ScanView({ registration, cancelling, onCancel }: {
  registration: FeishuRegistration;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const url = registration.qrCodeUrl;
  const saving = registration.state === "saving";
  const minutes = registration.remainingSeconds != null ? Math.max(1, Math.ceil(registration.remainingSeconds / 60)) : null;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      {url && !saving ? (
        <FeishuQrCode value={url} />
      ) : (
        <div className="grid h-48 w-48 shrink-0 place-items-center rounded-input bg-surface-2 text-caption text-muted" role="status">
          {saving ? "正在保存机器人…" : "正在生成二维码…"}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-ui text-text">
          {saving
            ? "已在飞书里创建，正在连接你的机器人。"
            : "用飞书扫描二维码，在飞书里确认创建。"}
        </p>
        {registration.state === "domain_switched" && (
          <p className="text-caption text-muted">识别到你使用的是 Lark（国际版），已自动切换。</p>
        )}
        {url && !saving && (
          <a href={url} target="_blank" rel="noreferrer"
            className="inline-flex min-h-8 items-center gap-1 text-ui text-link hover:underline">
            <Smartphone size={16} aria-hidden="true" />
            正在用手机？直接在飞书中打开
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        )}
        {minutes != null && !saving && <p className="text-caption text-muted">二维码约 {minutes} 分钟内有效。</p>}
        <div>
          <Button variant="ghost" size="sm" onClick={onCancel} loading={cancelling} disabled={saving}>取消</Button>
        </div>
      </div>
    </div>
  );
}

const CONNECTION_LABELS: Record<string, string> = {
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "正在重连",
  failed: "连接中断，稍后自动重试",
  stopped: "未连接",
};

function BoundView({ binding, busy, onToggle, onUnbind }: {
  binding: FeishuBinding;
  busy: string | null;
  onToggle: () => void;
  onUnbind: () => void;
}) {
  const state = binding.activation === "pending" ? "等待企业管理员启用"
    : binding.activation === "disabled" ? "已被飞书企业停用"
      : CONNECTION_LABELS[binding.connection?.state ?? "connecting"] ?? "正在连接";
  const healthy = binding.activation === "active" && binding.connection?.state === "connected";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-text">{binding.botName ?? "EviMed 研究助手"}</div>
          <div className="mt-0.5 text-caption text-muted">
            {binding.tenantBrand === "lark" ? "Lark" : "飞书"} · {binding.appId} · 绑定于 {new Date(binding.boundAt).toLocaleDateString("zh-CN")}
          </div>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-caption font-medium",
          healthy ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn")}>
          {state}
        </span>
      </div>
      {binding.activation === "pending" && (
        <p className="text-ui text-text">你所在的飞书企业需要管理员在飞书管理后台启用这个应用。启用后会自动连上，不用重新扫码。</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="min-w-0">
          <div className="text-ui text-text">把通知推送到飞书</div>
          <div className="text-caption text-muted">研究完成、需要你处理的事项和晨间简报；夜间免打扰时段顺延到早上。</div>
        </div>
        <Button variant="ghost" size="sm" onClick={onToggle} loading={busy === "notify"} aria-pressed={binding.notifications}>
          {binding.notifications ? "已开启" : "已关闭"}
        </Button>
      </div>
      <div className="border-t border-border pt-4">
        <div className="text-ui text-text">对话去向</div>
        <ul className="mt-2 flex flex-col gap-1 text-caption text-muted">
          {binding.chats.length === 0 && <li>还没有收到消息。单聊时问题会放进你最近使用的项目；说「换到某某项目」就能切换。</li>}
          {binding.chats.map((chat, index) => (
            <li key={`${chat.chatType}-${index}`}>
              {chat.chatType === "p2p" ? "单聊" : "群聊"} ·{" "}
              {chat.projectName ? `项目「${chat.projectName}」` : "跟随你最近使用的项目"}
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-border pt-4">
        <Button variant="ghost" size="sm" onClick={onUnbind} loading={busy === "unbind"}>
          <Unlink size={16} aria-hidden="true" />
          解除绑定
        </Button>
      </div>
    </div>
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
      className="h-48 w-48 shrink-0 rounded-input bg-white text-black ring-1 ring-border"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
