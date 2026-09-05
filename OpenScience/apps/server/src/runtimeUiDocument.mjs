/** Rewrite only native HTML attributes. Published JavaScript, CSS and the boot graph are unchanged. */
export function rebaseRuntimeUiDocument(payload, headers, prefix) {
  if (!String(headers["content-type"] ?? headers["Content-Type"] ?? "").toLowerCase().includes("text/html")) return payload;
  if (!/^\/__evimed\/f\/[A-Za-z0-9_-]{32}\/$/.test(prefix)) throw new Error("Invalid runtime UI frame prefix.");
  const document = payload.toString("utf8");
  const rendered = document.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>/gi, (token) => {
    if (token.startsWith("<!--")) return token;
    if (/^<base\b/i.test(token)) return "";
    if (/^<head\b/i.test(token)) return `${token}<base href="${prefix}"><script src="${prefix}__evimed_bootstrap.js"></script>`;
    if (!/^<(?:script|link)\b/i.test(token)) return token;
    // A script's text may itself contain HTML; only its opening tag is an attribute surface.
    const end = token.indexOf(">");
    const opening = token.slice(0, end + 1).replace(/\b(src|href)=(['"])(\/plugins\/[^'"]*)\2/gi, (_attribute, name, quote, value) => `${name}=${quote}${prefix}${value.slice(1)}${quote}`);
    return opening + token.slice(end + 1);
  });
  return Buffer.from(rendered, "utf8");
}

/** Synchronous classic script response: install before the upstream module-loader queue. */
export function runtimeUiBootstrapSource(frame, installer) {
  const encoded = JSON.stringify(frame).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `"use strict";Object.defineProperty(globalThis,"__EVIMED_FRAME__",{value:Object.freeze(${encoded}),writable:false,configurable:false});(${installer.toString()})(globalThis.__EVIMED_FRAME__);`;
}
