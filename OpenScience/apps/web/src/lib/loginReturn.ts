import { safeAppReturnPath } from "@evimed/domain";

/** Where a sign-in lands when it was not sent from a page inside the app. */
export const LOGIN_DEFAULT_RETURN = "/app/chat";

/** The search parameter of `/login` that names the address to return to. */
export const LOGIN_RETURN_PARAM = "next";

/**
 * The login page for a reader who was sent away from `at`: `/login?next=…` with
 * the address they asked for, so signing in puts them back there (design
 * reference §16.3) instead of at the front door. An address that is not a page
 * inside the app — the domain's one `safeAppReturnPath` decides — leaves the
 * plain `/login`.
 */
export function loginAddress(at: { pathname: string; search?: string; hash?: string }): string {
  const target = safeAppReturnPath(`${at.pathname}${at.search ?? ""}${at.hash ?? ""}`);
  return target ? `/login?${LOGIN_RETURN_PARAM}=${encodeURIComponent(target)}` : "/login";
}

/** The address a sign-in returns to, from the login page's own search: the validated `next`, else the front door. */
export function loginReturnTarget(search: URLSearchParams | string): string {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return safeAppReturnPath(params.get(LOGIN_RETURN_PARAM)) ?? LOGIN_DEFAULT_RETURN;
}
