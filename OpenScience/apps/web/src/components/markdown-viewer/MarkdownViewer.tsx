import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { CodeBlock } from "./CodeBlock";
import { ClaimCitation, type ClaimReading } from "./ClaimCitation";
import { claimIdsFromHref, linkClaimMarkers, type ClaimEvidence } from "@/lib/claimCitations";
import { sanitizeAssistantText } from "@/lib/sanitizeAssistantText";

/** Two contexts render markdown: chat-sized prose, and a delivered report
 *  (the "document"). Both read from the design tokens and follow the theme. */
type Variant = "chat" | "document";

const STYLES: Record<Variant, Record<string, string>> = {
  chat: {
    root: "text-body text-text",
    p: "my-2 first:mt-0 last:mb-0",
    a: "text-link underline underline-offset-2",
    code: "rounded bg-surface-2 px-1 py-0.5 font-mono text-ui text-text",
    pre: "my-3 overflow-x-auto rounded-input bg-surface-2 p-3 font-mono text-ui leading-5 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-text",
    ul: "my-2 ml-5 list-disc space-y-1",
    ol: "my-2 ml-5 list-decimal space-y-1",
    h1: "mb-3 mt-5 text-title font-semibold first:mt-0",
    h2: "mb-2 mt-5 text-body font-semibold first:mt-0",
    h3: "mb-2 mt-4 text-body font-semibold first:mt-0",
    h4: "mb-1.5 mt-3 text-ui font-semibold first:mt-0",
    blockquote: "my-2 border-l-[3px] border-strong pl-3 text-muted",
    hr: "my-4 border-border",
    table: "border-collapse text-ui tabular-nums",
    th: "border border-border bg-surface-2 px-3 py-1.5 text-left font-semibold",
    td: "border border-border px-3 py-1.5",
    img: "my-2 max-w-full rounded-input",
  },
  // A delivered report (appendix D §8.4). It used to be warm editorial paper
  // with a terracotta accent and fixed hexes — the old brand, frozen into the
  // one surface researchers read longest, and white in dark mode. It reads
  // from the tokens now: prose 16/1.75 in the shared sans (Chinese body text
  // is never serif — Windows falls to bitmap SimSun), serif only on the two
  // top headings, links in the link colour so a citation never looks like
  // the primary button, and no colour for decoration at all — hierarchy is
  // type and space. The measure (≤ 680 px, ~42 characters) is the caller's.
  // A long URL or identifier breaks rather than widening a phone's page.
  document: {
    root: "break-words text-body text-text [text-wrap:pretty] selection:bg-accent-soft",
    p: "my-4 first:mt-0 last:mb-0",
    a: "text-link underline decoration-1 underline-offset-2 hover:decoration-2",
    code: "rounded bg-surface-2 px-1 py-0.5 font-mono text-ui text-text",
    pre: "my-5 overflow-x-auto rounded-input bg-surface-2 p-4 font-mono text-ui leading-6 ring-1 ring-border [&_code]:bg-transparent [&_code]:p-0",
    ul: "my-4 ml-5 list-disc space-y-2 marker:text-muted",
    ol: "my-4 ml-5 list-decimal space-y-2 marker:text-muted",
    h1: "mb-4 mt-10 font-serif text-display font-semibold text-text [text-wrap:balance] first:mt-0",
    h2: "mb-3 mt-10 font-serif text-title font-semibold text-text [text-wrap:balance] first:mt-0",
    h3: "mb-2 mt-8 text-body font-semibold text-text first:mt-0",
    h4: "mb-2 mt-6 text-ui font-semibold text-muted first:mt-0",
    blockquote: "my-5 border-l-[3px] border-strong pl-4 text-muted [&_p]:my-1.5",
    hr: "my-10 border-border",
    // Below `md` a table scrolls sideways in its own box with its first column
    // frozen (DESIGN.md), so a row is never read without its label, and no
    // column narrower than six characters — squeezed to fit, a hazard ratio
    // and its interval stood one number to a line. Separate borders at zero
    // spacing look the same as collapsed ones, and move with a frozen cell
    // instead of staying behind.
    table: "border-separate border-spacing-0 text-ui tabular-nums max-md:[&_td:first-child]:sticky max-md:[&_td:first-child]:left-0 max-md:[&_td:first-child]:bg-surface max-md:[&_th:first-child]:sticky max-md:[&_th:first-child]:left-0 max-md:[&_td]:min-w-24 max-md:[&_th]:min-w-24",
    th: "border-b border-strong bg-surface-2 px-3 py-2 text-left font-semibold",
    td: "border-b border-faint px-3 py-2 align-top",
    // A figure keeps white paper in both themes: a chart drawn for paper is
    // unreadable on a dark card, and prints wrong from one.
    img: "my-5 max-w-full rounded-input bg-white p-3 ring-1 ring-border",
  },
};

/**
 * Memoized, and its element renderers held stable: react-markdown takes a
 * `components` map, and an inline map is a new component *type* for every tag
 * on every render — React then unmounts and remounts the whole document. A
 * report remounted each time its reader re-rendered (a scroll moving the
 * contents' current mark was enough), which closed any open 依据 and dropped
 * the ids its contents had given the headings.
 */
export const MarkdownViewer = memo(function MarkdownViewer({
  children,
  className,
  variant = "chat",
  claims,
  claimStatuses,
  reading,
}: {
  children: string;
  className?: string;
  variant?: Variant;
  /** A report's evidence matrix, by claim id: each run of claim markers in the
   *  text becomes a citation that opens what the sentence rests on. */
  claims?: Map<string, ClaimEvidence>;
  /** Whether each claim's quotation was found in its preserved source. */
  claimStatuses?: Map<string, string>;
  /** What the report reader around this text knows: per-source verification,
   *  the run (to open preserved sources), safety claims, print. */
  reading?: ClaimReading;
}) {
  const s = STYLES[variant];
  // Claim markers become citations when there is a matrix to open; whatever
  // bookkeeping is left — HTML comments and bracket claim markers outside code —
  // is removed rather than printed. react-markdown renders a raw `<!-- … -->` as
  // visible text, so every report opened without its matrix showed the reader
  // `<!-- claim:CLM-001 -->` after each finding (2026-09-16).
  const source = useMemo(() => sanitizeAssistantText(claims ? linkClaimMarkers(children) : children), [children, claims]);
  const components = useMemo<Components>(() => ({
    p: ({ children }) => <p className={s.p}>{children}</p>,
    a: ({ children, href }) => {
      const ids = claims ? claimIdsFromHref(href) : null;
      if (ids && claims) return <ClaimCitation ids={ids} claims={claims} statuses={claimStatuses} reading={reading} />;
      return (
        <a href={href} className={s.a}>
          {children}
        </a>
      );
    },
    code: ({ children }) => <code className={s.code}>{children}</code>,
    // Block code: the fence is highlighted and gets a copy button. The
    // language and raw text come from the inner <code> element's props
    // (react-markdown passes it as the pre's single child); CodeBlock
    // never renders that child, so inline-code styling stays untouched.
    pre: ({ children }) => {
      const el = children as ReactElement<{
        className?: string;
        children?: ReactNode;
      }> | null;
      const language = /language-([\w-]+)/.exec(el?.props?.className ?? "")?.[1];
      return (
        <CodeBlock
          code={flattenText(el?.props?.children).replace(/\n$/, "")}
          language={language}
          className={s.pre}
        />
      );
    },
    ul: ({ children }) => <ul className={s.ul}>{children}</ul>,
    ol: ({ children }) => <ol className={s.ol}>{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    // Document elements (headings, quotes, tables, rules) — Tailwind's
    // preflight strips the browser defaults, so each needs explicit style.
    h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
    h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
    h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
    h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
    blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
    hr: () => <hr className={s.hr} />,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className={s.table}>{children}</table>
      </div>
    ),
    th: ({ children }) => <th className={s.th}>{children}</th>,
    td: ({ children }) => <td className={s.td}>{children}</td>,
    img: ({ src, alt }) => <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" className={s.img} />,
  }), [s, claims, claimStatuses, reading]);
  return (
    <div className={cn(s.root, className)}>
      <ReactMarkdown
        // remark-breaks: chat prose treats a single newline as a line break
        // (chat convention), not as the collapsible space of print markdown.
        remarkPlugins={REMARK_PLUGINS}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Fence content is almost always one string, but react-markdown may split it
 *  into an array of text nodes — flatten defensively. */
function flattenText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  return "";
}
