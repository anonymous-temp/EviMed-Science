"""Capture public reference pages without signing in or changing remote data."""
import json
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://aihot.news"
PAGES = [("home", "/"), ("all", "/all"), ("hot", "/hot"),
         ("topics", "/topics"), ("daily", "/daily"), ("weekly", "/weekly"),
         ("monthly", "/monthly"), ("starred", "/starred"), ("agent", "/agent"),
         ("changelog", "/changelog"), ("leaderboard", "/leaderboard"),
         ("codex-reset", "/codex-reset")]

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    version = browser.version
    context = browser.new_context(viewport={"width": 1440, "height": 1000},
        user_agent=f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36",
        locale="zh-CN", timezone_id="Asia/Shanghai", ignore_https_errors=True)
    page = context.new_page()
    records = []
    extra = {}

    def capture(name, path, mobile=False):
        url = path if path.startswith("https://") else ORIGIN + path
        response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(850)
        links = page.locator("a[href]").evaluate_all("es => es.map(e => ({text:e.textContent.trim(),href:e.getAttribute('href')}))")
        data = {"url": page.url, "status": response.status, "title": page.title(),
                "capturedAt": datetime.now(timezone.utc).isoformat(), "viewport": page.viewport_size,
                "text": page.locator("body").inner_text(), "links": links,
                "metrics": page.evaluate("""() => ({scrollWidth:document.documentElement.scrollWidth,
                  main:document.querySelector('main')?.getBoundingClientRect().toJSON(),
                  firstArticle:document.querySelector('article')?.getBoundingClientRect().toJSON()})""")}
        page.screenshot(path=str(ROOT / "captures" / f"{name}.png"), full_page=False)
        (ROOT / "research" / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
        records.append({k: data[k] for k in ["url", "status", "title", "capturedAt", "viewport", "metrics"]} | {"name":name})
        print(json.dumps({"name":name, "status":response.status, "title":data["title"], "chars":len(data["text"])}, ensure_ascii=False), flush=True)
        return links

    for name, path in PAGES:
        try:
            links = capture("aihot-" + name, path)
            for key, prefix in [("story", "/story/"), ("item", "/items/"), ("topic", "/topics/")]:
                match = next((link["href"] for link in links if link["href"].startswith(prefix)), None)
                if match and key not in extra: extra[key] = match
        except Exception as error:
            print(json.dumps({"name":name, "error":str(error)[:250]}), flush=True)
    for name, path in extra.items():
        try: capture("aihot-" + name, path)
        except Exception as error: print(name, str(error)[:150], flush=True)
    page.set_viewport_size({"width":390,"height":844})
    capture("aihot-home-mobile", "/", True)
    page.set_viewport_size({"width":1440,"height":1000})
    capture("evimed-public-home", "https://www.evimed.com/home")
    page.get_by_role("button", name="证据专区", exact=True).click()
    page.wait_for_timeout(1500)
    capture("evimed-public-zones", page.url)
    (ROOT / "research" / "captures.json").write_text(json.dumps(records, ensure_ascii=False, indent=2))
    browser.close()
