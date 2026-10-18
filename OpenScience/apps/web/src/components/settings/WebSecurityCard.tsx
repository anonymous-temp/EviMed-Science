import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldX } from "lucide-react";
import { knownErrorCodeMessage } from "@evimed/domain";
import { webErrorMessage, listWebSecurityEvents, type WebSecurityEvent } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { LEDGER_STATUS_LABEL, labelFor, securityActionLabel } from "@/lib/statusLabel";
import { toast } from "@/lib/toast";
import { formatClock } from "@/lib/format";
import { Tooltip } from "@/components/ui/Tooltip";
import { CopyId, OPS_TONE, OpsBody, OpsCard, OpsNothing, OpsRow, OpsRows } from "./OpsCard";

export function WebSecurityCard() {
  const [events, setEvents] = useState<WebSecurityEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listWebSecurityEvents(20));
    } catch (e) {
      toast.error(`无法读取安全日志：${webErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <OpsCard title="安全事件" description="该账户最近的认证事件" refresh={{ label: "刷新安全事件", loading, onRefresh: () => void refresh() }}>
      <OpsBody>
        <OpsRows label="认证事件">
          {events.length === 0 ? (
            <OpsNothing>暂无近期安全事件。</OpsNothing>
          ) : (
            events.map((event, index) => {
              const failed = event.status === "failed";
              // A refusal says why in words; the code and the account it came from are a copy button's, not page text.
              const detail = event.code ? knownErrorCodeMessage(event.code) ?? "其他原因" : "";
              const identifier = [event.code, event.userId ?? event.username].filter(Boolean).join(" ");
              return (
                <OpsRow key={`${event.action}-${event.createdAt}-${index}`}>
                  {failed ? (
                    <ShieldX size={16} className="shrink-0 text-error" aria-hidden="true" />
                  ) : (
                    <ShieldCheck size={16} className="shrink-0 text-text-3" aria-hidden="true" />
                  )}
                  <Tooltip content={event.action}>
                    <span className="w-20 shrink-0 text-caption text-text">{securityActionLabel(event.action)}</span>
                  </Tooltip>
                  <Tooltip content={event.status}>
                    <span className={cn("w-20 shrink-0 text-caption", failed && OPS_TONE.failed)}>
                      {labelFor(LEDGER_STATUS_LABEL, event.status)}
                    </span>
                  </Tooltip>
                  <span className="min-w-0 flex-1 truncate text-caption text-text-3">{detail}</span>
                  {identifier && <CopyId value={identifier} label="复制事件标识" />}
                  <span className="shrink-0 font-mono text-caption text-text-3">{formatClock(event.createdAt)}</span>
                </OpsRow>
              );
            })
          )}
        </OpsRows>
      </OpsBody>
    </OpsCard>
  );
}
