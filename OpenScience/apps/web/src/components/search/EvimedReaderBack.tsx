import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate, useNavigationType } from "react-router";
import { safeAppReturnPath } from "@evimed/domain";
import { buttonClasses } from "@/components/ui/Button";

/** Reader entry links may carry `state.returnTo` to preserve their source across reloads. */
export function EvimedReaderBack({ fallback }: { fallback: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const arrival = useNavigationType();
  const state: unknown = location.state;
  const origin = safeAppReturnPath(typeof state === "object" && state !== null ? (state as { returnTo?: unknown }).returnTo : null);
  const current = `${location.pathname}${location.search}${location.hash}`;
  const to = origin && origin !== current ? origin : fallback;
  // A pushed route has an in-app predecessor. Direct arrivals use a known source or the category fallback.
  const historyBack = arrival === "PUSH";
  return <Link to={to} replace={!historyBack}
    onClick={historyBack ? event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(-1);
    } : undefined}
    className={buttonClasses({ variant: "secondary", className: "group" })}>
    <ArrowLeft size={16} aria-hidden="true" className="transition-transform duration-fast group-hover:-translate-x-0.5 motion-reduce:transform-none" />
    返回
  </Link>;
}
