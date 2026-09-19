/**
 * Rewrite only native HTML attributes. Published JavaScript, CSS and the boot graph are unchanged.
 *
 * With `assetPrefix`, the document's own build assets (`./assets/…` in a
 * script or link tag) and its revisioned plugin bundles (`/plugins/??…&rev=…`)
 * are referenced under a stable path rather than under this frame's: a frame
 * id is minted per page, so a path that carries it is a new URL every time a
 * session is opened, and a browser could never reuse the application it
 * downloaded a minute ago. A module's own imports resolve against the
 * module's URL, so its chunks follow it. A plugin URL without a revision
 * stays under the frame: nothing says its bytes are the same next time.
 * @param {Buffer} payload @param {Record<string, any>} headers @param {string} prefix
 * @param {string | null} [assetPrefix] `/__evimed/k/` (shared by every project), or the
 *   older per-project `/__evimed/a/<projectId>/`
 */
export function rebaseRuntimeUiDocument(payload, headers, prefix, assetPrefix = null) {
  if (!String(headers["content-type"] ?? headers["Content-Type"] ?? "").toLowerCase().includes("text/html")) return payload;
  if (!/^\/__evimed\/f\/[A-Za-z0-9_-]{32}\/$/.test(prefix)) throw new Error("Invalid runtime UI frame prefix.");
  const stableAssets = assetPrefix != null
    && (assetPrefix === "/__evimed/k/" || /^\/__evimed\/a\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/$/.test(assetPrefix)) ? assetPrefix : null;
  // Plugin bundles move only to the shared path: the per-project one serves
  // build assets and nothing else. An attribute value is HTML, so the query
  // separator may arrive as `&amp;`.
  const stablePlugins = stableAssets === "/__evimed/k/" ? stableAssets : null;
  const revisioned = (value) => /(?:&|&amp;)rev=[A-Za-z0-9._-]{6,}(?:&|$)/.test(value);
  const document = payload.toString("utf8");
  const rendered = document.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>/gi, (token) => {
    if (token.startsWith("<!--")) return token;
    if (/^<base\b/i.test(token)) return "";
    if (/^<head\b/i.test(token)) return `${token}<base href="${prefix}"><script src="${prefix}__evimed_bootstrap.js"></script>`;
    if (!/^<(?:script|link)\b/i.test(token)) return token;
    // A script's text may itself contain HTML; only its opening tag is an attribute surface.
    const end = token.indexOf(">");
    let opening = token.slice(0, end + 1).replace(/\b(src|href)=(['"])(\/plugins\/[^'"]*)\2/gi,
      (_attribute, name, quote, value) => `${name}=${quote}${stablePlugins && revisioned(value) ? stablePlugins : prefix}${value.slice(1)}${quote}`);
    if (stableAssets) {
      opening = opening.replace(/\b(src|href)=(['"])(?:\.\/|\/)(assets\/[A-Za-z0-9._-]+)\2/gi,
        (_attribute, name, quote, value) => `${name}=${quote}${stableAssets}${value}${quote}`);
    }
    return opening + token.slice(end + 1);
  });
  return Buffer.from(rendered, "utf8");
}

/** Synchronous classic script response: install before the upstream module-loader queue. */
export function runtimeUiBootstrapSource(frame, installer) {
  const encoded = JSON.stringify(frame).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `"use strict";Object.defineProperty(globalThis,"__EVIMED_FRAME__",{value:Object.freeze(${encoded}),writable:false,configurable:false});(${installer.toString()})(globalThis.__EVIMED_FRAME__);`;
}
