"""Read-only browser acceptance against the real isolated hosted application.

No API interception, native evidence mutation, model request or runtime launch.
The login is a disposable acceptance account created by start_acceptance.mjs.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("FRONTIER_ACCEPTANCE_BASE", "http://127.0.0.1:5183")
assert BASE.startswith("http://127.0.0.1:"), "Only use the isolated local acceptance application"
SCROLLER = ".h-full.min-h-0.overflow-y-auto.bg-bg"
results = {"base": BASE, "dataKind": "real HTTP application; isolated PostgreSQL acceptance fixtures", "checks": [], "pageErrors": [], "captures": []}


def record(name, ok, **details):
    results["checks"].append({"name": name, "passed": bool(ok), **details})
    print(name, "PASS" if ok else "FAIL", flush=True)


def screenshot(page, name):
    filename = f"implementation-reader-{name}.png"
    page.screenshot(path=str(ROOT / "captures" / filename))
    results["captures"].append(filename)


def state(page):
    return page.evaluate("""() => ({url:location.pathname+location.search,
      items:[...document.querySelectorAll('[data-frontier-item]')].map(e=>e.dataset.frontierItem),
      expanded:[...document.querySelectorAll('[data-frontier-item]')].filter(e=>e.querySelector('[aria-expanded=true]')).map(e=>e.dataset.frontierItem),
      scroll:document.querySelector('.h-full.min-h-0.overflow-y-auto.bg-bg')?.scrollTop??0})""")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    context = browser.new_context(viewport={"width": 1200, "height": 900}, color_scheme="light")
    login = context.request.post(f"{BASE}/api/auth/login", data={"username": "frontier-owner", "password": "acceptance-only-password"})
    record("real acceptance-account login", login.status == 200, status=login.status)
    page = context.new_page()
    page.on("pageerror", lambda error: results["pageErrors"].append(str(error)))
    try:
        page.goto(f"{BASE}/app/frontier?view=all&lane=evidence")
        page.wait_for_selector("[data-frontier-item]")
        initial_count = page.locator("[data-frontier-item]").count()
        page.get_by_role("button", name="加载更多", exact=True).click()
        page.wait_for_function("() => document.querySelectorAll('[data-frontier-item]').length > 30")
        loaded_count = page.locator("[data-frontier-item]").count()
        record("real second feed page loaded", loaded_count > initial_count, before=initial_count, after=loaded_count)
        event_card = page.locator("[data-frontier-item]").nth(2)
        event_id = event_card.get_attribute("data-frontier-item")
        event_card.get_by_role("button", name="展开摘要", exact=True).click()
        page.locator(SCROLLER).evaluate("element => element.scrollTop=420")
        page.wait_for_timeout(100)
        screenshot(page, "desktop-expanded")
        event_card.get_by_role("button", name="更多操作", exact=True).click()
        page.get_by_role("menu", name="更多操作", exact=True).wait_for()
        event_action = page.get_by_role("menuitem", name="同一事件的全部报道", exact=True)
        if not event_action.count():
            page.keyboard.press("Escape")
            reports = event_card.get_by_role("button", name="另有 2 家报道", exact=False)
            if reports.count():
                reports.click()
        event_action = page.get_by_role("menuitem", name="同一事件的全部报道", exact=True)
        record("associated event reachable from card menu", event_action.count() == 1, associatedCard=event_id)
        if event_action.count():
            before = state(page)
            event_action.click()
            page.wait_for_url("**/app/frontier/events/**")
            page.get_by_role("navigation", name="返回", exact=True).wait_for()
            screenshot(page, "event")
            page.get_by_role("navigation", name="返回", exact=True).get_by_role("link", name="前沿动态", exact=True).click()
            page.wait_for_function("() => document.querySelectorAll('[data-frontier-item]').length >= 45")
            page.wait_for_timeout(400)
            after = state(page)
            record("event return restores filtered URL", after["url"] == before["url"], before=before["url"], after=after["url"])
            record("event return restores every loaded feed page", after["items"] == before["items"], beforeCount=len(before["items"]), afterCount=len(after["items"]))
            record("event return restores expanded summary", after["expanded"] == before["expanded"], before=before["expanded"], after=after["expanded"])
            record("event return restores internal scroll", abs(after["scroll"] - before["scroll"]) <= 3, before=before["scroll"], after=after["scroll"])
            screenshot(page, "returned-position")

        page.set_viewport_size({"width": 320, "height": 820})
        page.goto(f"{BASE}/app/frontier?view=all")
        page.wait_for_selector("[data-frontier-item]")
        widths = page.evaluate("""() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,
          main:document.querySelector('main')?.getBoundingClientRect().width,
          overflow:[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&e.getBoundingClientRect().width>0).slice(0,8).map(e=>({tag:e.tagName,text:e.textContent?.slice(0,40)}))})""")
        record("320px page has no horizontal overflow", widths["document"] <= 320, **widths)
        navigation = page.get_by_role("navigation", name="前沿动态", exact=True)
        labels = navigation.locator("a,button").all_text_contents() if navigation.count() else []
        record("320px navigation names remain readable", all(label in "".join(labels) for label in ["动态", "证据专区", "简报", "关注"]), labels=labels)
        screenshot(page, "mobile-320")

        page.set_viewport_size({"width": 1200, "height": 900})
        for view, key, value in [("daily", "day", "2026-10-01"), ("weekly", "week", "2026-09-21")]:
            page.goto(f"{BASE}/app/frontier?view={view}&{key}={value}")
            page.get_by_role("tablist", name="简报周期", exact=True).wait_for()
            page.wait_for_timeout(300)
            page.reload()
            page.get_by_role("tablist", name="简报周期", exact=True).wait_for()
            parsed = parse_qs(urlsplit(page.url).query)
            record(f"{view} archive URL survives reload", parsed.get("view") == [view] and parsed.get(key) == [value], url=page.url)
            screenshot(page, view)
        tabs = page.get_by_role("tablist", name="简报周期", exact=True)
        tabs.get_by_role("tab", name="周报", exact=True).focus()
        page.keyboard.press("ArrowLeft")
        page.wait_for_function("() => new URLSearchParams(location.search).get('view')==='daily'")
        page.wait_for_function("() => document.querySelector('[role=tab][aria-selected=true]')?.textContent==='日报'")
        record("keyboard selects daily tab and retains focus", page.get_by_role("tab", name="日报", exact=True).get_attribute("aria-selected") == "true" and page.evaluate("document.activeElement?.textContent") == "日报")
        page.get_by_role("tab", name="日报", exact=True).focus()
        page.keyboard.press("ArrowRight")
        page.wait_for_function("() => new URLSearchParams(location.search).get('view')==='weekly'")
        page.wait_for_function("() => document.querySelector('[role=tab][aria-selected=true]')?.textContent==='周报'")
        record("keyboard selects weekly tab", page.get_by_role("tab", name="周报", exact=True).get_attribute("aria-selected") == "true")
        page.goto(f"{BASE}/app/frontier?view=all")
        page.wait_for_selector("[data-frontier-item]")
        page.emulate_media(color_scheme="dark")
        page.wait_for_function("() => document.documentElement.dataset.theme==='dark'")
        record("system dark theme reaches reader", page.evaluate("document.documentElement.dataset.theme") == "dark")
        screenshot(page, "dark")
        page.emulate_media(color_scheme="light")
        page.wait_for_function("() => document.documentElement.dataset.theme==='light'")
        record("system light theme restores reader", page.evaluate("document.documentElement.dataset.theme") == "light")
    except Exception as error:
        record("browser execution completes", False, error=str(error))
    finally:
        record("no browser JavaScript errors", not results["pageErrors"])
        results["passed"] = all(check["passed"] for check in results["checks"])
        (ROOT / "research" / "reader-browser.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
        browser.close()
