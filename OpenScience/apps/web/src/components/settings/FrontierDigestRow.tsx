import { useCallback, useEffect, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { fetchFrontierDigestSwitch, setFrontierDigestSwitch, type FrontierFeature } from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { PanelRow } from "@/components/ui/Panel";
import { Switch } from "@/components/ui/Switch";

type SwitchState = { kind: "loading" } | { kind: "ready"; enabled: boolean } | { kind: "error"; message: string };

/**
 * 「前沿日报」 under 通知: the one switch for the daily's push (build spec
 * D.3). It is one of the inbox's notification switches (`frontier`, on unless
 * turned off) and is written through the inbox's own preferences, so the
 * daily arrives at the reader's own digest time like any briefing — and,
 * where they bound Feishu, in Feishu too.
 *
 * Shown only where this account is offered the feed at all (`/api/me`
 * `features.frontier`, read by the section and passed in): a switch for a
 * module the reader cannot see would be a setting for nothing.
 */
export function FrontierDigestRow({ feature }: { feature: FrontierFeature }) {
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
      toast.success(enabled ? "已开启前沿日报推送" : "已关闭前沿日报推送");
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "推送设置没有保存成功，请稍后重试。" }));
    } finally {
      setBusy(false);
    }
  }, [state, busy]);

  if (feature !== "on") return null;
  return (
    <PanelRow
      label="前沿日报"
      description={state.kind === "error" ? <span role="alert">{state.message}</span> : undefined}
      control={state.kind === "error"
        ? <Button variant="text" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
        : <Switch label="前沿日报" checked={state.kind === "ready" && state.enabled} disabled={state.kind !== "ready" || busy} onChange={() => void toggle()} />}
    />
  );
}
