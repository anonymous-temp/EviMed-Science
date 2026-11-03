/** Addressed GEO conversations share the project's persistent workflow shell. */
export function geoChatPath(geoId: string, sessionId?: string | null): string {
  return `/app/geo/${encodeURIComponent(geoId)}/chat${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`;
}

export function geoIdFromChatPath(pathname: string): string | null {
  const match = /^\/app\/geo\/([^/]+)\/chat(?:\/[A-Za-z0-9_-]{1,160})?\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
  } catch { return null; }
}

/** The actual addressed native session takes precedence over a project's default conversation. */
export function geoSessionIdFromChatPath(pathname:string):string|null {
  const match = /^\/app\/geo\/[^/]+\/chat\/([A-Za-z0-9_-]{1,160})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

/** An explicit pane binds one GEO project and an exact session. */
export function geoConversationPane(pathname: string, search: string): { geoId: string; sessionId: string } | null {
  const match = /^\/app\/geo\/([A-Za-z0-9_-]{1,160})(?:\/.*)?$/.exec(pathname);
  if (!match || geoIdFromChatPath(pathname)) return null;
  const params = new URLSearchParams(search);
  const sessions = params.getAll("session");
  if (params.getAll("conversation").length !== 1 || params.get("conversation") !== "open" || sessions.length !== 1 || !/^[A-Za-z0-9_-]{1,160}$/.test(sessions[0])) return null;
  return { geoId: match[1], sessionId: sessions[0] };
}

export function geoPanePath(pathname: string, search: string, hash: string, sessionId: string): string {
  const params = new URLSearchParams(search);
  params.set("conversation", "open");
  params.set("session", sessionId);
  return `${pathname}?${params.toString()}${hash}`;
}
