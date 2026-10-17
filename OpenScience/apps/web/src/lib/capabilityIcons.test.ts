import { describe, expect, it } from "vitest";
import { CAPABILITY_DISPLAY, capabilityListed } from "@evimed/domain";
import { CAPABILITY_ICONS, capabilityIcon } from "./capabilityIcons";

// The marks are typed by hand beside a catalogue that is generated, so the two are held to each other here (R19, I6): the
// class that kept 长任务 off the plugins page was a hand table with nothing that could fail between it and what is installed.
describe("capability icons", () => {
  const listed = Object.keys(CAPABILITY_DISPLAY).filter(capabilityListed);

  it("gives every capability 科研工具 lists a mark of its own, and none is the fallback", () => {
    expect(listed.length).toBe(16);
    const fallback = capabilityIcon("no-such-capability");
    for (const id of listed) expect(capabilityIcon(id), id).not.toBe(fallback);
  });

  it("names no capability the catalogue does not have", () => {
    for (const id of Object.keys(CAPABILITY_ICONS)) expect(Object.keys(CAPABILITY_DISPLAY), `${id} is not a capability of the catalogue`).toContain(id);
  });
});
