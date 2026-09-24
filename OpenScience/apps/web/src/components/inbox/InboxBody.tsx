import { Disclosure } from "@/components/ui/Disclosure";
import { cn } from "@/lib/cn";
import { splitNoticeBody } from "@/lib/qualityNotices";

/**
 * A notice's body as a row reads it: one line, or every line once the row is
 * open.
 *
 * Bodies are composed by the server (contract C1). Ones written before
 * 2026-09-18 carried the gate's sentences verbatim — the inbox was where
 * 「claims[52].claim numeric fact 6 is not present…」 reached a pharmacist
 * first (review B §1f). Those lines are held back: not counted, not
 * mentioned, and shown as written only to an operator, who can act on them.
 */
export function InboxBody({ body, open = false, operator = false, className }: {
  body: string;
  /** The whole body, line by line, instead of its first line. */
  open?: boolean;
  operator?: boolean;
  className?: string;
}) {
  const { lines, technical } = splitNoticeBody(body);
  const showTechnical = operator && technical.length > 0;
  if (lines.length === 0 && !showTechnical) return null;
  return (
    <div className={cn("text-ui text-text-2", className)}>
      {open
        ? lines.map((line, index) => <p key={index} className="max-w-measure">{line}</p>)
        : lines.length > 0 && <p className="truncate">{lines.join(" ")}</p>}
      {showTechnical && (
        // Above the row's stretched link, so the disclosure opens rather than
        // following the row.
        <div className="relative z-10 mt-1">
          <Disclosure summary={<>另有 {technical.length} 条技术原文（仅运维账号可见）</>} summaryClassName="text-caption">
            <ul className="space-y-1 font-mono text-caption text-text-3">
              {technical.map((line, index) => <li key={index} className="break-words">{line}</li>)}
            </ul>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
