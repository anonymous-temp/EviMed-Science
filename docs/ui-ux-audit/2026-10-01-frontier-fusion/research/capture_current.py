"""Render unchanged main components with explicit local fixtures, never live clinical data."""
import json
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:5181"
WEB = ROOT.parents[2] / "OpenScience/apps/web"

@contextmanager
def temporary_entrypoint():
    """Install only our fixture entrypoints for the duration of the capture.

    Start Vite separately: VITE_OPEN_SCIENCE_API_URL=/api pnpm --filter
    @ai4s/web exec vite --host 127.0.0.1 --port 5181 --strictPort
    """
    targets = [(WEB / f"__frontier_audit__.{ext}", ROOT / "research" / f"current-entry.{ext}")
               for ext in ["html", "tsx"]]
    if any(target.exists() for target, _ in targets):
        raise RuntimeError("A fixture entrypoint already exists; refusing to overwrite it")
    created = []
    try:
        for target, fixture in targets:
            target.write_bytes(fixture.read_bytes())
            created.append(target)
        yield
    finally:
        for target in created:
            target.unlink(missing_ok=True)

STAMP = "2026-10-01T01:00:00.000Z"
items = []
for i, title in enumerate(["示例：一项新研究公布主要终点", "示例：指南发布更新说明", "示例：研究方法与适用范围", "示例：试验长期随访结果", "示例：相关研究的补充材料"]):
    items.append({"id":f"fixture-{i}","title":title,"titleRaw":title,"summary":"这是用于检查界面布局的示例摘要，不表示真实研究结果。查看详情可核对研究设计、适用人群与原始来源。",
      "lane":"evidence","laneLabel":"临床证据","sourceType":"journal","sourceTypeLabel":"期刊",
      "evidenceType":"rct","evidenceTypeLabel":"RCT","source":{"id":"fixture-source","name":"示例期刊"},
      "url":"https://example.org/fixture","publishedAt":STAMP,"timelineAt":STAMP,"visibleAt":STAMP,
      "selected":True,"score":86,"scoreBand":"high","specialties":[{"key":"cardiology","label":"心血管"}],
      "flags":[],"entities":{"drugs":[],"diseases":[],"orgs":[],"trials":[]},"state":{"read":False,"starred":False,"hidden":False},
      "event":{"id":"fixture-event","title":"示例研究进展"},"alsoReportedCount":2,
      "alsoReportedBy":[{"sourceName":"示例期刊 B","url":"https://example.org/fixture-b"}]})
hot = [{"id":f"fixture-event-{i}","title":f"示例热点 {i}：同一事件的多项报道", "rank":i,"sourceCount72h":3,"reportCount":5,
         "heat":46-i*3,"badge":"new","rankChange":"new","lastAt":STAMP,"firstAt":STAMP} for i in range(1,6)]
status = {"enabled":True,"audience":"all","plugin":{"state":"ok","lastPullAt":STAMP},"lastPublishedAt":STAMP,
          "sources":{"enabled":1,"total":1},"versions":{"content":"1","hot":"1"},
          "capabilities":{"hot":True,"daily":True,"forYou":True,"saveToLibrary":True,"abstractZh":False}}
event = {"id":"fixture-event-1","title":"示例研究进展","digest":"用于检查返回位置的示例事件。", "items":[],"sourceCount72h":3,"reportCount":5}

with temporary_entrypoint(), sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = browser.new_page(viewport={"width":1200,"height":900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    def api(route):
        path = urlsplit(route.request.url).path
        query = parse_qs(urlsplit(route.request.url).query)
        if path == '/api/me': data = {"user":{"id":"audit","name":"Audit"},"features":{"frontier":True},"project":{"id":"audit"},"projects":[]}
        elif path.endswith('/status'): data=status
        elif path.endswith('/hot'): data={"events":hot,"takenAt":STAMP,"since":STAMP,"window":"current"}
        elif path.endswith('/follows'): data={"follows":[{"id":"1","kind":"topic","key":"试验","label":"示例主题","muted":False,"createdAt":STAMP}]}
        elif '/events/' in path: data=event
        elif path.endswith('/items'): data={"items":[] if query.get('safety') else items,"nextCursor":None,"version":"1"}
        else: data=[]
        route.fulfill(json={"data":data})
    page.route('**/api/**',api)
    observations=[]
    for name, query, width in [('current-selected','',1200),('current-following','?view=following',1200),('current-mobile','',390)]:
        page.set_viewport_size({"width":width,"height":844 if width==390 else 900})
        page.goto(BASE+'/__frontier_audit__.html'+query)
        page.get_by_role('heading',name='前沿动态',exact=True).wait_for()
        page.wait_for_timeout(700)
        page.screenshot(path=str(ROOT/'captures'/f'{name}.png'))
        details=page.evaluate("""() => ({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
         tabs:[...document.querySelectorAll('[role=tab]')].map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON(),scrollHeight:e.scrollHeight})),
         firstItem:document.querySelector('[data-frontier-item]')?.getBoundingClientRect().toJSON(),
         text:document.body.innerText})""")
        observations.append({"name":name,"dataKind":"local fixture with unchanged main components","details":details})
        print(name,details['scrollWidth'],len(details['tabs']),flush=True)
    (ROOT/'research'/'current-ui.json').write_text(json.dumps({"observations":observations,"errors":errors},ensure_ascii=False,indent=2))
    browser.close()
