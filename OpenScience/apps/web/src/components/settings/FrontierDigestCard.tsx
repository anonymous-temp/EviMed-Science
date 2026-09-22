import { useCallback, useEffect, useState } from "react";
import { Newspaper } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { fetchFrontierDigestSwitch, setFrontierDigestSwitch, useFrontierFeature } from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type SwitchState = { kind: "loading" } | { kind: "ready"; enabled: boolean } | { kind: "error"; message: string };

/**
 * 「前沿动态日报」 under 通知: the one switch for the daily's push (build spec
 * D.3). It is one of the inbox's notification switches (`frontier`, on unless
 * turned off) and is written through the inbox's own preferences, so the
 * daily arrives at the reader's own digest time like any briefing — and, where
 * they bound Feishu, in Feishu too.
 *
 * Shown only where this account is offered the feed at all (`/api/me`
 * `features.frontier`): a switch for a module the reader cannot see would be
 * a setting for nothing.
 */
export function FrontierDigestCard() {
  const feature = useFrontierFeature();
  const [state, setState] = useState<SwitchState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (feature !== "on") return;
    let active = true;
    setState({ kind: "loading" });
    fetchFrontierDigestSwitch().then(
      (enabled) => { if (active) setState({ kind: "ready", enabled }); },
      (error: unknown) => { if (active) setState({ kind: "error", message: webErrorMessage(error, { fallback: "无法读取推送设置，请稍后重试。" }) }); },
    );
    return () => { active = false; };
  }, [feature, attempt]);

  const toggle = useCallback(async () => {
    if (state.kind !== "ready" || busy) return;
    const next = !state.enabled;
    setBusy(true);
    try {
      const enabled = await setFrontierDigestSwitch(next);
      setState({ kind: "ready", enabled });
      toast.success(enabled ? "已开启：每天在你的简报时间收到前沿日报。" : "已关闭前沿日报的推送，前沿动态页面照常可看。");
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "推送设置没有保存成功，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  }, [state, busy]);

  if (feature !== "on") return null;
  return (
    <Card className="mt-5" title="前沿动态日报" hint="每天在你的简报时间，把当天的前沿日报放进收件箱；开了飞书推送的，也会推到飞书。只推给近两周看过前沿动态、或关注了什么的人。">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Newspaper size={16} className="shrink-0 text-muted" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-ui text-text">每天推送日报</div>
            <div className="text-caption text-muted">推送里只有当天的条数和头条，不含你的个人信息。</div>
          </div>
        </div>
        {state.kind === "error" ? (
          <div role="alert" className="flex items-center gap-2 text-caption text-muted">
            <span>{state.message}</span>
            <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => void toggle()} loading={state.kind === "loading" || busy}
            disabled={state.kind !== "ready"} aria-pressed={state.kind === "ready" ? state.enabled : undefined}>
            {state.kind === "ready" && !state.enabled ? "已关闭" : "已开启"}
          </Button>
        )}
      </div>
    </Card>
  );
}
