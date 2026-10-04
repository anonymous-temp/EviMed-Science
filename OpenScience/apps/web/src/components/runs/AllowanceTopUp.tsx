import { SIMULATED_WALLET_PAGES } from "@evimed/domain";
import type { AllowanceWaiting } from "@/lib/allowanceWait";
import { useResearchBilling } from "@/lib/useResearchBilling";
import { buttonClasses } from "@/components/ui/Button";
import { CommerceLink, commerceHref } from "@/components/settings/SimulatedAllowance";

/**
 * The way from a step that waits for the allowance to the page that tops it up.
 *
 * Where the deployment names its recharge destination (the allowance's
 * `commerce`), that is where it goes; until that is read — or where there is
 * none — a simulated wait goes to the simulated recharge page, and any other to
 * the usage section of 设置, where the allowance is stated. The step names which
 * kind of wallet refused it, so the label is right before any read lands.
 */
export function AllowanceTopUp({ waiting, className }: { waiting: AllowanceWaiting; className?: string }) {
  const { allowance } = useResearchBilling();
  const simulated = waiting === "simulated_allowance";
  const href = commerceHref(allowance?.commerce.rechargeUrl) ?? (simulated ? SIMULATED_WALLET_PAGES.recharge : "/app/account?tab=usage");
  return (
    <CommerceLink href={href} className={className ?? buttonClasses({ variant: "secondary", size: "sm" })}>
      {simulated ? "去模拟充值" : "去充值"}
    </CommerceLink>
  );
}
