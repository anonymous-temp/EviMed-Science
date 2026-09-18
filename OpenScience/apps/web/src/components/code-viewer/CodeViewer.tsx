import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
// The token-mapped palette, not a stock highlight.js theme. `styles/github.css`
// used to be imported here; it sets its own `.hljs` background, so every code
// panel in this viewer stayed white paper in dark mode while the surface around
// it went dark (2026-09-16 walk, V4). The shared theme inherits the surface and
// draws its colours from the design tokens, so it follows `data-theme`.
import "@/components/markdown-viewer/hljs-theme.css";

interface Props {
  code: string;
  language?: string;
  startLine?: number;
}

/** Read-only code with a line-number gutter. Scrolls horizontally; no wrapping. */
export function CodeViewer({ code, language, startLine = 1 }: Props) {
  const html = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  const lineCount = code.replace(/\n$/, "").split("\n").length;

  return (
    <div className="flex overflow-x-auto rounded-input border border-border bg-surface font-mono text-ui leading-[1.55]">
      <div
        aria-hidden
        className="select-none border-r border-border bg-surface-2 px-3 py-3 text-right text-muted"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{startLine + i}</div>
        ))}
      </div>
      <pre className="flex-1 overflow-visible px-4 py-3">
        <code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
