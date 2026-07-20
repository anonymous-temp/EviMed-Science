import { memo, useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import "./hljs-theme.css";

/** A fenced code block with syntax highlighting and a copy affordance.
 *
 *  Highlighting rules: a fence with a language highlight.js knows gets
 *  colored; anything else renders plain. Auto-detection is deliberately not
 *  used — during streaming the partial code re-detects on every chunk and the
 *  colors visibly flicker, which is worse than no colors.
 *
 *  Memoized at two levels (React.memo + useMemo on code/language) because a
 *  streaming message re-renders all of its blocks on every chunk, and only
 *  the last code block is actually growing. */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  paper = false,
  className,
}: {
  code: string;
  language?: string;
  /** Document variant: fixed paper hues (see hljs-theme.css). */
  paper?: boolean;
  className?: string;
}) {
  const html = useMemo(() => {
    if (!language || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(code, { language }).value;
    } catch {
      return null; // never let a highlighter edge case break the message
    }
  }, [code, language]);

  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return; // clipboard unavailable (permissions, non-secure context) — stay silent
    }
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <pre className={cn(className, paper && "hljs-paper", "group relative")}>
      <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {language && (
          <span className="px-1 font-mono text-caption uppercase tracking-wide text-muted">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "已复制" : "复制代码"}
          className="flex items-center gap-1 rounded-input border border-border bg-surface px-2 py-1 text-caption text-muted shadow-card hover:text-text"
        >
          {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {html !== null ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{code}</code>
      )}
    </pre>
  );
});
