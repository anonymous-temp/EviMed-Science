// Alertmanager's receiving end (2026-09-28). Until then its only receiver was
// a public path nginx answered `return 204`, and every alert was dropped.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ALERT_RECEIVER_PATH, createAlertReceiver } from "../src/alertReceiver.mjs";
import { sendError } from "../src/security.mjs";
import { createWebApiApp } from "../src/server.mjs";

const TOKEN = "alert-receiver-token-for-tests-0123456789abcdef";

function alertmanagerBody(alerts) {
  return { version: "4", status: alerts[0]?.status ?? "firing", receiver: "operator-webhook", groupLabels: {}, commonLabels: {}, alerts };
}

const firing = {
  status: "firing",
  labels: { alertname: "EvimedFrontierSourcesUnhealthy", severity: "warning", service: "evimed-knowledge-plugin" },
  annotations: { summary: "启用源健康率低于 95%", description: "healthy_rate=0.939" },
  startsAt: "2026-09-27T08:00:00.000Z",
  endsAt: "0001-01-01T00:00:00Z",
  fingerprint: "a1b2c3d4e5f60718",
};

/** A receiver behind a plain server, answering thrown errors the way the app does. */
async function serve(t, { config, notificationService }) {
  const receiver = createAlertReceiver({ config, notificationService, now: () => new Date("2026-09-28T02:00:00.000Z") });
  const server = http.createServer((req, res) => {
    receiver.handle(req, res).catch((error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}${ALERT_RECEIVER_PATH}`;
  const post = (body, token = TOKEN) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { receiver, post };
}

function recordingInbox({ failFor = null } = {}) {
  const created = [];
  return {
    created,
    async create(userId, item) {
      if (failFor === userId) throw new Error("inbox write failed");
      created.push({ userId, ...item });
      return { id: `n-${created.length}` };
    },
  };
}

test("each alert reaches every operator's inbox as one item per incident, its resolution folded in", async (t) => {
  const inbox = recordingInbox();
  const { receiver, post } = await serve(t, { config: { alertReceiverToken: TOKEN, operatorUsers: ["sxjxw-research", "ops-2"] }, notificationService: inbox });

  const first = await post(alertmanagerBody([firing]));
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data, { received: 1, delivered: 2, probes: 0 });
  assert.deepEqual(inbox.created.map((item) => item.userId), ["sxjxw-research", "ops-2"]);
  const [notice] = inbox.created;
  assert.equal(notice.noticeType, "notify");
  assert.equal(notice.severity, "attention");
  assert.equal(notice.title, "告警：EvimedFrontierSourcesUnhealthy");
  assert.match(notice.body, /启用源健康率低于 95%/);
  assert.match(notice.body, /开始：2026-09-27T08:00:00.000Z/);
  assert.match(notice.body, /service=evimed-knowledge-plugin/);
  assert.deepEqual(notice.source, { type: "system", id: "ops-alert-a1b2c3d4e5f60718" });

  // Alertmanager re-sends a firing alert every repeat interval: the same keys,
  // which the inbox recognises and leaves as they are.
  await post(alertmanagerBody([firing]));
  const replay = inbox.created[2];
  assert.equal(replay.idempotencyKey, notice.idempotencyKey);
  assert.equal(replay.groupKey, notice.groupKey);
  assert.equal(replay.body, notice.body, "a replay is byte-identical, so the inbox's replay check holds");

  const resolved = { ...firing, status: "resolved", endsAt: "2026-09-28T01:30:00.000Z" };
  await post(alertmanagerBody([resolved]));
  const recovery = inbox.created[4];
  assert.equal(recovery.title, "已恢复：EvimedFrontierSourcesUnhealthy");
  assert.equal(recovery.severity, "info");
  assert.match(recovery.body, /结束：2026-09-28T01:30:00.000Z/);
  assert.equal(recovery.groupKey, notice.groupKey, "the resolution folds into the firing item");
  assert.notEqual(recovery.idempotencyKey, notice.idempotencyKey);

  // A new incident of the same alert is a new item.
  await post(alertmanagerBody([{ ...firing, startsAt: "2026-09-29T08:00:00.000Z" }]));
  assert.notEqual(inbox.created[6].groupKey, notice.groupKey);

  const families = Object.fromEntries(receiver.metricFamilies().map((family) => [family.name, family]));
  const delivered = families.open_science_ops_alerts_total.series.find((row) => row.labels.status === "firing" && row.labels.outcome === "delivered");
  assert.equal(delivered.value, 6);
});

test("a probe alert is recorded, never written to anyone's inbox", async (t) => {
  const inbox = recordingInbox();
  const { receiver, post } = await serve(t, { config: { alertReceiverToken: TOKEN, operatorUsers: ["sxjxw-research"] }, notificationService: inbox });
  const probe = { ...firing, labels: { alertname: "EvimedAlertReceiverProbe", severity: "info", audit_probe: "true" }, fingerprint: "ffffffffffffffff" };
  const answer = await post(alertmanagerBody([probe]));
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).data, { received: 1, delivered: 0, probes: 1 });
  assert.equal(inbox.created.length, 0);
  const families = Object.fromEntries(receiver.metricFamilies().map((family) => [family.name, family]));
  assert.equal(families.open_science_ops_alert_probe_last_received_seconds.series[0].value, Date.parse("2026-09-28T02:00:00.000Z") / 1000);
  assert.equal(families.open_science_ops_alerts_total.series.find((row) => row.labels.status === "probe").value, 1);
});

test("nothing is dropped quietly: no credential, a wrong one, no operator or a failed write each answer by name", async (t) => {
  const off = await serve(t, { config: { alertReceiverToken: "", operatorUsers: ["a"] }, notificationService: recordingInbox() });
  assert.equal((await off.post(alertmanagerBody([firing]))).status, 404, "unconfigured, the route does not exist");

  const on = await serve(t, { config: { alertReceiverToken: TOKEN, operatorUsers: ["a"] }, notificationService: recordingInbox() });
  const wrong = await on.post(alertmanagerBody([firing]), "not-the-token");
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).code, "alert_receiver_unauthorized");
  assert.equal((await on.post(alertmanagerBody([firing]), "")).status, 401);
  const invalid = await on.post({ version: "4" });
  assert.equal(invalid.status, 400);

  const nobody = await serve(t, { config: { alertReceiverToken: TOKEN, operatorUsers: [] }, notificationService: recordingInbox() });
  const unrouted = await nobody.post(alertmanagerBody([firing]));
  assert.equal(unrouted.status, 503, "Alertmanager retries and counts the failure");
  assert.equal((await unrouted.json()).code, "alert_receiver_no_recipients");

  const noInbox = await serve(t, { config: { alertReceiverToken: TOKEN, operatorUsers: ["a"] }, notificationService: null });
  assert.equal((await (await noInbox.post(alertmanagerBody([firing]))).json()).code, "alert_receiver_inbox_unavailable");

  const inbox = recordingInbox({ failFor: "b" });
  const partial = await serve(t, { config: { alertReceiverToken: TOKEN, operatorUsers: ["a", "b"] }, notificationService: inbox });
  const failed = await partial.post(alertmanagerBody([firing]));
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, "alert_receiver_inbox_failed");
  assert.deepEqual(inbox.created.map((item) => item.userId), ["a"], "what was written stays written; the retry is recognised by its key");
});

test("in the composed app the route is reached without a session, before the CSRF gate", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-alert-receiver-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, alertReceiverToken: TOKEN, operatorMetricsToken: "alert-metrics-token-0123456789abcdef" });
  try {
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const probe = { ...firing, labels: { alertname: "EvimedAlertReceiverProbe", severity: "info", audit_probe: "true" } };
    const delivered = await fetch(`${base}${ALERT_RECEIVER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(alertmanagerBody([probe])),
    });
    assert.equal(delivered.status, 200, await delivered.clone().text());
    const refused = await fetch(`${base}${ALERT_RECEIVER_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alertmanagerBody([probe])),
    });
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).code, "alert_receiver_unauthorized", "refused by the receiver, not by the session gate");
    const metrics = await (await fetch(`${base}/api/ops/metrics`, { headers: { Authorization: "Bearer alert-metrics-token-0123456789abcdef" } })).text();
    assert.ok(metrics.split("\n").includes('open_science_ops_alerts_total{status="probe",outcome="received"} 1'), metrics.split("\n").filter((line) => line.includes("ops_alert")).join("\n"));
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
