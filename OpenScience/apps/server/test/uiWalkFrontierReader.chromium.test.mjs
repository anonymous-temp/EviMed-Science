// Account-scoped browser acceptance for the addressed frontier reader. No runtime or external writes are started.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";
import { frontierItemRoute } from "../../../scripts/ops/ui-walk.mjs";

const executable = process.env.OPEN_SCIENCE_MANAGED_BROWSER_TEST_CHROME;
const base = process.env.OPEN_SCIENCE_WALK_BASE_URL;
const passwordFile = process.env.OPEN_SCIENCE_WALK_PASSWORD_FILE;
const username = process.env.OPEN_SCIENCE_WALK_USER;
const skip = !(executable && base && passwordFile && username) && "An explicit browser and authenticated fixture/deployment account are required";
const out = process.env.OPEN_SCIENCE_READER_TEST_OUT ?? "/tmp/evimed-frontier-reader-test";

for (const [size, viewport] of [["desktop", { width: 1512, height: 945 }], ["phone", { width: 390, height: 844 }]]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`published frontier article supports direct reading, publisher source and history: ${size}/${colorScheme}`, { skip }, async () => {
      const browser = await chromium.launch({ executablePath: executable, headless: true });
      try {
        const context = await browser.newContext({ viewport, colorScheme });
        const login = await context.request.post(`${base}/api/auth/login`, { data: { username, password: (await readFile(passwordFile, "utf8")).trim() } });
        assert.equal(login.status(), 200, "the configured account must authenticate");
        const response = await context.request.get(`${base}/api/frontier/items?limit=10`);
        assert.equal(response.status(), 200);
        const published = (await response.json()).data;
        const selected = published.items?.[Math.min(5, published.items.length - 1)];
        const route = frontierItemRoute({ items: selected ? [selected] : [] });
        assert.ok(route, "a published article is required; an empty fixture is not coverage");
        const item = published.items.find((entry) => route.endsWith(encodeURIComponent(entry.id)));
        assert.ok(item.title && item.url, "the article must retain its headline and publisher URL");
        const page = await context.newPage();
        // A pasted address and a reload both read the same preserved record.
        await page.goto(`${base}${route}`);
        await page.getByRole("heading", { level: 1, name: item.title, exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: /^原文/ }).getAttribute("href"), item.url);
        assert.equal(await page.getByRole("dialog").count(), 0, "the reader is an addressed page");
        await page.reload();
        await page.getByRole("heading", { level: 1, name: item.title, exact: true }).waitFor();
        // The same title in the feed enters that address; Back restores the chosen feed and scroll.
        await page.goto(`${base}/app/frontier?view=all`);
        const link = page.locator(`a[href="${route}"]`).filter({ hasText: item.title }).first();
        await link.scrollIntoViewIfNeeded();
        const scroll = () => [...globalThis.document.querySelectorAll("*")].filter((node) => node.scrollTop > 0).map((node) => Math.round(node.scrollTop));
        const before = await page.evaluate(scroll);
        if (published.items.length > 5) assert.ok(before.some((top) => top > 0), "the history check starts away from the top of a populated feed");
        await link.click();
        await page.waitForURL(`${base}${route}`);
        await page.getByRole("heading", { level: 1, name: item.title, exact: true }).waitFor();
        await mkdir(out, { recursive: true });
        await page.screenshot({ path: `${out}/frontier-reader-${size}-${colorScheme}.png` });
        await page.goBack();
        await page.waitForURL(`${base}/app/frontier?view=all`);
        await page.getByRole("heading", { level: 1, name: "前沿动态", exact: true }).waitFor();
        await page.waitForFunction((expected) => JSON.stringify([...globalThis.document.querySelectorAll("*")].filter((node) => node.scrollTop > 0).map((node) => Math.round(node.scrollTop))) === JSON.stringify(expected), before);
        assert.deepEqual(await page.evaluate(scroll), before);
      } finally {
        await browser.close();
      }
    });
  }
}
