// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { COLOR_RAMPS, COLOR_ROLES, colorRole } from "@evimed/design-tokens";

/**
 * The web app manifest: what a phone's “添加到主屏幕” installs. A Feishu card
 * opens the web app on a phone, and this makes that app something to come
 * back to — no service worker, so no offline copy and no web push.
 *
 * The icons are the EviMed molecule mark (spec §3.2, appendix E #18, audit
 * F-G8), rasterized from two sources in `src/assets/`: `evimed-app-icon.svg`
 * — a white ground, the mark in brand blue with a 12 % margin — at 192, 512
 * and the 180 px Apple touch icon; and `evimed-app-icon-maskable.svg` — brand
 * blue to the edges, the mark in white inside the centre 60 % — at 512, which
 * is also the Feishu bot's avatar. The server caches unhashed files for a
 * year, so a changed icon needs a new `?v=`.
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
  description: string;
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

  it("describes the product in words it still uses (appendix E #19)", () => {
    expect(manifest.description).toBe("向 EviMed 提问、发起研究，在手机上查看报告");
    expect(manifest.description).not.toContain("运行记录");
  });
});

/**
 * An 8-bit RGB or RGBA, non-interlaced PNG's pixels — the kind the icons are —
 * decoded with the standard library: the five scanline filters over the
 * inflated IDAT stream. Enough to ask what colour an icon is.
 */
function pngPixels(path: string): { width: number; height: number; channels: number; data: Uint8Array } {
  const bytes = readFileSync(path);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const [depth, colourType, interlace] = [bytes[24], bytes[25], bytes[28]];
  expect(depth, path).toBe(8);
  expect(interlace, path).toBe(0);
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  expect(channels, `${path}: colour type ${colourType}`).toBeGreaterThan(0);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (type === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
      const paeth = () => {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      };
      const predictor = [0, left, up, (left + up) >> 1, paeth()][filter] ?? 0;
      data[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** The share of an icon's pixels that are exactly one colour. */
function share(path: string, hex: string): number {
  const { width, height, channels, data } = pngPixels(path);
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  let hits = 0;
  for (let at = 0; at < data.length; at += channels) {
    if (data[at] === r && data[at + 1] === g && data[at + 2] === b) hits += 1;
  }
  return hits / (width * height);
}

describe("the icons are the EviMed mark in brand blue (appendix E #18, audit F-G8)", () => {
  const brand = COLOR_RAMPS.brand[600];
  const retiredTeal = "#00756b";

  it("draws the app icons on white with the mark in brand blue, and the maskable one blue to the edge", () => {
    for (const icon of ["/icons/evimed-192.png", "/icons/evimed-512.png", "/icons/apple-touch-icon.png"]) {
      expect(share(publicFile(icon), "#ffffff"), icon).toBeGreaterThan(0.6);
      expect(share(publicFile(icon), brand), icon).toBeGreaterThan(0.1);
    }
    const maskable = publicFile("/icons/evimed-maskable-512.png");
    expect(share(maskable, brand)).toBeGreaterThan(0.6);
    expect(share(maskable, "#ffffff")).toBeGreaterThan(0.05);
    // The edge is ground, so any mask a platform cuts keeps the whole mark.
    const { width, channels, data } = pngPixels(maskable);
    expect([...data.subarray(0, 3)]).toEqual([10, 93, 193]);
    expect([...data.subarray((width - 1) * channels, (width - 1) * channels + 3)]).toEqual([10, 93, 193]);
  });

  it("leaves no retired teal in public/ — not in a file's text, not in an icon's pixels", () => {
    const files = readdirSync(join(WEB, "public"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      if (file.endsWith(".png")) expect(share(file, retiredTeal), file).toBe(0);
      else expect(readFileSync(file, "utf8").toLowerCase(), file).not.toContain("00756b");
    }
    for (const source of ["src/assets/evimed-mark.svg", "src/assets/evimed-app-icon.svg", "src/assets/evimed-app-icon-maskable.svg"]) {
      const svg = read(source).toLowerCase();
      expect(svg, source).not.toContain("00756b");
      expect(svg, source).toContain(brand);
    }
  });

  it("links every icon with the cache buster that changed with it", () => {
    for (const icon of manifest.icons) expect(icon.src, icon.src).toMatch(/\?v=2$/);
    expect(html).toContain('<link rel="manifest" href="/manifest.json?v=2" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png?v=2" />');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/src/assets/evimed-mark.svg" />');
  });

  it("asks dual-engine browsers for their Chromium engine, and builds for the stated floor (appendix E #33)", () => {
    expect(html).toContain('<meta name="renderer" content="webkit" />');
    expect(html).toMatch(/<html lang="zh-CN">/);
    // The feature floor of spec §34.3 — Chromium 109, iOS 15.4 — not Vite's default.
    const config = read("vite.config.ts");
    expect(config).toMatch(/export const BUILD_TARGET = \["chrome109", "edge109", "firefox115", "safari15\.4", "ios15\.4"\];/);
    expect(config).toMatch(/build: \{\n {4}target: BUILD_TARGET,/);
  });
});
