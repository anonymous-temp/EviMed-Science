import { Menu } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import type { KnowledgeStatus } from "@/lib/sourceClient";
import { statusLine } from "./knowledgeView";

/**
 * Where the project's pages stand, as one dot beside the knowledge base's title — and only while something needs attention: the page
 * limit is reached, the knowledge engine is out, the last round did not finish (R19, plan §5.5, audit D C3). The compile running, a
 * project short of documents and 「已整理」 are not faults and were a grey line under the header on every tab; the first two have a
 * place in the 知识页 tab (the strip while a round runs, the empty state's recipe) and the last has none, because it is not news.
 *
 * What the dot says is the sentence of `statusLine`; where a round can be asked for it is the one thing the dot offers (「重新整理」,
 * in a small menu); where it cannot (the limit), the dot is a mark with a tooltip and nothing to press. It says nothing at all where
 * the deployment does not compile pages, and nothing it says blocks an upload or a conversation.
 */
export function KnowledgeStatusDot({ status, asking, onCompile }: { status: KnowledgeStatus | null; asking: boolean; onCompile: () => void }) {
  const line = statusLine(status);
  if (!line || !line.attention) return null;
  const mark = <span aria-hidden="true" data-forced-colors="preserve" className="block h-2 w-2 rounded-full bg-warn" />;
  const look = "grid h-6 w-6 place-items-center rounded-full outline-none hover:bg-surface-2 focus-visible:outline-focus";
  if (!line.canCompile) {
    return (
      <Tooltip content={line.text}>
        <span role="img" aria-label={`知识页：${line.text}`} data-knowledge-status={status?.state} className={look}>{mark}</span>
      </Tooltip>
    );
  }
  return (
    <Menu label="知识页的整理情况" align="start" items={[{ heading: line.text }, { label: asking ? "正在重新整理" : "重新整理", disabled: asking, onSelect: onCompile }]}>
      <button type="button" aria-label={`知识页：${line.text}`} data-knowledge-status={status?.state} className={look}>{mark}</button>
    </Menu>
  );
}
