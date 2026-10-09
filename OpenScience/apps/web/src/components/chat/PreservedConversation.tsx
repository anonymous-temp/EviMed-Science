import { useEffect, useState } from "react";
import { getWebConversationHistory, type PreservedConversationHistory } from "@/lib/apiClient";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { sourceCitationProse } from "@evimed/domain";

/** A refused runtime leaves the already saved conversation readable, with no composer or side effects. */
export function PreservedConversation({ projectId, sessionId }: { projectId: string; sessionId: string | null }) {
  const [history, setHistory] = useState<PreservedConversationHistory | null>(null);
  useEffect(() => {
    let alive = true;
    setHistory(null);
    if (sessionId) void getWebConversationHistory(sessionId, projectId)
      .then(value => { if (alive) setHistory(value); }).catch(() => {});
    return () => { alive = false; };
  }, [projectId, sessionId]);
  if (!history?.messages.length) return null;
  return <section aria-label="已保存的对话" className="min-h-0 flex-1 overflow-y-auto px-4 py-6 text-left text-text">
    <div className="mx-auto max-w-read space-y-6">
      <p className="text-caption text-text-3">运行环境暂不可用，以下为已保存的对话{history.partial ? "，部分内容尚未保存" : ""}。</p>
      {history.messages.map(message => <article key={message.seq} aria-label={message.role === "user" ? "你的消息" : "回答"}>
        {message.role === "user" ? <p className="whitespace-pre-wrap text-body font-medium">{message.text}</p>
          : <MarkdownViewer>{sourceCitationProse(message.text)}</MarkdownViewer>}
      </article>)}
    </div>
  </section>;
}
