import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { knownErrorCodeMessage } from "@evimed/domain";
import { webErrorMessage, listWebErrorEvents, type WebErrorEvent } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { formatClock } from "@/lib/format";
import { Tooltip } from "@/components/ui/Tooltip";
import { CopyId, OpsBody, OpsCard, OpsNothing, OpsRow, OpsRows } from "./OpsCard";

export function WebErrorsCard() {
  const [events, setEvents] = useState<WebErrorEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listWebErrorEvents(20));
    } catch (e) {
      toast.error(`无法读取错误账本：${webErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <OpsCard title="错误账本" description="该项目最近失败的 API 请求" refresh={{ label: "刷新错误列表", loading, onRefresh: () => void refresh() }}>
      <OpsBody>
        <OpsRows label="失败的请求">
          {events.length === 0 ? (
            <OpsNothing>暂无近期 API 错误。</OpsNothing>
          ) : (
            events.map((event, index) => {
              // The code and the request id are for whoever searches the logs: one copy button holds both, and the row says what went wrong.
              const identifier = [event.code, event.requestId].filter(Boolean).join(" ");
              return (
                <OpsRow key={`${event.requestId ?? "request"}-${event.createdAt}-${index}`}>
                  <AlertTriangle size={16} className="shrink-0 text-error" aria-hidden="true" />
                  <span className="w-10 shrink-0 font-mono text-caption text-error">{event.status}</span>
                  <Tooltip content={event.route} kind="label" whenTruncated>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-text">
                      {event.route}
                    </span>
                  </Tooltip>
                  <span className="hidden max-w-[16rem] truncate text-caption text-text-3 sm:block">
                    {(event.code && knownErrorCodeMessage(event.code)) || "其他错误"}
                  </span>
                  {identifier && <CopyId value={identifier} label="复制错误标识" />}
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
