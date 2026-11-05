import { parse } from './vendor/tldts-6.1.86.mjs';

/** @param {unknown} host */
function canonicalHost(host) {
  const raw = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!raw || /[\s/:@?#\\%]/u.test(raw) || raw.includes('[') || raw.includes(']')) return null;
  try {
    const name = new URL(`http://${raw}`).hostname.replace(/\.+$/, '');
    return name && name.length <= 253 && !parse(name).isIp
      && name.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) ? name : null;
  } catch { return null; }
}

/** Registrable domain backed by the pinned public suffix list; unknown suffixes fail closed. @param {unknown} host */
export function registrableDomain(host) {
  const name = canonicalHost(host);
  if (!name) return null;
  const result = parse(name, { allowPrivateDomains: true });
  return (result.isIcann || result.isPrivate) ? result.domain : null;
}

/** Normalize only www aliases above the registrable domain. @param {unknown} value */
export function dnsKey(value) {
  let name = canonicalHost(value) ?? String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
  const root = registrableDomain(name);
  if (root) while (name !== root && name.startsWith('www.')) name = name.slice(4);
  return name;
}
