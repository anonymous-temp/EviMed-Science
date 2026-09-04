import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const schedulerSource = path.join(repoRoot, "scripts/ops/release-receipt-scheduler.mjs");

/**
 * The scheduler beside a gate that mints instantly.
 *
 * `scriptDir` is derived from the scheduler's own location and the gate is
 * addressed by name, so a copy in a temporary directory is how the real loop
 * gets exercised without a real kernel run.
 */
async function stagedScheduler(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evimed-receipt-scheduler-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(schedulerSource, path.join(dir, "release-receipt-scheduler.mjs"));
  await fs.writeFile(
    path.join(dir, "deepseek-kernel-release-gate.mjs"),
    'process.stdout.write(JSON.stringify({ ok: true, receiptId: "dsrg_test", mode: "production" }) + "\\n");\n',
    "utf8",
  );
  return dir;
}

function startScheduler(dir, stateFile) {
  const child = spawn(process.execPath, [path.join(dir, "release-receipt-scheduler.mjs"), "run"], {
    env: {
      ...process.env,
      OPEN_SCIENCE_RECEIPT_STATE_FILE: stateFile,
      // The floor the config allows. Long enough that a scheduler which
      // actually waits is still running when this test looks.
      OPEN_SCIENCE_RECEIPT_INTERVAL_SECONDS: "300",
      OPEN_SCIENCE_RECEIPT_RETRY_SECONDS: "300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
  return { child, lines };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the scheduler sleeps after minting instead of exiting", async (t) => {
  // It did exit: both timers in the wait were unref'd, so once the gate's child
  // was reaped nothing held the event loop open. The process ended cleanly,
  // `restart: unless-stopped` restarted it, and it minted again -- about three
  // times a minute instead of twice a day, each one a paid kernel chain. 2,165
  // mints had gone through before the restart counter was read.
  const dir = await stagedScheduler(t);
  const stateFile = path.join(dir, "state.json");
  const { child, lines } = startScheduler(dir, stateFile);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  const exited = once(child, "exit").then(([code]) => ({ exited: true, code }));
  const waited = delay(4_000).then(() => ({ exited: false }));
  const outcome = await Promise.race([exited, waited]);

  assert.equal(
    outcome.exited,
    false,
    `the scheduler exited (code ${outcome.code}) after minting; the restart policy would mint again immediately`,
  );
  assert.ok(
    lines.some((line) => JSON.parse(line).event === "receipt.minted"),
    `the scheduler did not mint at all: ${lines.join(" | ")}`,
  );
});

test("a sleeping scheduler still stops promptly when told to", async (t) => {
  // The reason the timers were unref'd in the first place. Keeping the loop
  // alive must not cost a twelve-hour shutdown, so the poll that watches for
  // the signal clears both timers rather than being unref'd itself.
  const dir = await stagedScheduler(t);
  const { child, lines } = startScheduler(dir, path.join(dir, "state.json"));
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  const started = Date.now();
  while (!lines.some((line) => JSON.parse(line).event === "receipt.minted")) {
    assert.ok(Date.now() - started < 10_000, "the scheduler never minted");
    await delay(100);
  }
  child.kill("SIGTERM");
  const [code] = await Promise.race([
    once(child, "exit"),
    delay(8_000).then(() => { throw new Error("the scheduler did not exit within 8s of SIGTERM"); }),
  ]);
  assert.equal(code, 0);
  assert.ok(
    lines.some((line) => JSON.parse(line).event === "receipt.scheduler.stopped"),
    "the scheduler exited without saying it had stopped",
  );
});
