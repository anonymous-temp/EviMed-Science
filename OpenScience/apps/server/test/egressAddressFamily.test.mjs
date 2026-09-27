// Outbound connections go over IPv4, one attempt, before the server starts
// (2026-09-26 audit I1-1: the container has no IPv6 route and Node's family
// race abandoned IPv4 handshakes slower than 250 ms, so ClinicalTrials.gov and
// NCBI calls failed ETIMEDOUT at 20–80 % from Beijing).
import assert from "node:assert/strict";
import dns from "node:dns";
import { readFile } from "node:fs/promises";
import net from "node:net";
import test from "node:test";
import { preferIpv4Egress } from "../src/webReadNetwork.mjs";

test("the process stops racing address families and resolves IPv4 first", () => {
  assert.equal(net.getDefaultAutoSelectFamily(), true, "Node 22's default, which is what failed");
  preferIpv4Egress();
  assert.equal(net.getDefaultAutoSelectFamily(), false);
  assert.equal(dns.getDefaultResultOrder(), "ipv4first");
});

test("the web process applies it before it creates the app", async () => {
  const entry = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  const applied = entry.indexOf("preferIpv4Egress();");
  assert.ok(applied > 0, "index.mjs calls preferIpv4Egress()");
  assert.ok(applied < entry.indexOf("createWebApiApp()"), "before the app is created");
  // The integration audit's check reads the server sources for this call
  // (registry source.gateway-egress-dualstack).
  const network = await readFile(new URL("../src/webReadNetwork.mjs", import.meta.url), "utf8");
  assert.match(network, /setDefaultAutoSelectFamily\(\s*false\s*\)/);
});
