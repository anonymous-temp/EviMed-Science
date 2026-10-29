import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { buttonClasses } from "@/components/ui/Button";

/**
 * What a whole page says when it cannot be the page (R19, plan §3 S1, D C5): a wrong address, a page that failed, a link that
 * has expired. One anatomy for all of them — an icon, **one sentence**, one action, and, for an address that used to exist,
 * 「回到原处」 (the list it belonged to, not the front door). The 404, the route error and the shared-link page were three
 * shapes, and the old 额度 links ended on a 「返回首页」 that led nowhere near what they were for.
 *
 * It fills the page slot it is given and centres; `role` is the caller's (`alert` for a failure, `status` for a page that is
 * reloading by itself).
 */
/**
 * Component: StateScreen; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Centered EmptyState with optional contextual children, action and back link.
 * Variants: Optional alert/status role and title element.
 * States: Caller chooses empty/error/status copy; no inferred data state.
 * Hit area: Back uses secondary button styling; supplied actions own behavior.
 * Keyboard: Native back link/actions; no automatic focus.
 * Long content: Action row wraps; children and title remain readable.
 * Theme: Delegates EmptyState semantics and shared secondary action roles.
 * Responsive: Full-height flex center; caller must bound content.
 * Verification: Primitives.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function StateScreen({ icon, title, titleAs, action, back, role, className, children }: {
  icon: LucideIcon;
  /** The one sentence. */
  title: string;
  titleAs?: "p" | "h1" | "h2" | "h3";
  /** The one button or link that sets it right (「重新载入」). */
  action?: ReactNode;
  /** Where the address used to lead: a link drawn beside the action as 「回到原处」. */
  back?: { to: string; label?: string };
  role?: "alert" | "status";
  className?: string;
  /** Non-visual companions: the page's `<title>`. */
  children?: ReactNode;
}) {
  const both = action && back;
  const link = back && (
    <Link to={back.to} className={buttonClasses({ variant: "secondary" })}>{back.label ?? "回到原处"}</Link>
  );
  return (
    <div data-state-screen="" role={role} className={cn("flex h-full flex-col items-center justify-center", className)}>
      {children}
      <EmptyState
        icon={icon}
        title={title}
        titleAs={titleAs}
        action={both ? <div className="flex flex-wrap items-center justify-center gap-2">{action}{link}</div> : action ?? link}
      />
    </div>
  );
}
