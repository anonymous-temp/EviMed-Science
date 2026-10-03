import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { useResearchBilling } from "@/lib/useResearchBilling";
import { MonthlyUsage } from "./MonthlyUsage";
import { ResearchAllowance } from "./ResearchAllowance";

/**
 * 设置's usage section (`?tab=usage`), which is the deployment's own.
 *
 * Research billing is off by default, and a page for a subsystem that is
 * switched off must not present it — no allowance panel, no recharge rows for
 * things that do not exist, no word of 科研额度. So the section follows the
 * deployment's answer:
 *
 *  - billing off: 「用量」, what this month has cost and its per-run detail
 *    (`MonthlyUsage`, the page every account had before billing existed);
 *  - billing on: 「科研额度」, the allowance and its statements
 *    (`ResearchAllowance`).
 *
 * The answer is the one `/api/account/allowance` read the account page's tab
 * label and the chat frame's button share (`useResearchBilling`); `fresh`
 * because the allowance's numbers move, so opening the section reads them again
 * when billing is on. Until the answer comes there is a skeleton, and when it
 * cannot be read, the error with its retry — neither names billing, because
 * neither knows yet whether there is any.
 */
export function UsageSection() {
  const { allowance, loading, error, reload } = useResearchBilling({ fresh: true });
  if (error) return <LoadError message={error} onRetry={reload} />;
  if (!allowance || loading) return <RunsSkeleton filter={false} />;
  return allowance.enabled ? <ResearchAllowance allowance={allowance} /> : <MonthlyUsage />;
}
