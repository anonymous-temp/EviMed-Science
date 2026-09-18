// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Colour is a token (DESIGN.md): a component names a role — `text-muted`,
 * `bg-accent-soft`, `var(--series-3)` — and `src/index.css` says what the role
 * is in each theme. A hex literal in a component is a colour that no theme
 * switch, contrast audit or brand change can reach; the shell carried the
 * upstream blue in its logo for a month that way.
 *
 * ESLint already rejects `bg-[#…]`-style classes; this catches the rest — a hex
 * in a `style`, an SVG attribute, a canvas call or a CSS string. The allowlist
 * is the places where a colour is content, not chrome, each with its reason.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED: Record<string, string> = {
  "index.css": "the token file itself",
  "components/inspector/OfficePreview.tsx": "styles for a rendered Office document inside its own shadow root",
  "components/inspector/AnomalyMapView.tsx": "a data map drawn on a fixed dark scientific canvas",
  "components/inspector/FitsView.tsx": "an astronomy image well, fixed dark",
  "components/inspector/MeshView.tsx": "WebGL scene background handed to the renderer",
  "components/inspector/QCodeView.tsx": "a label colour handed to the circuit renderer",
  "lib/xlsx.ts": "default cell border when a spreadsheet does not declare one",
};

// `&#123;` and `#anchor` are not colours; a colour is 3, 4, 6 or 8 hex digits.
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "__fixtures__") continue;
      files.push(...sourceFiles(path));
    } else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

describe("colour lives in the token file", () => {
  it("finds no hex literal in a component outside the named exceptions", () => {
    const files = sourceFiles(SRC);
    // Prove the walk walked before trusting what it did not find: a broken
    // walk that scans nothing passes forever.
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(SRC, file))).toContain("index.css");
    expect(HEX.test(readFileSync(join(SRC, "index.css"), "utf8"))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      const name = relative(SRC, file).split("\\").join("/");
      if (ALLOWED[name]) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        // Comments may name a colour to explain a decision.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (HEX.test(line)) offenders.push(`${name}:${index + 1}  ${trimmed.slice(0, 120)}`);
      });
    }
    expect(offenders, "move these colours into src/index.css as a token, or name the exception above with its reason").toEqual([]);
  });

  it("keeps every named exception honest", () => {
    // An exception for a file that no longer has a hex literal is a hole
    // waiting for the next one.
    for (const name of Object.keys(ALLOWED)) {
      expect(HEX.test(readFileSync(join(SRC, name), "utf8")), `${name} no longer needs its exception`).toBe(true);
    }
  });
});
