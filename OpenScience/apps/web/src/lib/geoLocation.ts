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
