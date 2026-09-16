import { useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { PageTitle } from "@/components/layout/PageTitle";
import { cn } from "@/lib/cn";

export interface WorkbenchTab {
  /** The `?tab=` value. Stable: it appears in links people keep. */
  key: string;
  label: string;
  /** Rendered only while selected, so a tab nobody opened costs no request. */
  render: () => ReactNode;
}

/**
 * One destination, several views of it.
 *
 * Written for the 2026-09-15 walk's C1/C3/C6: knowledge was two top-level
 * entries over one set of files, memory was three, and the settings page was
 * the product's settings and the deployment's console at once. Ten navigation
 * rows described the implementation's modules rather than the researcher's
 * work; grouping them costs one strip of tabs and no page rewrites, because
 * each view is still its own component.
 *
 * The selection lives in the query string rather than in component state so a
 * tab is linkable — the sidebar, the command palette and a redirect from a
 * retired route all need to open one — and so the browser's back button
 * returns to the view it left.
 */
export function WorkbenchTabs({
  title,
  description,
  tabs,
  actions,
}: {
  title: string;
  description?: string;
  tabs: readonly WorkbenchTab[];
  actions?: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active = tabs.find((tab) => tab.key === requested) ?? tabs[0];
  const strip = useRef<HTMLDivElement>(null);

  const select = (key: string) => {
    // `replace` so moving between the views of one destination does not fill
    // the history with entries that all look the same.
    const next = new URLSearchParams(params);
    if (key === tabs[0].key) next.delete("tab");
    else next.set("tab", key);
    setParams(next, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <PageTitle page={title} section={active.label} />
      <div className="shrink-0 border-b border-border px-8 pt-8">
        <div className="mx-auto flex max-w-content-full flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-title font-semibold tracking-tight text-text">{title}</h1>
            {description && <p className="mt-2 max-w-2xl text-ui text-muted">{description}</p>}
          </div>
          {actions}
        </div>
        {/* WAI tabs: one stop in the tab order, arrows move between the tabs,
            Home/End jump to the ends. Without it a keyboard had to tab through
            every view's name to reach the content (2026-09-16 walk, U10). */}
        <div ref={strip} className="mx-auto mt-5 flex max-w-content-full gap-1" role="tablist" aria-label={title}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              id={`tab-${tab.key}`}
              role="tab"
              type="button"
              aria-selected={tab.key === active.key}
              aria-controls={`tabpanel-${tab.key}`}
              tabIndex={tab.key === active.key ? 0 : -1}
              onClick={() => select(tab.key)}
              onKeyDown={(event) => {
                const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                if (!keys.includes(event.key)) return;
                event.preventDefault();
                const index = tabs.findIndex((item) => item.key === active.key);
                const next =
                  event.key === "Home" ? 0
                  : event.key === "End" ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
                select(tabs[next].key);
                strip.current?.querySelectorAll("button")[next]?.focus();
              }}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-ui transition-colors",
                tab.key === active.key
                  ? "border-accent font-medium text-text"
                  : "border-transparent text-muted hover:text-text",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div
        className="min-h-0 flex-1"
        role="tabpanel"
        id={`tabpanel-${active.key}`}
        aria-labelledby={`tab-${active.key}`}
        tabIndex={0}
      >
        {active.render()}
      </div>
    </div>
  );
}
