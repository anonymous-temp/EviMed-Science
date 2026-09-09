import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { fetchWebConnectors, type WebConnector } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";

/**
 * The one-time nudge after login: sources the deployment has not configured
 * and that need a key, listed by name with what each one unlocks.
 *
 * It appears only when there is something to do, and "稍后再说" is honoured
 * for a week in this browser — a prompt that returns on every page load
 * teaches people to dismiss prompts. A source the deployment has configured,
 * one the researcher already filled in, or one that works without a key
 * never appears here.
 */
export const CONNECTOR_PROMPT_SNOOZE_KEY = "openScience.connectorPrompt.snoozedUntil";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function ConnectorPrompt() {
  const navigate = useNavigate();
  const [pending, setPending] = useState<WebConnector[] | null>(null);

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

  if (!pending || pending.length === 0) return null;

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
              setPending([]);
              navigate("/app/account#connectors");
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
