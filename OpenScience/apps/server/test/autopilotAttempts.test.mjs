import assert from "node:assert/strict";
import test from "node:test";
import * as autopilot from "../src/autopilotService.mjs";

test("attempt identities change execution and verifier workspace without changing logical billing or claim identity", () => {
  const episode = `episode-${"a".repeat(32)}`;
  const verifier = `${episode}-v0`;
  assert.equal(autopilot.autopilotAttemptDispatchId(episode,1),episode);
  assert.equal(autopilot.autopilotAttemptDispatchId(episode,2),`${episode}-a2`);
  assert.equal(autopilot.autopilotLogicalDispatchId(`${episode}-a2`),episode);
  const retry = autopilot.autopilotAttemptDispatchId(verifier,10);
  assert.equal(autopilot.autopilotLogicalDispatchId(retry),verifier);
  assert.equal(autopilot.verificationEpisodeId(retry),episode);
  assert.equal(autopilot.verificationWorkspacePath(retry),`.evimed-verification/${retry}`);
  assert.notEqual(autopilot.verificationWorkspacePath(retry),autopilot.verificationWorkspacePath(verifier));
  assert.equal(autopilot.autopilotLogicalDispatchId("unowned-a2"),null);
  assert.equal(autopilot.verificationEpisodeId(`${episode}-a2`),null);
});
