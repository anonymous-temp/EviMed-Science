import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";
import { validateEvimedAccountSettings } from "./evimedAccountService.mjs";
import { openEvimedSearchReference, sealEvimedSearchReference } from "./evimedSessionCredentials.mjs";

export const EVIMED_SEARCH_ACTIONS = ["collection", "citations", "export", "fulltext-status", "fulltext-request", "fulltext-offer", "fulltext-confirm"];
export const EVIMED_ACTION_PATHS = {
  literatureCollection: "FineScreenController/collectionLiterature", guidelinesCollection: "archive-api/guideStatus/put",
  drugsCollection: "archive-api/instructionStatus/put", citations: "FineScreenController/literatureCited", export: "FineScreenController/batchExport",
  status: "news-api/KnowledgeController/fullTextStatus", request: "news-api/KnowledgeController/getFullText", confirm: "news-api/KnowledgeController/addData",
  quota: "system/v2/membership/download/remaining", profile: "system/v2/profile/info",
};
const invalid = () => new HttpError(400, "evimed_search_invalid_input", "The search action is invalid.");
const malformed = () => new HttpError(502, "evimed_search_response_invalid", "The search action returned an invalid response.");
const unavailable = () => new HttpError(409, "evimed_search_download_unavailable", "The full text is not available for download.");
/** @type {WeakMap<object,Map<string,Promise<any>>>} */
const CONFIRMATIONS = new WeakMap();
/** A confirmed receipt suppresses concurrent repeats until the signed offer expires. @type {WeakMap<object,Map<string,number>>} */
const CONFIRMED = new WeakMap();
/** A transport failure after sending the consuming request is not permission to consume again. @type {WeakMap<object,Map<string,number>>} */
const UNCERTAIN = new WeakMap();
/** @param {unknown} value @returns {value is Record<string, any>} */
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
/** @param {unknown} value @param {number} [limit] */
const clean = (value, limit = 1000) => typeof value === "string" || typeof value === "number" ? String(value).slice(0, limit * 4).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ").trim().slice(0, limit) : "";
/** @param {unknown} value */
export function evimedCollectionStatus(value) {
  if (!object(value)) return null;
  const flag = value.collectionMark ?? value.starMark;
  return [true, 1, "1"].includes(flag) ? true : [false, 0, "0"].includes(flag) ? false : null;
}
/** @param {any} value @param {string[]} allowed */
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid(); }
/** @param {any} service @param {any} session @param {string} category @param {unknown} ref */
function reference(service, session, category, ref) {
  if (typeof ref !== "string" || !ref || ref.length > 10_000) throw invalid();
  const value = openEvimedSearchReference(service.config, session, category, ref);
  if (!value) throw new HttpError(403, "evimed_search_reference_invalid", "The search action reference is invalid or expired.");
  return value;
}
/** Only selected plain-text fields are returned; a provider cannot echo our account header. @param {any} value @param {string} credential @returns {any} */
function redact(value, credential) {
  if (typeof value === "string") return value.split(credential).join("[redacted]");
  if (Array.isArray(value)) return value.map(item => redact(item, credential));
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, credential)])) : value;
}
/** @param {any} req @param {any} res */
function connected(req, res) { if (req.aborted || res.destroyed) throw new HttpError(409, "evimed_search_action_cancelled", "The action was cancelled before confirmation."); }
/** @param {string} category @param {Record<string,any>} parameters */
function fullTextParameters(category, parameters) {
  const dataId = category === "drugs" ? parameters.pdfName : parameters.id || parameters.name;
  if (!dataId) throw invalid();
  return { dataId, type: { literature: 1, guidelines: 2, drugs: 3 }[category], ...(category === "drugs" ? { source: parameters.source } : {}) };
}
/** The browser downloads public files without application credentials; no server URL proxy exists. @param {unknown} value @param {string} credential */
function publicFileUrl(value, credential) {
  if (typeof value !== "string" || !value || value.length > 8000 || value.includes(credential)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    if (!hostname.includes(".") || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.includes(":") || /^[\d.]+$/.test(hostname)) return null;
    if ([...url.searchParams.keys()].some(key => /^(?:token|api.?key|authorization|credential)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}
/** @param {unknown} title */
function pdfFilename(title) {
  // eslint-disable-next-line no-control-regex -- download names cannot contain controls or paths
  const name = clean(title, 160).replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, "_").replace(/[.\s]+$/g, "").trim() || "original";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}
/** @param {string} value */
const digest = value => createHash("sha256").update(value).digest("hex");
/** @param {any} session @param {string} category @param {any} parameters */
const confirmationKey = (session, category, parameters) => JSON.stringify([session.binding, category, fullTextParameters(category, parameters).dataId]);
/** @param {any} service @param {string} key @param {number} status */
function confirmKnownOutcome(service, key, status) {
  const uncertain = UNCERTAIN.get(service);
  if (status === 5) { uncertain?.delete(key); return; }
  if ((uncertain?.get(key) ?? 0) > Date.now()) throw new HttpError(409, "evimed_search_download_confirmation_pending", "Refresh the full text status before confirming another download.");
}

/** @param {any} service @param {any} req @param {any} session @param {string} path @param {any} parameters @param {boolean|"PUT"} [method] */
const call = (service, req, session, path, parameters, method = true) => service.call(req, session, path, parameters, method, false, Date.now() + 30_000, true);

/** @param {any} service @param {any} req @param {any} session @param {string} category @param {any} parameters */
async function fullTextStatus(service, req, session, category, parameters) {
  const data = await call(service, req, session, EVIMED_ACTION_PATHS.status, fullTextParameters(category, parameters));
  if (!object(data) || !/^[0-5]$/.test(String(data.status))) throw malformed();
  const status = Number(data.status); const url = publicFileUrl(data.url, session.credential);
  return { status, url, canRequest: status === 0, canDownload: Boolean(url) || status === 2 || status === 5 };
}

/** @param {any} service @param {any} req @param {any} session @param {string} category @param {any} parameters */
async function fullTextOffer(service, req, session, category, parameters) {
  const profile = await call(service, req, session, EVIMED_ACTION_PATHS.profile, {});
  if (!object(profile)) throw malformed();
  if (profile.profileReminderShow && profile.profileReminderShow !== "false" && profile.profileReminderShow !== "0") throw new HttpError(409, "evimed_search_profile_required", "Complete the EviMed account profile before downloading.");
  const status = await fullTextStatus(service, req, session, category, parameters);
  confirmKnownOutcome(service, confirmationKey(session, category, parameters), status.status);
  const quota = await call(service, req, session, EVIMED_ACTION_PATHS.quota, {});
  if (!object(quota)) throw malformed();
  const unlimited = [true, 1, "1", "true"].includes(quota.unlimited);
  const daily = Number(quota.daily ?? (unlimited ? 0 : NaN));
  const permanent = Number(quota.permanent ?? (unlimited ? 0 : NaN));
  if ((!unlimited && [quota.daily, quota.permanent].some(value => !/^\d+$/.test(String(value)))) || ![daily, permanent].every(value => Number.isSafeInteger(value) && value >= 0)) throw malformed();
  const kind = status.status === 5 ? "owned" : unlimited ? "unlimited" : daily > 0 || permanent > 0 ? "free" : "beans";
  const amount = kind === "beans" ? category === "guidelines" ? 4 : 3 : 0;
  return { ...status, filename: pdfFilename(String(parameters.title || parameters.name || "").split(session.credential).join("redacted")), daily, permanent, unlimited, kind, amount };
}

/** Binary exports use one fixed path, a bounded body, verified file signatures and an owned filename. @param {any} service @param {any} req @param {any} res @param {any} session @param {string[]} ids @param {number} format */
async function exportRecords(service, req, res, session, ids, format) {
  const settings = validateEvimedAccountSettings(service.config);
  const signal = AbortSignal.timeout(100_000);
  let response;
  try { response = await service.fetch(new URL(EVIMED_ACTION_PATHS.export, settings.baseUrl), { method: "POST", headers: { accept: "application/octet-stream", "content-type": "application/json", client: "pc", token: session.credential }, body: JSON.stringify({ ids, type: format }), redirect: "error", signal }); }
  catch { throw new HttpError(signal.aborted ? 504 : 503, signal.aborted ? "evimed_search_timeout" : "evimed_search_upstream_unavailable", "The citation export is unavailable."); }
  if ([401, 403].includes(response.status)) { await service.store.clearEvimedSearchCredential(req); throw new HttpError(403, "evimed_search_credential_expired", "Sign in again to export."); }
  if (response.status === 402) throw new HttpError(402, "evimed_search_balance_insufficient", "The export allowance is insufficient.");
  if (!response.ok) throw new HttpError(503, "evimed_search_upstream_unavailable", "The citation export is unavailable.");
  const limit = 10 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw malformed(); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body ?? []) { length += chunk.length; if (length > limit) throw malformed(); chunks.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length || bytes.includes(Buffer.from(session.credential))) throw malformed();
  const prefix = bytes.subarray(0, 1024).toString("utf8").trim();
  const contentType = String(response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  if (contentType === "application/json") {
    let answer; try { answer = JSON.parse(bytes.toString("utf8")); } catch { throw malformed(); }
    if ([401, 403].includes(Number(answer?.code))) { await service.store.clearEvimedSearchCredential(req); throw new HttpError(403, "evimed_search_credential_expired", "Sign in again to export."); }
    if (Number(answer?.code) === 402) throw new HttpError(402, "evimed_search_balance_insufficient", "The export allowance is insufficient.");
    throw malformed();
  }
  const allowed = format === 1 ? ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream", "application/zip"] : format === 2 ? ["application/pdf", "application/octet-stream"] : ["application/xml", "text/xml", "application/octet-stream"];
  if (!allowed.includes(contentType)) throw malformed();
  if (format === 1 && !(bytes[0] === 0x50 && bytes[1] === 0x4b) || format === 2 && !prefix.startsWith("%PDF-") || format === 3 && (!prefix.startsWith("<") || /<!doctype|<html\b|<script\b/i.test(prefix))) throw malformed();
  await service.confirmSession(req, res, session);
  return { filename: `literature-export.${format === 1 ? "xlsx" : format === 2 ? "pdf" : "xml"}`, contentType: allowed[0], base64: bytes.toString("base64") };
}

/** Serialize one account document's confirmations, including two browser tabs. @param {any} service @param {any} req @param {any} res @param {any} session @param {string} category @param {any} approved @param {any} parameters */
async function confirmDownload(service, req, res, session, category, approved, parameters) {
  const key = confirmationKey(session, category, parameters);
  const locks = CONFIRMATIONS.get(service) ?? new Map(); CONFIRMATIONS.set(service, locks);
  const receipts = CONFIRMED.get(service) ?? new Map(); CONFIRMED.set(service, receipts);
  const receiptKey = `${key}:${approved.fileDigest}`;
  const previous = locks.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    if (Number(approved.until) < Date.now()) throw new HttpError(409, "evimed_search_download_cost_changed", "The download offer expired. Confirm the current allowance.");
    const current = await fullTextOffer(service, req, session, category, parameters);
    if (!current.url) throw unavailable();
    if (current.amount > Number(approved.amount) && !(receipts.get(receiptKey) > Date.now()) || digest(current.url) !== approved.fileDigest) throw new HttpError(409, "evimed_search_download_cost_changed", "The download terms changed. Confirm the current allowance.");
    await service.confirmSession(req, res, session); connected(req, res);
    if (Number(approved.until) < Date.now()) throw new HttpError(409, "evimed_search_download_cost_changed", "The download offer expired. Confirm the current allowance.");
    if (current.status === 5 || receipts.get(receiptKey) > Date.now()) return { approved: true };
    try {
      await call(service, req, session, EVIMED_ACTION_PATHS.confirm, { ...fullTextParameters(category, parameters), name: parameters.title || parameters.name || "" });
    } catch (error) {
      if (!["evimed_search_balance_insufficient", "evimed_search_profile_required", "evimed_search_credential_expired", "evimed_search_rate_limited"].includes(error?.code)) {
        const uncertain = UNCERTAIN.get(service) ?? new Map(); UNCERTAIN.set(service, uncertain);
        for (const [pendingKey, until] of uncertain) if (until <= Date.now()) uncertain.delete(pendingKey);
        uncertain.set(key, session.expiresAt);
        throw new HttpError(409, "evimed_search_download_confirmation_pending", "The download confirmation result is unknown. Refresh its status before trying again.");
      }
      throw error;
    }
    receipts.set(receiptKey, Number(approved.until));
    for (const [receipt, until] of receipts) if (until <= Date.now()) receipts.delete(receipt);
    while (receipts.size > 500) receipts.delete(receipts.keys().next().value);
    await service.confirmSession(req, res, session);
    return { approved: true };
  });
  locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}

/** @param {any} service @param {any} req @param {any} res @param {string} category @param {string} operation @param {unknown} body */
export async function evimedSearchAction(service, req, res, category, operation, body) {
  if (!["literature", "guidelines", "drugs"].includes(category) || !EVIMED_SEARCH_ACTIONS.includes(operation)) throw new HttpError(404, "evimed_search_action_unavailable", "The action is unavailable for this record.");
  const batch = ["citations", "export"].includes(operation);
  fields(body, batch ? ["actionRefs", "format"] : operation === "collection" ? ["actionRef", "collected"] : operation === "fulltext-confirm" ? ["offerRef"] : ["actionRef"]);
  if (!object(body)) throw invalid();
  const session = await service.session(req, res);
  if (batch) {
    if (category !== "literature" || !Array.isArray(body.actionRefs) || !body.actionRefs.length || body.actionRefs.length > 20 || !Number.isInteger(body.format) || !((operation === "export" ? [1, 2, 3] : [0, 1, 2, 3, 4, 5, 6]).includes(body.format))) throw invalid();
    const ids = [...new Set(body.actionRefs.map(ref => reference(service, session, category, ref).id))];
    if (ids.some(id => typeof id !== "string" || !id)) throw invalid();
    if (operation === "export") return exportRecords(service, req, res, session, ids, body.format);
    const data = await call(service, req, session, EVIMED_ACTION_PATHS.citations, { ids, type: body.format }, false);
    const labels = ["GB/T 7714", "查新格式", "Refworks", "EndNote", "NoteFirst", "Bibtex", "NoteExpress"];
    const quotes = (Array.isArray(data) ? data.slice(0, 100) : [data]).map(row => ({ label: clean(object(row) ? row.type || row.name || row.style : "", 100) || labels[body.format], text: clean(object(row) ? row.content ?? row.value ?? row.text ?? row.citation ?? row.data : row, 20_000) })).filter(row => row.text);
    await service.confirmSession(req, res, session);
    return redact({ quotes }, session.credential);
  }
  if (operation === "fulltext-confirm") {
    const approved = reference(service, session, `${category}:download`, body.offerRef);
    if (!Number.isFinite(Number(approved.until)) || Number(approved.until) < Date.now()) throw new HttpError(409, "evimed_search_download_cost_changed", "The download offer expired. Confirm the current allowance.");
    const parameters = reference(service, session, category, approved.actionRef);
    return confirmDownload(service, req, res, session, category, approved, parameters);
  }
  const parameters = reference(service, session, category, body.actionRef);
  if (operation === "collection") {
    if (typeof body.collected !== "boolean") throw invalid();
    const status = body.collected ? 1 : 0;
    const payload = category === "literature" ? { ids: [parameters.id], status } : category === "guidelines" ? { excIds: [parameters.name || parameters.title || parameters.id], exclude: 3, screenId: parameters.screenId || "", starMark: status, type: "" } : { drugName: "", excId: parameters.pdfName, exclude: 3, instructionName: parameters.title || parameters.name || "", screenId: parameters.screenId || "", source: String(parameters.source || "").toUpperCase(), starMark: status, type: "" };
    await service.confirmSession(req, res, session); connected(req, res);
    await call(service, req, session, EVIMED_ACTION_PATHS[`${category}Collection`], payload, category === "literature" ? false : "PUT");
    await service.confirmSession(req, res, session);
    return { collected: body.collected };
  }
  if (operation === "fulltext-request") {
    const current = await fullTextStatus(service, req, session, category, parameters);
    if (current.status !== 0) { await service.confirmSession(req, res, session); return current; }
    await service.confirmSession(req, res, session); connected(req, res);
    await call(service, req, session, EVIMED_ACTION_PATHS.request, fullTextParameters(category, parameters));
  }
  if (operation === "fulltext-offer") {
    const offer = await fullTextOffer(service, req, session, category, parameters);
    if (!offer.url) throw unavailable();
    await service.confirmSession(req, res, session);
    return { ...offer, offerRef: sealEvimedSearchReference(service.config, session, `${category}:download`, { actionRef: body.actionRef, amount: String(offer.amount), fileDigest: digest(offer.url), until: String(Date.now() + 5 * 60_000) }) };
  }
  const status = await fullTextStatus(service, req, session, category, parameters);
  await service.confirmSession(req, res, session);
  return status;
}
