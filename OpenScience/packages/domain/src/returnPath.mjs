/** The longest return path an address may carry; nothing real is near it. */
const RETURN_PATH_MAX = 2048

/**
 * The address inside the signed-in app that a sign-in may send the person back
 * to, or null when what was asked for is not one (design reference §16.3).
 *
 * A login that returns to a requested address is an open redirect the moment
 * it accepts anything but the app's own pages, so this is deliberately narrow
 * and it is one function for the page that asks and the server that redirects
 * (the browser's address bar and the OIDC callback's `Location` must agree on
 * what counts):
 *
 *  - it starts with `/app` and then a `/`, `?`, `#` or the end — so no scheme,
 *    no host, no `//` or `/\` at the front, which a browser reads as another
 *    origin, and not `/application`;
 *  - printable ASCII only and no backslash: a tab or newline inside `/<TAB>/host`
 *    is removed by the URL parser and leaves `//host`;
 *  - the path part has no `//`, no `.` or `..` segment, and no percent-encoded
 *    slash, backslash, dot or control character, which would be the same
 *    walk out of `/app/` written another way, and no `%` that is not followed
 *    by two hex digits. The query and the fragment are the app's own data and
 *    may carry any encoded character (`?run=a%2Fb`).
 *
 * The value is returned as it came, unmodified; a caller that gets null uses
 * its own default.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeAppReturnPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > RETURN_PATH_MAX) return null
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes('\\')) return null
  const match = /^(\/app(?:\/[^?#]*)?)(\?[^#]*)?(#.*)?$/.exec(value)
  if (!match) return null
  const path = match[1]
  if (path.includes('//')) return null
  if (/%(?![0-9a-fA-F]{2})/.test(path)) return null
  if (/%(?:2[fF]|5[cC]|2[eE]|[01][0-9a-fA-F]|7[fF])/.test(path)) return null
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null
  return value
}
