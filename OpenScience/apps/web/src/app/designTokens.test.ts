// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLOR_ROLES,
  CONTAINERS,
  DESIGN_TOKENS_CSS_BEGIN,
  DESIGN_TOKENS_CSS_END,
  FONT_STACKS,
  RADII,
  TYPE_SCALE,
  TYPE_SIZES,
  designTokensCss,
  kernelThemeTokens,
} from "@evimed/domain/design-tokens";
import tailwindConfig from "../../tailwind.config.js";

/**
 * The design system has one source — `packages/domain/src/designTokens.mjs` —
 * and three consumers that cannot import it as JavaScript, import it as a
 * build input, or are compiled somewhere else entirely. This file is what
 * makes "one source" a fact rather than a comment:
 *
 *  1. `src/index.css` carries a generated block. A generator nobody checks is
 *     how the shell and the kernel frame drifted into two hand-maintained
 *     tables in the first place, so the block is regenerated here and compared
 *     byte for byte.
 *  2. `tailwind.config.js` derives its scales from the module; the assertions
 *     below prove the derivation is live, not a copy that looks like one.
 *  3. A colour written as a literal anywhere in `src/` reaches no theme
 *     switch, contrast audit or brand change.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const INDEX_CSS = join(SRC, "index.css");

/**
 * Tailwind types every scale as `ResolvableTo<…>` — a value *or* a function of
 * the plugin utilities — so nothing in it is indexable until it is resolved.
 * Ours is a literal object built from the token module, which is the whole
 * point of the assertions below, so it is read as one.
 */
const theme = (tailwindConfig.theme?.extend ?? {}) as {
  colors?: Record<string, string>;
  fontFamily?: Record<string, string>;
  fontSize?: Record<string, [string, string]>;
  maxWidth?: Record<string, string>;
  borderRadius?: Record<string, string>;
};

const ALLOWED: Record<string, string> = {
  "index.css": "the token file itself",
  "components/inspector/OfficePreview.tsx": "styles for a rendered Office document inside its own shadow root",
  "components/inspector/AnomalyMapView.tsx": "a data map drawn on a fixed dark scientific canvas",
  "components/inspector/FitsView.tsx": "an astronomy image well, fixed dark",
  "components/inspector/MeshView.tsx": "WebGL scene background handed to the renderer",
  "components/inspector/QCodeView.tsx": "a label colour handed to the circuit renderer",
  "lib/xlsx.ts": "default cell border when a spreadsheet does not declare one",
};

// `&#123;` and `#anchor` are not colours; a colour is 3, 4, 6 or 8 hex digits
// — or a colour function, which reaches a theme no better than a hex does.
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/;

// Any serif face the chrome must not name. `serif` alone would match
// `sans-serif`, so the generic keyword is checked separately.
const SERIF_FACES = /source serif|songti|georgia|cambria|times new roman|noto serif|source han serif|simsun|宋体/i;

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

describe("the token table has one source", () => {
  it("regenerates the block in index.css byte for byte", () => {
    const css = readFileSync(INDEX_CSS, "utf8");
    const start = css.indexOf(DESIGN_TOKENS_CSS_BEGIN);
    const end = css.indexOf(DESIGN_TOKENS_CSS_END);
    expect(start, "index.css lost its generated-token markers").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const checkedIn = css.slice(start, end + DESIGN_TOKENS_CSS_END.length);
    expect(checkedIn, "run `pnpm tokens:css` — index.css no longer matches @evimed/domain/design-tokens").toEqual(
      designTokensCss(),
    );
  });

  it("defines every colour role in both themes, and nothing outside the block redefines one", () => {
    const css = readFileSync(INDEX_CSS, "utf8");
    const generated = designTokensCss();
    const outside = css.split(generated).join("");
    for (const role of Object.keys(COLOR_ROLES)) {
      expect(generated).toContain(`--${role}:`);
      // Two declarations, one per theme.
      expect(generated.split(`  --${role}:`).length - 1, `--${role} must be set in light and dark`).toBe(2);
      expect(outside, `--${role} is redefined outside the generated block`).not.toContain(`--${role}:`);
    }
  });

  it("derives the tailwind theme from the module rather than restating it", () => {
    expect(theme.fontFamily?.sans).toBe(FONT_STACKS.sans);
    expect(theme.borderRadius?.card).toBe(`${RADII.card}px`);
    expect(theme.borderRadius?.DEFAULT).toBe(`${RADII.control}px`);
    expect(theme.maxWidth?.content).toBe(`${CONTAINERS.content}px`);
    expect(theme.maxWidth?.["content-wide"]).toBe(`${CONTAINERS.wide}px`);
    for (const [rung, { size, lineHeight }] of Object.entries(TYPE_SCALE)) {
      expect(theme.fontSize?.[rung], `the ${rung} rung`).toEqual([`${size}px`, lineHeight]);
    }
    // Every colour role is reachable as a class, and every colour Tailwind
    // knows is a `var()` — never a literal a theme switch cannot move.
    for (const role of Object.keys(COLOR_ROLES)) {
      expect(theme.colors?.[role], `the ${role} role`).toBe(`var(--${role})`);
    }
    for (const value of Object.values(theme.colors ?? {})) {
      expect(String(value)).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  it("feeds the kernel frame the same values", () => {
    const frame = kernelThemeTokens();
    // The shell's accent and the conversation's send button are one colour, or
    // the two halves of the window are visibly two products.
    expect(frame["--dsw-alias-button-info-fill"].light).toBe("#00756b");
    expect(frame["--dsw-alias-bg-base"]).toEqual({ light: "#ffffff", dark: "#14181a" });
    expect(frame["--dsw-font-family"].light).toBe(FONT_STACKS.sans);
    // The two sidebars are the same grey.
    expect(frame["--dsw-specific-sidebar-fill"].light).toBe("#f8f8f9");
    for (const [name, pair] of Object.entries(frame)) {
      expect(name, "a frame token must be a --dsw-* custom property").toMatch(/^--dsw-/);
      expect(typeof pair.light, `${name}.light`).toBe("string");
      expect(typeof pair.dark, `${name}.dark`).toBe("string");
    }
  });
});

describe("the type scale is closed and sans-only", () => {
  it("uses exactly the six agreed sizes", () => {
    const used = [...new Set(Object.values(TYPE_SCALE).map((rung) => rung.size))].sort((a, b) => a - b);
    expect(used).toEqual([...TYPE_SIZES]);
    expect(TYPE_SIZES).toEqual([12, 13, 14, 16, 20, 24]);
  });

  it("names no serif face, in the module or in either consumer", () => {
    expect(FONT_STACKS.sans).not.toMatch(SERIF_FACES);
    expect(FONT_STACKS.sans.replace(/sans-serif/g, "")).not.toMatch(/\bserif\b/);
    for (const file of ["index.css", "../tailwind.config.js"] as const) {
      const source = readFileSync(join(SRC, file), "utf8");
      // Strip comments before matching: a comment may name the face the
      // rectification removed, and explaining a decision is what they are for.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} names a serif face`).not.toMatch(SERIF_FACES);
    }
    // `font-serif` survives only as an alias of the sans stack, so a page
    // nobody has migrated does not fall back to the browser's Georgia.
    expect(theme.fontFamily?.serif).toBe(FONT_STACKS.sans);
  });

  it("ships no serif webfont", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const serifFonts = Object.keys(pkg.dependencies).filter((name) => /serif/i.test(name));
    expect(serifFonts, "a serif webfont is still installed").toEqual([]);
    expect(readFileSync(INDEX_CSS, "utf8")).not.toMatch(/@import .*serif/i);
  });
});

describe("colour lives in the token file", () => {
  it("finds no hex literal in a component outside the named exceptions", () => {
    const files = sourceFiles(SRC);
    // Prove the walk walked before trusting what it did not find: a broken
    // walk that scans nothing passes forever.
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(SRC, file))).toContain("index.css");
    expect(HEX.test(readFileSync(INDEX_CSS, "utf8"))).toBe(true);

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
    expect(offenders, "move these colours into packages/domain/src/designTokens.mjs, or name the exception above with its reason").toEqual([]);
  });

  it("keeps every named exception honest", () => {
    // An exception for a file that no longer has a hex literal is a hole
    // waiting for the next one.
    for (const name of Object.keys(ALLOWED)) {
      expect(HEX.test(readFileSync(join(SRC, name), "utf8")), `${name} no longer needs its exception`).toBe(true);
    }
  });
});
