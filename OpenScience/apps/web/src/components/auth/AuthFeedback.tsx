import { CircleAlert, CircleCheck } from "lucide-react";
import { cn } from "@/lib/cn";

/** Form results stay readable beside the action that can retry them. */
export function AuthFeedback({ tone = "error", children, id, className }: {
  tone?: "error" | "success";
  children: string;
  id?: string;
  className?: string;
}) {
  const Icon = tone === "error" ? CircleAlert : CircleCheck;
  return <div id={id} role={tone === "error" ? "alert" : "status"} aria-atomic="true" data-auth-feedback={tone}
    className={cn("auth-feedback text-ui", `auth-feedback--${tone}`, className)}>
    <Icon size={16} aria-hidden="true" />
    <span>{children}</span>
  </div>;
}

/** The field primitive owns the error id and announcement; the icon adds a non-colour cue. */
export function AuthFieldError({ children }: { children: string }) {
  return <span className="auth-field-error">
    <CircleAlert size={16} aria-hidden="true" />
    <span>{children}</span>
  </span>;
}
