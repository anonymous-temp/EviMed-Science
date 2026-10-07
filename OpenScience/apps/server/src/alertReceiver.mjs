/**
 * The receiving end of Alertmanager: every alert the monitoring stack raises
 * becomes an item in each operator's inbox — and, through the inbox's own
 * channel hook, a Feishu message for an operator who bound Feishu.
 *
 * Hidden knowledge: until 2026-09-28 Alertmanager's only receiver was an
 * operator webhook on the public host, and nginx answered that path with
 * `return 204`. Every alert was accepted and dropped; the frontier
 * source-health alert fired from 09-27 and reached nobody. Alertmanager now
 * delivers here over the compose network (scripts/ops/configure-monitoring.mjs).
 *
 * - Authenticated by its own bearer credential (OPEN_SCIENCE_ALERT_RECEIVER_TOKEN
 *   _FILE), not the scrape token: reading metrics and writing to the operators'
 *   inbox are different permissions. Without one the route answers 404, as the
 *   metrics route does without its token.
 * - One inbox item per alert instance (fingerprint + start), per operator: the
 *   firing notice, and its resolution folded into the same item, which comes
 *   back unread. Alertmanager re-sends a firing alert every repeat interval
 *   and retries a failed delivery; each replay is recognised by its key and
 *   changes nothing.
 * - The item reads in Chinese: a title and one sentence per rule from
 *   `alertNotices.mjs`, 「系统告警」 with the rule's summary for a rule it does
 *   not know (2026-10-07: the inbox used to show the rule's program name).
 * - An alert labelled `audit_probe="true"` (the integration audit's) is
 *   recorded as a probe — a counter and a timestamp on /api/ops/metrics — and
 *   never written to anyone's inbox.
 * - Nothing is dropped quietly: with no operator configured, or an inbox write
 *   failing, the answer is a 5xx, so Alertmanager retries and counts the
 *   failure in its own notification metrics.
 *
 * @module alertReceiver
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { alertNoticeText } from "./alertNotices.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";

export const ALERT_RECEIVER_PATH = "/api/ops/alerts";
/** The label that makes an alert the audit's probe. */
export const ALERT_PROBE_LABEL = "audit_probe";
/** An Alertmanager webhook body carries at most `max_alerts` (20) alerts; a
 *  body past this is not one. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ALERTS = 100;

/** @param {string} value */
function digest(value) {
  return createHash("sha256").update(value).digest();
}

/** @param {string} expected @param {string} actual */
function tokenMatches(expected, actual) {
  if (!expected || !actual) return false;
  return timingSafeEqual(digest(expected), digest(actual));
}

/** @param {any} req */
function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization ?? "").trim());
  return match ? match[1].trim() : "";
}

/** @param {unknown} value @param {number} max */
function shortText(value, max) {
  // Control characters (tab and newline aside) become spaces: a label is one
  // line of an inbox notice, and its value comes from a rule's template.
  return [...String(value ?? "")].map((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 ? " " : char;
  }).join("").trim().slice(0, max);
}

/**
 * One alert out of a webhook body, or null when it is not one.
 * @param {any} value
 */
function parsedAlert(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.status === "resolved" ? "resolved" : value.status === "firing" ? "firing" : null;
  const labels = value.labels && typeof value.labels === "object" && !Array.isArray(value.labels) ? value.labels : null;
  if (!status || !labels) return null;
  /** @type {Record<string, string>} */
  const cleanLabels = {};
  for (const [key, label] of Object.entries(labels).slice(0, 40)) {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) cleanLabels[key] = shortText(label, 300);
  }
  const alertname = cleanLabels.alertname;
  if (!alertname) return null;
  const startsAt = Number.isFinite(Date.parse(value.startsAt)) ? new Date(value.startsAt).toISOString() : null;
  if (!startsAt) return null;
  const endsAt = Number.isFinite(Date.parse(value.endsAt)) ? new Date(value.endsAt).toISOString() : null;
  const annotations = value.annotations && typeof value.annotations === "object" && !Array.isArray(value.annotations) ? value.annotations : {};
  const fingerprint = /^[0-9a-f]{8,64}$/.test(String(value.fingerprint ?? ""))
    ? String(value.fingerprint)
    : digest(JSON.stringify(Object.entries(cleanLabels).sort())).toString("hex").slice(0, 16);
  return {
    status, alertname, fingerprint, startsAt, endsAt, labels: cleanLabels,
    summary: shortText(annotations.summary, 500),
    description: shortText(annotations.description, 2000),
  };
}

/**
 * The inbox item for one alert: a Chinese title and one sentence (`alertNotices.mjs`),
 * never the rule's own name and never its labels. A resolution keeps the
 * title and says it is over, so the item it folds into reads as one story.
 * @param {NonNullable<ReturnType<typeof parsedAlert>>} alert
 */
function inboxItem(alert) {
  const severity = alert.labels.severity ?? "";
  const resolved = alert.status === "resolved";
  const { title, sentence } = alertNoticeText(alert);
  const instance = `${alert.fingerprint}:${alert.startsAt}`;
  return {
    noticeType: "notify",
    severity: resolved ? "info" : ["critical", "page", "warning"].includes(severity) ? "attention" : "info",
    title: `${resolved ? "已恢复：" : ""}${title}`.slice(0, 150),
    body: (resolved ? "这个问题已经解除，现在不需要处理。" : sentence).slice(0, 8000),
    // One item per alert instance; its resolution folds into it.
    groupKey: `ops-alert:${instance}`.slice(0, 200),
    // One write per (instance, status); a replay changes nothing.
    idempotencyKey: `ops-alert:${instance}:${alert.status}`.slice(0, 200),
    source: { type: "system", id: `ops-alert-${alert.fingerprint}` },
  };
}

/**
 * @param {{ config: any, notificationService: any, now?: () => Date }} options
 */
export function createAlertReceiver({ config, notificationService, now = () => new Date() }) {
  const counts = {
    firing: { delivered: 0, failed: 0 },
    resolved: { delivered: 0, failed: 0 },
    probes: 0,
    rejected: 0,
  };
  let lastProbeAt = 0;

  /**
   * Answers a delivery, or throws an HttpError for the server's own error
   * handling to answer and record (the error ledger is where a refused
   * delivery should show).
   * @param {any} req @param {any} res
   */
  async function handle(req, res) {
    const token = String(config.alertReceiverToken ?? "");
    if (!token) throw new HttpError(404, "not_found", "Route not found.");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Alerts are delivered with POST.");
    if (!tokenMatches(token, bearer(req))) {
      counts.rejected += 1;
      throw new HttpError(401, "alert_receiver_unauthorized", "The alert receiver's credential is required.");
    }
    const body = await readJson(req, MAX_BODY_BYTES);
    const raw = Array.isArray(body?.alerts) ? body.alerts : null;
    if (!raw || raw.length > MAX_ALERTS) {
      counts.rejected += 1;
      throw new HttpError(400, "alert_receiver_payload_invalid", "An Alertmanager webhook body with its alerts is required.");
    }
    const alerts = raw.map(parsedAlert).filter((alert) => alert !== null);
    const probes = alerts.filter((alert) => alert.labels[ALERT_PROBE_LABEL] === "true");
    const real = alerts.filter((alert) => alert.labels[ALERT_PROBE_LABEL] !== "true");
    if (probes.length) {
      counts.probes += probes.length;
      lastProbeAt = now().getTime();
    }
    if (real.length === 0) {
      sendJson(res, 200, { data: { received: alerts.length, delivered: 0, probes: probes.length } });
      return;
    }
    const operators = Array.isArray(config.operatorUsers) ? config.operatorUsers.filter(Boolean) : [];
    if (!notificationService || operators.length === 0) {
      for (const alert of real) counts[alert.status].failed += operators.length || 1;
      throw new HttpError(503, notificationService ? "alert_receiver_no_recipients" : "alert_receiver_inbox_unavailable",
        notificationService ? "No operator account is configured to receive alerts (OPEN_SCIENCE_OPERATOR_USERS)." : "The inbox is unavailable.");
    }
    let delivered = 0;
    let failed = 0;
    for (const alert of real) {
      const item = inboxItem(alert);
      for (const userId of operators) {
        try {
          await notificationService.create(userId, item, { now: now() });
          counts[alert.status].delivered += 1;
          delivered += 1;
        } catch {
          counts[alert.status].failed += 1;
          failed += 1;
        }
      }
    }
    // A partial write is retried whole: every item already written is
    // recognised by its key, so the retry writes only what is missing.
    if (failed) throw new HttpError(503, "alert_receiver_inbox_failed", "Some alerts could not be written to the inbox; retry.");
    sendJson(res, 200, { data: { received: alerts.length, delivered, probes: probes.length } });
  }

  return {
    handle,
    /** The receiver's counters for /api/ops/metrics. */
    metricFamilies() {
      return [
        {
          name: "open_science_ops_alerts_total",
          help: "Alertmanager notices the control plane's receiver took: written to operators' inboxes (one per operator) or failed, by alert status; audit probes; and refused deliveries.",
          type: /** @type {const} */ ("counter"),
          series: [
            { value: counts.firing.delivered, labels: { status: "firing", outcome: "delivered" } },
            { value: counts.firing.failed, labels: { status: "firing", outcome: "failed" } },
            { value: counts.resolved.delivered, labels: { status: "resolved", outcome: "delivered" } },
            { value: counts.resolved.failed, labels: { status: "resolved", outcome: "failed" } },
            { value: counts.probes, labels: { status: "probe", outcome: "received" } },
            { value: counts.rejected, labels: { status: "none", outcome: "rejected" } },
          ],
        },
        {
          name: "open_science_ops_alert_probe_last_received_seconds",
          help: "When the receiver last took an audit probe alert (Unix seconds; 0 since this process started without one).",
          type: /** @type {const} */ ("gauge"),
          series: [{ value: Math.floor(lastProbeAt / 1000) }],
        },
      ];
    },
  };
}
