"""Exercise the review prototype; no application or provider requests are made."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:5182/prototype.html"
observations = []
errors = []

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    context = browser.new_context(permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    for width in [1440, 768, 390, 320]:
        page.set_viewport_size({"width": width, "height": 900 if width > 760 else 844})
        for view in ["feed", "topics", "topic/emergency", "evidence", "brief", "following"]:
            page.goto(BASE + "#" + view)
            expect(page.locator("#content")).not_to_be_empty()
            metrics = page.evaluate("""() => ({width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
              firstEvidence:document.querySelector('[data-evidence]')?.getBoundingClientRect().y,
              firstNews:document.querySelector('.feed-row')?.getBoundingClientRect().y,
              tabs:[...document.querySelectorAll('.tabs button')].map(e=>({text:e.textContent,
                height:e.getBoundingClientRect().height,whiteSpace:getComputedStyle(e).whiteSpace}))})""")
            assert metrics["scrollWidth"] <= width, (view, width, metrics)
            assert all(t["whiteSpace"] == "nowrap" for t in metrics["tabs"])
            observations.append({"view": view, "metrics": metrics})
            if width in [1440, 390]:
                page.screenshot(path=str(ROOT / "captures" / f"proposal-{view.replace('/', '-')}-{width}.png"))

    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(BASE + "#topics")
    page.locator('[data-action="field:急诊医学"]').click()
    expect(page.locator(".topic")).to_have_count(1)
    page.locator('[data-action="topic:emergency"]').click()
    expect(page.locator("[data-evidence]")).to_have_count(3)
    page.locator('[data-action="detail:co-risk"]').click()
    expect(page.locator("#detail")).to_be_visible()
    page.locator('#dialog-actions [data-action="star:co-risk"]').click()
    expect(page.locator('#dialog-actions [data-action="star:co-risk"]')).to_have_attribute("aria-pressed", "true")
    page.locator('#dialog-actions [data-action="ask:co-risk"]').click()
    expect(page.locator("#draft")).to_contain_text("乳酸清除率")
    page.locator('[data-action="copy-question"]').click()
    assert "乳酸清除率" in page.evaluate("navigator.clipboard.readText()")
    page.keyboard.press("Escape")
    expect(page.locator("#detail")).not_to_be_visible()
    page.locator('[data-view="evidence"]').click()
    page.locator('[data-action="saved:only"]').click()
    expect(page.locator("[data-evidence]")).to_have_count(1)
    page.locator("#search").fill("no-match-example")
    expect(page.locator(".empty")).to_be_visible()
    page.locator("#search").fill("")
    page.locator('[data-view="following"]').click()
    expect(page.locator(".feed-row")).to_have_count(1)
    page.locator('[data-action="manage"]').click()
    page.locator('#detail [data-action="follow:gut"]').click()
    page.keyboard.press("Escape")
    expect(page.locator(".feed-row")).to_have_count(2)
    page.locator('[data-view="brief"]').click()
    page.locator('a[href="#brief-topics"]').click()
    page.locator('[data-action="issue:周报"]').click()
    expect(page.locator(".paper-title")).to_have_text("循证周报")
    page.locator("#theme").click()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    page.screenshot(path=str(ROOT / "captures" / "proposal-dark.png"))
    assert not errors, errors
    browser.close()

result = {"viewports": [1440, 768, 390, 320], "pageChecks": len(observations),
          "interactionChecks": ["topic filter", "topic membership", "evidence reading", "star", "scoped question draft",
            "copy", "Escape dismissal", "saved filter", "search empty state", "following aggregate", "follow management",
            "report anchor and period switch", "dark theme"], "observations": observations, "errors": errors}
(ROOT / "research" / "prototype-verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps({"pageChecks": len(observations), "interactionChecks": len(result["interactionChecks"]), "errors": errors}))
