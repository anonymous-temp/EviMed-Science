/**
 * A socket tool result as the pinned kernel renders it into a session's
 * history: `ok` and the data as two-space-indented JSON, or `failed: <code>`
 * and one `- (<severity>) <code> <message>` line per issue.
 *
 * Transcribed from a production transcript (release evimed-cdd09cb35119-1,
 * 2026-09-16), not from our own result type. The fixtures this replaces wrote
 * `JSON.stringify({ ok, data })`, which no live run has ever produced — and
 * every reader written against them passed its tests and found nothing on a
 * real run. `socketToolResult.test.mjs` holds the verbatim samples this
 * reproduces.
 *
 * @param {{ ok: true, data?: any } | { ok: false, code: string, issues?: { severity?: string, code: string, message: string }[] }} result
 */
export function kernelToolText(result) {
  if (result.ok) return `ok\n${JSON.stringify(result.data ?? null, null, 2)}`;
  return [`failed: ${result.code}`, ...(result.issues ?? []).map((issue) => `- (${issue.severity ?? "required"}) ${issue.code} ${issue.message}`)].join("\n");
}
