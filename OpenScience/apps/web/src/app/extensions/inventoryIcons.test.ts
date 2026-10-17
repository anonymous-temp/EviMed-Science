import { expect, it } from "vitest";
import { RUNTIME_INVENTORY_WORDS } from "@evimed/domain/runtime-inventory";
import { SKILL_DISPLAY_GEO_GROUP, SKILL_DISPLAY_GROUPS, SKILL_DISPLAY_LOOPX_GROUP } from "@evimed/domain/skill-display";
import { SKILL_GROUP_ICON } from "./extensionCopy";
import { INVENTORY_ICONS, inventoryIcon } from "./inventoryIcons";

// The page names nothing the platform carries: the words and the icon names are the vocabulary's, and what this page keeps are
// the marks. These hold the two to each other, so an item or a group added to the vocabulary cannot reach the page as a plain piece.
it("every icon the vocabulary names is one the page draws, and an unknown name is the plain piece", () => {
  for (const [id, item] of Object.entries(RUNTIME_INVENTORY_WORDS.items)) {
    expect(Object.keys(INVENTORY_ICONS), `${id}: ${item.icon}`).toContain(item.icon);
  }
  expect(inventoryIcon("NoSuchIcon")).toBe(inventoryIcon("AlsoNone"));
  expect(inventoryIcon("Repeat")).not.toBe(inventoryIcon("NoSuchIcon"));
});

it("every skill group the server can name has its mark: the module's two are named by the server, the rest are here", () => {
  const named = new Set([SKILL_DISPLAY_GEO_GROUP, SKILL_DISPLAY_LOOPX_GROUP]);
  for (const group of SKILL_DISPLAY_GROUPS.filter(name => !named.has(name))) expect(SKILL_GROUP_ICON[group], group).toBeDefined();
  expect(SKILL_GROUP_ICON["我的技能"]).toBeDefined();
  expect(Object.keys(SKILL_GROUP_ICON)).not.toContain("社区");
});
