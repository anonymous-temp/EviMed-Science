// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLOR_ROLES, colorRole } from "@evimed/design-tokens";

/**
 * The web app manifest: what a phone's 「添加到主屏幕」 installs. A Feishu card
 * opens the web app on a phone, and this makes that app something to come
 * back to — no service worker, so no offline copy and no web push.
 *
 * The icons are rasterized from `src/assets/evimed-app-icon.svg`: the tile as
 * drawn at 192 and 512 px, and a maskable variant — the same mark at 95 % on a
 * full-bleed brand-700 square, inside the 40 % safe circle — that also serves
 * as the iOS home-screen icon (iOS paints transparent corners black) and as
 * the Feishu bot's avatar. The server caches unhashed files for a year, so a
 * changed icon needs a new `?v=`.
 */
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(WEB, path), "utf8");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

const manifest = JSON.parse(read("public/manifest.json")) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  lang: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
};
const html = read("index.html");
const css = read("src/index.css");

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(path: string): string {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString("latin1"), `${path} is a PNG`).toBe("PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

/** A public URL as the file it names. */
const publicFile = (url: string) => join(WEB, "public", url.split("?")[0]);

describe("the web app manifest", () => {
  it("installs EviMed standalone, opening a conversation, in Chinese", () => {
    expect(manifest.short_name).toBe("EviMed");
    expect(manifest.start_url).toBe("/app/chat");
    expect(manifest.id).toBe(manifest.start_url);
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("zh-CN");
  });

  it("takes its colours from the tokens: the light canvas, as the page's own theme-color does", () => {
    // The manifest has one colour, and the page's per-scheme meta tags take
    // over once it has loaded. Read the role rather than a primitive step: the
    // canvas has moved twice (cool paper grey, white, and now the blue-grey the
    // fusion brought), and a test pinned to a ramp step would have gone green on
    // the wrong colour each time. In the stylesheet the role points at its step,
    // so the assertion follows the same indirection.
    const canvas = colorRole("bg", "light");
    expect(css).toContain(`--bg: var(--${COLOR_ROLES.bg.light})`);
    expect(css).toContain(`--${COLOR_ROLES.bg.light}: ${canvas}`);
    expect(manifest.theme_color).toBe(canvas);
    expect(manifest.background_color).toBe(canvas);
    expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${canvas}" />`);
  });

  it("lists icons that exist at the sizes they claim, a maskable one among them", () => {
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
      expect(pngSize(publicFile(icon.src)), icon.src).toBe(icon.sizes);
    }
  });

  it("is linked from the page, with the home-screen icon iOS reads instead", () => {
    const manifestHref = /<link rel="manifest" href="([^"]+)"/.exec(html)?.[1];
    expect(manifestHref).toMatch(/^\/manifest\.json\?v=\d+$/);
    const touchHref = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(touchHref).toBeDefined();
    expect(pngSize(publicFile(touchHref!))).toBe("180x180");
  });

  it("has the avatar the Feishu bot is created with", () => {
    // imService.mjs names this file in the registration preset.
    expect(pngSize(publicFile("/icons/evimed-maskable-512.png"))).toBe("512x512");
  });
});
