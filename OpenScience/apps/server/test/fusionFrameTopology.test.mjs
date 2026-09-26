/**
 * Where the conversation frame is allowed to live once EviMed Science is served
 * from EviMed's own hostname.
 *
 * The fusion plan (§9.3) rules that the shell and the frame share a hostname and
 * differ only by port, and explicitly rejects the obvious alternative — a
 * `frame.evimed.com` subdomain — because that only works if the login cookie is
 * widened to `.evimed.com`, which hands the Science session to every other
 * subdomain of the platform. That is precisely the exposure the plan's P0-2
 * exists to remove, so a later "just use a subdomain, it's simpler" has to fail
 * something rather than merely contradict a document.
 *
 * `runtimeUiOrigins` already enforced this, for its own reasons and before the
 * fusion existed. This file is what ties the rule to the decision.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeUiOrigins } from "../src/runtimeUiFrames.mjs";

/** @param {string} publicUrl @param {string} runtimeUiPublicOrigin */
const topology = (publicUrl, runtimeUiPublicOrigin) => ({ publicUrl, runtimeUiPublicOrigin, production: true });

/**
 * The refusal carries its reason in `code`; the message is the same sentence for
 * every frame refusal, so matching on it would pass for the wrong reason.
 * @param {unknown} error
 */
const refused = (error) => /** @type {{ code?: string, status?: number }} */ (error).code === "runtime_ui_origins_invalid"
  && /** @type {{ status?: number }} */ (error).status === 503;

test("the fused topology is one hostname and two ports", () => {
  // What production becomes once EviMed proxies /api/* to the control plane:
  // the shell is the Vue application at the apex, the frame is a second port on
  // the same name, and the session cookie stays host-only.
  assert.deepEqual(runtimeUiOrigins(topology("https://www.evimed.com", "https://www.evimed.com:8789")), {
    shellOrigin: "https://www.evimed.com",
    uiOrigin: "https://www.evimed.com:8789",
  });
});

test("a frame subdomain is refused, because it would need the login cookie widened", () => {
  assert.throws(
    () => runtimeUiOrigins(topology("https://www.evimed.com", "https://frame.evimed.com")),
    refused,
  );
  assert.throws(
    () => runtimeUiOrigins(topology("https://www.evimed.com", "https://evimed.com:8789")),
    refused,
  );
});

test("the frame never shares an origin with the shell, and never drops TLS in production", () => {
  // Same origin would put the kernel's whole surface inside the shell's own
  // document, and the frame is sandboxed precisely so it is not.
  assert.throws(() => runtimeUiOrigins(topology("https://www.evimed.com", "https://www.evimed.com")), refused);
  assert.throws(() => runtimeUiOrigins(topology("http://www.evimed.com", "http://www.evimed.com:8789")), refused);
  assert.throws(() => runtimeUiOrigins(topology("https://www.evimed.com", "http://www.evimed.com:8789")), refused);
});

test("a path, a query or credentials in either origin is refused", () => {
  // An origin with a path is a prefix someone hoped would scope the frame; it
  // does not, and `frame-ancestors` would be computed from the wrong string.
  for (const ui of ["https://www.evimed.com:8789/frame", "https://www.evimed.com:8789/?x=1", "https://u:p@www.evimed.com:8789"]) {
    assert.throws(() => runtimeUiOrigins(topology("https://www.evimed.com", ui)), refused, ui);
  }
});
