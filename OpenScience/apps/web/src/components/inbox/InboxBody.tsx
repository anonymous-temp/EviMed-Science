import { Disclosure } from "@/components/ui/Disclosure";
import { cn } from "@/lib/cn";
import { splitNoticeBody } from "@/lib/qualityNotices";
import { useOperator } from "@/lib/useOperator";

/**
 * A notice's body as a reader sees it.
 *
 * Bodies are composed by the server from counts and groups (contract C1). Ones
 * written before that carried the gate's first two sentences verbatim — the
 * inbox was where 「claims[52].claim numeric fact 6 is not present…」 reached a
 * pharmacist first (review B §1f). Those lines are held back here: counted in
 * one quiet sentence, and shown as written only to an operator.
 */
export function InboxBody({ body, className }: { body: string; className?: string }) {
  const operator = useOperator();
  const { lines, technical } = splitNoticeBody(body);
  if (lines.length === 0 && technical.length === 0) return null;
  return (
    <div className={cn("space-y-0.5 text-ui text-muted", className)}>
      {lines.map((line, index) => <p key={index}>{line}</p>)}
      {technical.length > 0 && !operator && (
        <p className="text-caption">另有 {technical.length} 条技术提示，打开运行记录可看核验结果。</p>
      )}
      {technical.length > 0 && operator && (
        <Disclosure summary={<>另有 {technical.length} 条技术原文（仅运维账号可见）</>} summaryClassName="text-caption">
          <ul className="space-y-1 font-mono text-caption">
            {technical.map((line, index) => <li key={index} className="break-words">{line}</li>)}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
