import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { fetchWebConnectors, type WebConnector } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";

/**
 * The one-time card after login: sources the deployment has not configured
 * and that need a key, listed by name with what each one unlocks.
 *
 * It appears only when there is something to do, at most once per browser, and
 * only on the pages listed in `BANNER_PATHS`. It used to sit above every route
 * including the conversation, where it took 120 px off the top of the kernel
 * frame and greeted a new account with seven English source names before
 * anything else (2026-09-15 walk, B5); dismissing it hid it for a week, and
 * then it came back. Once dismissed — by either button or the close control —
 * it is done, because the same seven sources are a permanent tab on the account
 * page and a banner that returns is a banner people stop reading.
 *
 * Two things the 2026-09-16 walk found, both fixed here. "去配置" cleared the
 * banner without recording the dismissal, so navigating there and back brought
 * it straight back — the button that means "yes, I am dealing with this" was
 * the one that did not count as dealing with it. And the shell showed the
 * banner on every non-chat path, which included the connectors tab it points
 * at and the 404 page. The allowlist below is what makes an unrouted address
 * safe by construction rather than by remembering to exclude it.
 */
const BANNER_PATHS = new Set([
  "/app/runs",
  "/app/files",
  "/app/autopilot",
  "/app/memory",
  "/app/inbox",
  "/app/capabilities",
  "/app/account",
]);
export const CONNECTOR_PROMPT_SNOOZE_KEY = "openScience.connectorPrompt.snoozedUntil";
/** Far enough that "dismissed" means dismissed. Kept as a timestamp rather
 *  than a flag so a browser that already snoozed is not asked again first. */
const SNOOZE_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export function ConnectorPrompt() {
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState<WebConnector[] | null>(null);
  const onConnectorsTab = location.pathname === "/app/account"
    && new URLSearchParams(location.search).get("tab") === "connectors";
  const showsHere = BANNER_PATHS.has(location.pathname) && !onConnectorsTab;

  useEffect(() => {
    const snoozedUntil = Number(localStorage.getItem(CONNECTOR_PROMPT_SNOOZE_KEY) ?? 0);
    if (Number.isFinite(snoozedUntil) && snoozedUntil > Date.now()) return;
    let active = true;
    fetchWebConnectors()
      .then((list) => {
        if (active) setPending(list.filter((c) => c.needsAttention));
      })
      // A deployment without the store, or a fetch that failed, is not a
      // reason to interrupt anyone.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (!showsHere || !pending || pending.length === 0) return null;

  const snooze = () => {
    localStorage.setItem(CONNECTOR_PROMPT_SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    setPending([]);
  };

  return (
    <div
      role="region"
      aria-label="数据源凭据提示"
      className="mx-4 mt-3 flex items-start gap-3 rounded-card border border-border bg-surface-2 px-4 py-3 shadow-card"
    >
      <KeyRound size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-ui text-text">
          {pending.length} 个数据源本部署没有配置凭据，需要用到时可以填入你自己的：
          {pending.map((c) => c.title).join("、")}。
        </p>
        <p className="mt-0.5 text-caption text-muted">
          {pending
            .slice(0, 3)
            .map((c) => `${c.title}：${c.unlocks}`)
            .join(" ")}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              snooze();
              navigate("/app/account?tab=connectors");
            }}
          >
            去配置
          </Button>
          <Button type="button" variant="ghost" onClick={snooze}>
            稍后再说
          </Button>
        </div>
      </div>
      <button type="button" aria-label="关闭提示" onClick={snooze} className="rounded p-1 text-muted hover:bg-surface hover:text-text">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
