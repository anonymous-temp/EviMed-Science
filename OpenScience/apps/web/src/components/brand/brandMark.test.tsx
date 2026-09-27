import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EVIMED_MARK_PATH, EviMedMark } from "./EviMedMark";

/**
 * One mark across the product (spec §3.2, audit F-G8): the EviMed molecule,
 * in the accent colour, in the sidebar, on the login page, in the browser tab
 * and on the home screen. The research workbench's teal four-node mark is
 * retired, and this is where it would be noticed coming back.
 */
// A string, not `new URL(…)`: under jsdom `URL` is the DOM's, which Node's
// `fileURLToPath` does not accept.
const WEB = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(WEB, "src");

/** The old mark, as it was drawn: its bonds and its nodes, and its two teals. */
const RETIRED = [
  { what: "the node mark's bonds", pattern: /M18 27 9\.5 18\.5/ },
  { what: "the node mark's centre node", pattern: /cx="18" cy="27" r="5\.5"/ },
  { what: "the app icon's bonds", pattern: /M210 286 124 200/ },
  { what: "循证青 #00756b", pattern: /#?00756b/i },
  { what: "the dark scheme's teal #63c5b9", pattern: /#?63c5b9/i },
];

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

describe("the EviMed mark", () => {
  it("is the molecule the favicon and the app icons draw, in the accent colour", () => {
    const favicon = readFileSync(join(SRC, "assets/evimed-mark.svg"), "utf8");
    expect(favicon).toContain(`d="${EVIMED_MARK_PATH}"`);
    const { container } = render(<EviMedMark className="h-5 w-5" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-label", "EviMed");
    expect(svg).toHaveClass("text-accent");
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toHaveAttribute("d", EVIMED_MARK_PATH);
    expect(paths[0]).toHaveAttribute("fill", "currentColor");
    expect(svg.querySelector("circle")).toBeNull();
  });

  it("is what the sidebar and the login page draw", () => {
    for (const shell of ["components/sidebar/Sidebar.tsx", "app/routes/LoginPage.tsx"]) {
      const text = readFileSync(join(SRC, shell), "utf8");
      expect(text, shell).toMatch(/import \{ EviMedMark \} from "@\/components\/brand\/EviMedMark";/);
      expect(text, shell).toMatch(/<EviMedMark\b/);
    }
  });

  it("leaves nothing of the retired teal node mark in the shell", () => {
    const shell = [...files(SRC), ...files(join(WEB, "public")), join(WEB, "index.html")]
      .filter((path) => /\.(tsx?|css|svg|html|json|js)$/.test(path) && !/\.test\.tsx?$/.test(path));
    // Prove the walk walked before trusting what it did not find.
    expect(shell.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const path of shell) {
      const text = readFileSync(path, "utf8");
      for (const { what, pattern } of RETIRED) if (pattern.test(text)) found.push(`${relative(WEB, path)}: ${what}`);
    }
    expect(found).toEqual([]);
  });
});
