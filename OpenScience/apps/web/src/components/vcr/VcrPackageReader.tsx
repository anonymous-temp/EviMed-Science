import { Link } from "react-router";
import { ArrowLeft, CircleCheck, CircleDashed } from "lucide-react";
import { getVcrExport } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";

/**
 * The study package, read on the page rather than downloaded first.
 *
 * A reading column with its table of contents beside it, because a package is
 * a document somebody takes to a meeting and not a dashboard.
 *
 * Its cover states the three things a reader of a modelled result has to know
 * before any number (plan §10.2): what this result may be used for, who
 * countersigned which version, and whether the outcome was sealed before the
 * analysis. **未复核 is printed rather than hidden** — an export is never
 * blocked for want of a review, and a package that stayed quiet about it
 * would be claiming a standing it has not got.
 */
export function VcrPackageReader({ studyId, exportId, onBack }: { studyId: string; exportId: string; onBack: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:export:${exportId}`, () => getVcrExport(studyId, exportId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const deliverable = state.data;
  const sections = deliverable.document?.sections ?? [];
  const file = deliverable.runId && deliverable.path
    ? `/app/runs/${encodeURIComponent(deliverable.runId)}/files/${deliverable.path}`
    : null;

  return (
    <article data-vcr-package="" className="pt-2">
      <Button variant="text" size="sm" onClick={onBack} className="mb-4">
        <ArrowLeft size={16} aria-hidden="true" />
        返回研究
      </Button>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,45rem)_minmax(0,14rem)]">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Tag tone="accent">研究包</Tag>
            {deliverable.draft && <Tag>草稿</Tag>}
          </p>
          <h2 className="mt-3 text-doc-title font-semibold text-text">{deliverable.title}</h2>
          {deliverable.meta && <p className="mt-1.5 text-caption tabular-nums text-text-3">{deliverable.meta}</p>}

          {deliverable.document?.status && deliverable.document.status.length > 0 && (
            <dl className="mt-6 grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-2 lg:grid-cols-4 [&>div]:bg-surface">
              {deliverable.document.status.map((item) => (
                <div key={item.label} className="p-3">
                  <dt className="truncate text-caption text-text-3">{item.label}</dt>
                  <dd className={cn("mt-1 flex items-center gap-1.5 text-ui font-medium",
                    item.state === "ok" ? "text-ok" : item.state === "attention" ? "text-warn-strong" : "text-text")}
                  >
                    {item.state === "ok" ? <CircleCheck size={16} aria-hidden="true" />
                      : item.state === "attention" ? <CircleDashed size={16} aria-hidden="true" /> : null}
                    {item.value}
                  </dd>
                  {item.note && <p className="mt-0.5 text-caption text-text-3">{item.note}</p>}
                </div>
              ))}
            </dl>
          )}

          {sections.length === 0 && (
            <p className="mt-6 text-ui text-text-2">
              研究包的正文在交付文件里。点开任何一个数字，都会回到产生它的那次运行。
            </p>
          )}

          {sections.map((section) => (
            <section key={section.id} id={`vcr-package-${section.id}`} className="mt-8 scroll-mt-6">
              <h3 className="text-section font-semibold text-text">
                {section.number && <span className="mr-2 tabular-nums text-text-3">{section.number}</span>}
                {section.title}
              </h3>
              {section.body && <p className="mt-2 max-w-measure-body text-body leading-relaxed text-text">{section.body}</p>}
              {section.facts && section.facts.length > 0 && (
                <dl className="mt-3 divide-y divide-faint rounded-card border border-border">
                  {section.facts.map((fact) => (
                    <div key={fact.label} className="grid grid-cols-[7rem_1fr] gap-3 px-3 py-2">
                      <dt className="text-caption text-text-3">{fact.label}</dt>
                      <dd className="min-w-0 text-ui text-text">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {section.table && section.table.rows.length > 0 && (
                <table className="mt-3 w-full border-collapse text-ui">
                  <caption className="sr-only">{section.title}</caption>
                  <thead>
                    <tr className="border-b border-border">
                      {section.table.columns.map((column) => (
                        <th key={column} scope="col" className="px-2 pb-1.5 text-left text-caption font-normal text-text-3">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.table.rows.map((row, index) => (
                      <tr key={`${section.id}-${index}`} className="border-b border-faint">
                        {row.map((cell, cellIndex) => (
                          <td key={`${section.id}-${index}-${cellIndex}`} className="px-2 py-2 align-top tabular-nums text-text">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {section.note && <p className="mt-2 text-caption text-text-3">{section.note}</p>}
            </section>
          ))}
        </div>

        <nav aria-label="研究包目录" className="hidden xl:block">
          <div className="sticky top-6">
            <p className="text-caption text-text-3">目录</p>
            <ol className="mt-2 flex flex-col gap-1.5">
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#vcr-package-${section.id}`} className="flex gap-2 text-ui text-text-2 hover:text-text">
                    {section.number && <span className="shrink-0 tabular-nums text-text-3">{section.number}</span>}
                    <span className="min-w-0">{section.title}</span>
                  </a>
                </li>
              ))}
            </ol>
            {file && (
              <Link to={file} className="mt-4 inline-block text-ui text-link hover:underline">打开完整研究包</Link>
            )}
          </div>
        </nav>
      </div>
    </article>
  );
}
