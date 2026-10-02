"""Browser acceptance against the real local app and isolated PostgreSQL only."""
import json
import os
import time
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("FRONTIER_ACCEPTANCE_URL", "http://127.0.0.1:5183")
assert BASE.startswith("http://127.0.0.1:"), "Never run acceptance against production"
ROOT = Path(__file__).resolve().parent.parent
CAPTURES = ROOT / "captures"
RESULTS = []
ERRORS = []
COMPLETED = False
ZONE_TITLE = "急诊诊疗进展 · 验收示例"
CARD_TITLE = "证据整理与来源核对 · 验收示例"
BODY = "This is isolated browser acceptance evidence. It is not a clinical recommendation. BODY-SNAPSHOT-42."


def passed(name, **details):
    RESULTS.append({"check": name, "passed": True, **details})
    print("PASS", name, flush=True)


def api(context, method, path, data=None, status=200):
    csrf = context.request.get(BASE + "/api/me").json()["data"]["csrfToken"]
    response = context.request.fetch(BASE + "/api" + path, method=method,
                                     data=data, headers={"x-open-science-csrf": csrf})
    assert response.status == status, (path, response.status, response.text()[:300])
    payload = response.json()
    return payload.get("data", payload)


def ready(page, path):
    page.goto(BASE + path)
    page.get_by_role("navigation", name="前沿动态", exact=True).wait_for()


def login(browser, account):
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="zh-CN")
    page = context.new_page()
    page.on("pageerror", lambda error: ERRORS.append(str(error)))
    page.goto(BASE + "/app/frontier")
    page.get_by_label("账号", exact=True).fill(account)
    page.get_by_label("密码", exact=True).fill("acceptance-only-password")
    page.get_by_role("button", name="登录", exact=True).click()
    page.wait_for_url("**/app/**")
    ready(page, "/app/frontier")
    return context, page


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True,
                                args=["--no-sandbox"])
    owner, page = login(browser, "frontier-owner")
    reader, other = login(browser, "frontier-reader")
    try:
        expect(page.get_by_role("navigation", name="前沿动态", exact=True)).to_have_text("动态证据专区简报关注")
        passed("four primary destinations and native login")
        ready(page, "/app/frontier/zones")
        expect(page.get_by_text("暂无证据专区", exact=True)).to_be_visible()
        page.get_by_role("button", name="新建专区", exact=True).click()
        page.get_by_label("专区名称", exact=True).fill(ZONE_TITLE)
        page.get_by_label("专区简介", exact=True).fill("隔离验收数据：验证证据整理、来源引用与讨论流程。")
        page.get_by_role("button", name="取消", exact=True).click()
        expect(page.get_by_role("alertdialog")).to_be_visible()
        page.get_by_role("alertdialog").get_by_role("button", name="取消", exact=True).click()
        expect(page.get_by_label("专区名称", exact=True)).to_have_value(ZONE_TITLE)
        passed("cancel preserves dirty zone after declining confirmation")
        page.get_by_role("button", name="保存专区", exact=True).click()
        page.wait_for_url("**/frontier/zones/*")
        expect(page.get_by_role("heading", name=ZONE_TITLE, exact=True)).to_be_visible()
        zone_id = page.url.split("/zones/")[1].split("?")[0]
        zone_path = f"/frontier/zones/{zone_id}"
        api(reader, "GET", zone_path, status=404)
        passed("created zone is persisted and private by default")
        page.get_by_role("button", name="添加证据", exact=True).click()
        page.get_by_label("证据标题", exact=True).fill(CARD_TITLE)
        page.get_by_label("摘要", exact=True).fill("用简短摘要介绍结论，正文与引用保留完整依据。")
        page.get_by_label("证据正文", exact=True).fill(BODY)
        page.get_by_label("适用范围与局限", exact=True).fill("仅用于界面验收，不用于临床决策。")
        page.get_by_role("button", name="添加来源", exact=True).click()
        page.get_by_label("来源 1 标题", exact=True).fill("Acceptance source document")
        page.get_by_label("来源 1 链接", exact=True).fill("https://example.org/acceptance-source")
        page.get_by_label("来源 1 引文", exact=True).fill("Preserved source excerpt for acceptance.")
        page.get_by_role("button", name="保存证据", exact=True).click()
        page.wait_for_url("**/evidence/*")
        expect(page.get_by_role("heading", name=CARD_TITLE, exact=True)).to_be_visible()
        card_id = page.url.split("/evidence/")[1]
        card_path = zone_path + "/evidence/" + card_id
        api(reader, "GET", card_path, status=404)
        page.reload()
        expect(page.get_by_text(BODY, exact=True)).to_be_visible()
        passed("draft evidence survives reload and remains private")
        page.get_by_role("button", name="发布证据", exact=True).click()
        expect(page.get_by_role("button", name="撤回证据", exact=True)).to_be_visible()
        api(reader, "GET", card_path, status=404)
        passed("published card remains hidden while parent zone is draft")
        ready(page, "/app" + zone_path)
        page.get_by_role("button", name="发布专区", exact=True).click()
        expect(page.get_by_role("button", name="撤回专区", exact=True)).to_be_visible()
        ready(other, "/app" + card_path)
        expect(other.get_by_role("heading", name=CARD_TITLE, exact=True)).to_be_visible()
        expect(other.get_by_role("button", name="编辑证据", exact=True)).to_have_count(0)
        expect(other.get_by_role("combobox", name="学术评议评分", exact=True)).to_have_value("")
        expect(other.get_by_role("button", name="发布评议", exact=True)).to_be_disabled()
        passed("public reading preserves attribution and no preselected peer score")
        other.get_by_role("combobox", name="学术评议评分", exact=True).select_option("4")
        other.get_by_label("评议意见", exact=True).fill("Acceptance review: sources remain inspectable.")
        other.get_by_role("button", name="发布评议", exact=True).click()
        expect(other.get_by_text("Acceptance review: sources remain inspectable.", exact=True)).to_be_visible()
        other.get_by_label("参与讨论", exact=True).fill("Acceptance discussion to be removed.")
        other.get_by_role("button", name="发布讨论", exact=True).click()
        expect(other.get_by_text("Acceptance discussion to be removed.", exact=True)).to_be_visible()
        other.get_by_role("button", name="删除我的讨论", exact=True).click()
        expect(other.get_by_text("Acceptance discussion to be removed.", exact=True)).to_have_count(0)
        other.get_by_label("参与讨论", exact=True).fill("这条证据的来源与适用范围可以继续讨论。（验收示例）")
        other.get_by_role("button", name="发布讨论", exact=True).click()
        expect(other.get_by_text("这条证据的来源与适用范围可以继续讨论。（验收示例）", exact=True)).to_be_visible()
        passed("peer review and real discussion create/delete work")
        ready(page, "/app" + card_path)
        expect(page.get_by_role("combobox", name="学术评议评分", exact=True)).to_have_count(0)
        page.get_by_role("button", name="编辑证据", exact=True).click()
        page.get_by_label("证据正文", exact=True).fill(BODY + " Updated revision.")
        expect(page.get_by_role("button", name="编辑证据", exact=True)).to_be_disabled()
        page.get_by_role("button", name="保存证据", exact=True).click()
        expect(page.get_by_role("button", name="编辑证据", exact=True)).to_be_enabled()
        other.reload()
        expect(other.get_by_text("历史版本", exact=False)).to_be_visible()
        passed("author cannot self-review and old review is revision-labeled")
        ready(other, "/app" + zone_path)
        other.get_by_role("button", name="关注", exact=True).click()
        expect(other.get_by_role("button", name="取消关注", exact=True)).to_be_visible()
        other.get_by_role("button", name="给专区提建议", exact=True).click()
        other.get_by_label("专区建议", exact=True).fill("请补充不同适用人群的证据。（验收示例）")
        other.get_by_role("button", name="提交建议", exact=True).click()
        expect(other.get_by_text("建议已提交", exact=True)).to_be_visible()
        ready(page, "/app" + zone_path)
        expect(page.get_by_text("请补充不同适用人群的证据。（验收示例）", exact=True)).to_be_visible()
        ready(other, "/app/frontier?view=following")
        expect(other.get_by_role("link", name=ZONE_TITLE, exact=True)).to_be_visible()
        expect(other.get_by_role("link", name=CARD_TITLE, exact=True)).to_be_visible()
        passed("zone follow updates and owner-only suggestions are connected")
        ready(other, "/app" + card_path)
        submitted_runs = []
        other.on("request", lambda request: submitted_runs.append(request.url) if request.method == "POST" and ("/runs" in request.url or "/prompt" in request.url) else None)
        with other.expect_response(lambda response: response.url.endswith("/research")) as research_response:
            other.get_by_role("button", name="问这条证据", exact=True).click()
        draft = research_response.value.json()["data"]["draft"]
        assert BODY in draft and "https://example.org/acceptance-source" in draft
        other.wait_for_url("**/app/chat")
        intent = other.evaluate("history.state.usr.runtimeUiIntent")
        assert intent["kind"] == "create" and intent["draft"] == draft
        assert not submitted_runs, submitted_runs
        passed("research passes authorized content as a draft to the existing chat-frame contract without submitting")
        ready(page, "/app" + zone_path)
        page.get_by_role("button", name="撤回专区", exact=True).click()
        expect(page.get_by_role("button", name="发布专区", exact=True)).to_be_visible()
        api(reader, "GET", card_path, status=404)
        page.get_by_role("button", name="发布专区", exact=True).click()
        expect(page.get_by_role("button", name="撤回专区", exact=True)).to_be_visible()
        passed("withdrawing and republishing parent controls public visibility")
        ready(page, "/app/frontier")
        page.get_by_role("button", name="更多操作", exact=True).first.click()
        page.get_by_role("menuitem", name="整理为证据卡片", exact=True).click()
        expect(page.get_by_text("选择证据专区", exact=True)).to_be_visible()
        page.get_by_role("link", name=ZONE_TITLE, exact=True).click()
        expect(page.get_by_label("证据标题", exact=True)).to_have_value("Acceptance reading item 1")
        page.get_by_role("button", name="保存证据", exact=True).click()
        page.wait_for_url("**/evidence/*")
        expect(page.get_by_role("link", name="回到相关动态", exact=True)).to_be_visible()
        page.get_by_role("link", name="回到相关动态", exact=True).click()
        page.wait_for_url("**/frontier?item=*")
        expect(page.locator("[data-frontier-item]").first.get_by_role("link", name="Acceptance reading item 1", exact=True)).to_be_visible()
        passed("news converts into an owned draft and retains an original-item backlink")
        # Search is server-side over the corpus, including records beyond the first page.
        for index in range(21):
            zone = api(owner, "POST", "/frontier/zones", {"title": f"Pagination fixture {index:02d}",
                       "description": "Isolated acceptance", "requestId": str(uuid.uuid4())})["zone"]
            api(owner, "PATCH", "/frontier/zones/" + zone["id"], {"expectedRevision": zone["revision"], "state": "published"})
        ready(other, "/app/frontier/zones")
        expect(other.get_by_text("22 个匹配专区", exact=True)).to_be_visible()
        other.get_by_label("搜索证据专区", exact=True).fill("Pagination fixture 00")
        other.get_by_role("button", name="搜索", exact=True).click()
        expect(other.get_by_text("1 个匹配专区", exact=True)).to_be_visible()
        expect(other.get_by_role("link", name="Pagination fixture 00", exact=True)).to_be_visible()
        other.get_by_label("搜索证据专区", exact=True).fill("")
        other.get_by_role("button", name="搜索", exact=True).click()
        other.get_by_role("button", name="加载更多", exact=True).click()
        expect(other.get_by_role("link", name=ZONE_TITLE, exact=True)).to_be_visible()
        expect(other.get_by_role("button", name="加载更多", exact=True)).to_have_count(0)
        passed("directory counts and pagination search the complete corpus")
        # Rejected request retains recoverable error; retry returns the actual native list.
        other.route("**/api/frontier/zones", lambda route: route.fulfill(status=503, json={"error":"Unavailable","code":"temporary_unavailable"}), times=1)
        ready(other, "/app/frontier/zones")
        other.get_by_role("button", name="重试", exact=True).click()
        expect(other.get_by_text("22 个匹配专区", exact=True)).to_be_visible()
        passed("directory failure exposes a working retry")
        # Layout uses the built bundle, with actual HTTP responses; no fake browser payloads.
        for width in [320, 390, 768, 1440]:
            page.set_viewport_size({"width": width, "height": 1000})
            for label, route in [("feed", "/app/frontier"), ("zone", "/app" + zone_path), ("reading", "/app" + card_path)]:
                ready(page, route)
                page.wait_for_timeout(250)
                overflow = page.evaluate("document.documentElement.scrollWidth > innerWidth")
                assert not overflow, (width, label, "horizontal page overflow")
                page.screenshot(path=str(CAPTURES / f"implementation-{label}-{width}.png"))
            passed("responsive real pages", width=width, surfaces=3)
        page.set_viewport_size({"width": 390, "height": 1000})
        page.emulate_media(color_scheme="dark")
        for label, route in [("zone", "/app" + zone_path), ("reading", "/app" + card_path)]:
            ready(page, route)
            page.wait_for_function("document.documentElement.dataset.theme === 'dark'")
            page.wait_for_timeout(250)
            page.screenshot(path=str(CAPTURES / f"implementation-{label}-dark.png"))
        passed("native evidence pages follow the system dark theme")
        assert not ERRORS, ERRORS
        passed("no browser JavaScript exceptions")
        COMPLETED = True
        (ROOT / "research" / "browser-identities.json").write_text(json.dumps({"zoneId": zone_id, "cardId": card_id}))
    finally:
        (ROOT / "research" / "implementation-browser.json").write_text(json.dumps({
            "mode": "actual compiled app + actual HTTP + isolated PostgreSQL",
            "complete": COMPLETED, "checks": RESULTS, "exceptions": ERRORS,
            "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        }, indent=2, ensure_ascii=False))
        browser.close()
