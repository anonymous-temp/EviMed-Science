import type { ReactNode } from "react";
import { Link } from "react-router";
import { SIMULATED_WALLET_LABEL, formatCredits } from "@evimed/domain";
import type { WebAmount, WebResearchAllowance } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { allowanceSimulated } from "@/lib/useResearchBilling";
import { buttonClasses } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";

/**
 * What every surface of a simulated allowance is drawn with (2026-10-04).
 *
 * A deployment may bill research from a simulated wallet, so its owner can look
 * at the whole allowance experience before a real wallet exists. Nothing such a
 * wallet holds is money, and no reader may take it for money: every amount
 * drawn from it carries `SimulatedMark`, and a surface whose every amount is
 * simulated opens with `SimulatedDataLine`. A deployment whose allowance is not
 * simulated draws neither (`allowanceSimulated`).
 */

/**
 * The mark beside a simulated amount: the domain's own word for it, as a
 * neutral tag. Neutral because a tag's colour is reserved (`Tag`) — this names
 * what the number beside it is, it is not a state of anything.
 */
export function SimulatedMark({ className }: { className?: string }) {
  return <Tag className={className}>{SIMULATED_WALLET_LABEL}</Tag>;
}

/** The page-level statement of a surface whose every amount is simulated: one plain line, as 用量 says a ceiling. */
export function SimulatedDataLine({ className }: { className?: string }) {
  return <p className={cn("text-ui text-warn-strong", className)}>模拟数据，不涉及真实资金</p>;
}

/**
 * One amount of an allowance, for the value side of a row. Marked when the
 * wallet behind it is simulated; an amount that is not there is said so —
 * never drawn as zero — and has nothing to mark.
 *
 * Drawn by the domain's one display rule (`formatCredits`: two decimals, a small
 * amount with its first two significant digits and never as 0.00). What is held is
 * drawn rounded down, so a page never shows more than the account has; pass
 * `rounding="nearest"` for a charge.
 */
export function AllowanceAmount({ value, simulated, className, rounding = "down", sign = "" }: {
  value: WebAmount | null | undefined;
  simulated: boolean;
  className?: string;
  rounding?: "down" | "nearest";
  /** "+" for credits going in, "−" for credits going out. */
  sign?: "" | "+" | "−";
}) {
  const text = allowanceText(value, rounding);
  return <>
    {simulated && text && <SimulatedMark />}
    <span className={cn("tabular-nums", className)}>{text ? `${sign}${text}` : "暂不可用"}</span>
  </>;
}

/** An amount as the allowance pages draw it (¥12.30), or '' for a value that is not one. */
export function allowanceText(value: WebAmount | null | undefined, rounding: "down" | "nearest" = "down"): string {
  const text = value === null || value === undefined || (typeof value === "number" && value < 0) ? "" : formatCredits(value, { rounding });
  return text ? `¥${text}` : "";
}

/**
 * A commerce destination the control plane named, or null: a path of this
 * deployment (the simulated wallet's own pages), or a configured HTTPS page.
 * Never a placeholder checkout, and never another scheme.
 */
export function commerceHref(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? value : null;
  } catch { return null; }
}

/**
 * A link to a commerce destination (`commerceHref`). A page of this app is
 * followed in place by the router, so the shell and the conversation frame stay
 * where they are; a configured HTTPS page is a document of its own.
 */
export function CommerceLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return href.startsWith("/app/")
    ? <Link to={href} className={className}>{children}</Link>
    : <a href={href} rel="noreferrer" className={className}>{children}</a>;
}

/**
 * Where a simulated allowance stands against the threshold the control plane
 * names for it: `low` at or below the threshold, `exhausted` at nothing left,
 * null above it.
 *
 * Null as well when either number is unknown: an allowance that could not be
 * read is not an empty one, so nobody is told theirs ran out on a failed read.
 */
export function simulatedAllowanceLevel(allowance: WebResearchAllowance | null): "low" | "exhausted" | null {
  if (!allowance || !allowanceSimulated(allowance)) return null;
  const { available, lowThreshold } = allowance;
  if (available === null || available === undefined) return null;
  // Where low begins is the control plane's to say — in exact units (`low`), or by the threshold an older one names. With
  // neither there is nothing to measure against, and nobody is told their allowance is running out on a guess.
  const low = typeof allowance.low === "boolean" ? allowance.low
    : typeof lowThreshold === "number" && typeof available === "number" ? available <= lowThreshold : null;
  if (low === null) return null;
  // Nothing left is a fact of the amount itself: 0.00 is only ever drawn for a true zero (`formatCredits`).
  const none = formatCredits(available) === "0.00";
  if (!low && !none) return null;
  return none ? "exhausted" : "low";
}

/**
 * The prompt a reader sees when their simulated allowance is running low or is
 * used up, with the way to the simulated recharge page — at the top of the
 * allowance page, and of 科研工具, where the next task would be started. Draws
 * nothing above the threshold, and nothing at all for an allowance that is not
 * simulated.
 */
export function SimulatedAllowanceNotice({ allowance, className }: { allowance: WebResearchAllowance | null; className?: string }) {
  const level = simulatedAllowanceLevel(allowance);
  if (!allowance || !level) return null;
  const recharge = commerceHref(allowance.commerce.rechargeUrl);
  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-warn bg-warn-soft px-3 py-2 text-ui text-warn-strong", className)}
    >
      <SimulatedMark />
      <span className="min-w-0 flex-1 break-words">
        {level === "exhausted" ? "科研额度已用完，模拟充值后可以继续研究。" : `科研额度即将用完，还剩 ${allowanceText(allowance.available)}。`}
      </span>
      {recharge && <CommerceLink href={recharge} className={buttonClasses({ variant: "secondary", size: "sm" })}>去模拟充值</CommerceLink>}
    </div>
  );
}
