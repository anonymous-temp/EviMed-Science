#!/usr/bin/env python3
"""WeChat official-account trial: acquire and structure articles from ~100 accounts (plan chapter 11).

Stdlib + curl. Resumable: every page fetched is cached gzip-compressed under the state directory and never fetched
twice; every phase can be re-run. Nothing is written into the repository except the final report JSON.

  wechat_trial.py seed    <accounts.jsonl>   fetch each account's seed article (a real URL found for it), parse, structure
  wechat_trial.py expand                     album pages (public JSON) and same-account links found in fetched pages
  wechat_trial.py fetch   [--per-account N]  fetch up to N newest not-yet-fetched candidates per account
  wechat_trial.py sogou   [--max N]          login-free discovery via Sogou article search (no time filter without login)
  wechat_trial.py list    <accounts.jsonl>   logged-in 公众号-backend listing (needs a session file; see `login`)
  wechat_trial.py w2r-subscribe <accounts>   subscribe the accounts in a Wechat2RSS instance (W2R_BASE, W2R_TOKEN_FILE)
  wechat_trial.py w2r-collect <accounts>     read every subscribed feed, structure items, fetch recent article pages
  wechat_trial.py w2r-health                 WeChat identities in the instance: available / in risk control
  wechat_trial.py weread-login               QR login to 微信读书 (a person scans with a WeChat account; cookies 0600)
  wechat_trial.py weread-run <accounts.jsonl> list each account through 微信读书 and fetch its last-7-day articles
  wechat_trial.py login                      QR login to the 公众号 backend (closed for listing since 2026-07-30) (a person must scan); session kept in the
                                             state directory with mode 0600 and never copied anywhere else
  wechat_trial.py report  <out.json>         statistics over everything structured so far

Pacing: mp.weixin.qq.com one request every 3-5 s with jitter; three verification pages in a row pause the run for
ten minutes. The backend listing waits 20-30 s between calls and stops on error 200013 (frequency control).
"""
import base64, gzip, hashlib, http.cookiejar, json, os, random, re, statistics, subprocess, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wechat_article import parse_article  # noqa: E402

STATE = os.environ.get("WX_STATE", "/tmp/medhot3/wx")
RAW = os.path.join(STATE, "raw")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
JOURNALS = ["NEJM", "新英格兰医学杂志", "Lancet", "柳叶刀", "JAMA", "BMJ", "Nature Medicine", "Nature", "Science", "Cell",
            "Annals of Internal Medicine", "Circulation", "JCO", "Journal of Clinical Oncology", "Gut", "Diabetes Care",
            "European Heart Journal", "Cochrane", "中华医学杂志", "中华内科杂志", "中国循证医学杂志", "中国全科医学"]
os.makedirs(RAW, exist_ok=True)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def jl_read(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def jl_append(path, row):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


_last = [0.0]
_captcha_run = [0]


def pace(low=3.0, high=5.0):
    wait = _last[0] + random.uniform(low, high) - time.time()
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()


def curl(url, *extra, timeout=30):
    """(http_status, body_bytes, transfer_bytes, seconds). Body decoded (--compressed)."""
    pace()
    started = time.time()
    proc = subprocess.run(["curl", "-sS", "-g", "--compressed", "-m", str(timeout), "-A", UA, "-H", "Accept-Language: zh-CN,zh;q=0.9",
                           "-o", "-", "-w", "\n__META__%{http_code} %{size_download}", *extra, url], capture_output=True)
    out = proc.stdout
    cut = out.rfind(b"\n__META__")
    body, meta = (out[:cut], out[cut + 9:].decode().split()) if cut >= 0 else (out, ["0", "0"])
    return int(meta[0] or 0), body, int(meta[1] or 0), round(time.time() - started, 2)


def cache_key(url):
    return hashlib.sha256(url.encode()).hexdigest()[:24]


def fetch_article(url, account_id, journals=JOURNALS):
    """Fetch (or read from cache) one article page and return its structured record."""
    path = os.path.join(RAW, cache_key(url) + ".html.gz")
    meta_path = path + ".meta.json"
    if os.path.exists(path) and os.path.exists(meta_path):
        meta = json.load(open(meta_path))
        page = gzip.open(path, "rt", encoding="utf-8", errors="replace").read()
    else:
        status, body, transfer, seconds = curl(url)
        page = body.decode("utf-8", errors="replace")
        meta = {"url": url, "http": status, "transfer_bytes": transfer, "body_bytes": len(body), "seconds": seconds, "fetched_at": now()}
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            handle.write(page)
        json.dump(meta, open(meta_path, "w"))
    rec = parse_article(page, url=url, http_status=meta["http"], journals=journals)
    rec.update({"account_id": account_id, "http": meta["http"], "transfer_bytes": meta["transfer_bytes"], "fetched_at": meta["fetched_at"]})
    if rec["status"] == "captcha":
        _captcha_run[0] += 1
        if _captcha_run[0] >= 3:
            print("three verification pages in a row: pausing 10 minutes", flush=True)
            time.sleep(600)
            _captcha_run[0] = 0
    else:
        _captcha_run[0] = 0
    return rec


def complete_link(url):
    """Links without chksm are sent to a verification page (measured 2026-09-21); only complete ones are fetched."""
    u = urllib.parse.unquote(url.replace("\\x26", "&").replace("&amp;", "&"))
    if "/s/" in u:  # short share form /s/<id>
        return u.split("#")[0]
    q = dict(re.findall(r"[?&](__biz|mid|idx|sn|chksm)=([^&#]+)", u))
    if all(k in q for k in ("__biz", "mid", "idx", "sn", "chksm")):
        return "https://mp.weixin.qq.com/s?" + "&".join(f"{k}={q[k]}" for k in ("__biz", "mid", "idx", "sn", "chksm"))
    return None


def structured_path():
    return os.path.join(STATE, "structured.jsonl")


def seen_urls():
    return {r["url_requested"] for r in jl_read(structured_path())}


def cmd_seed(accounts_path):
    accounts = jl_read(accounts_path)
    json.dump(accounts, open(os.path.join(STATE, "accounts.json"), "w"), ensure_ascii=False)
    done = seen_urls()
    for a in accounts:
        url = a.get("article_url")
        link = complete_link(url) if url else None
        if not link or link in done:
            continue
        rec = fetch_article(link, a["id"])
        rec["via"] = "seed"
        jl_append(structured_path(), rec)
        print(a["id"], rec["status"], (rec.get("account") or "")[:12], (rec.get("title") or "")[:30], rec.get("published_at"), flush=True)


def album_items(biz, album_id):
    url = f"https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz={urllib.parse.quote(biz)}&album_id={album_id}&count=10&f=json"
    path = os.path.join(RAW, "album-" + cache_key(url) + ".json")
    if os.path.exists(path):
        return json.load(open(path))
    status, body, _, _ = curl(url)
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except ValueError:
        data = {"_http": status, "_raw": body[:300].decode("utf-8", errors="replace")}
    json.dump(data, open(path, "w"), ensure_ascii=False)
    return data


def cmd_expand():
    rows = [r for r in jl_read(structured_path()) if r["status"] == "ok"]
    cands = {}
    for r in rows:
        acc, biz = r["account_id"], r.get("biz")
        for link in r.get("_mp_links", []):
            full = complete_link(link)
            if full and biz and f"__biz={biz}" in full:
                cands.setdefault(acc, {}).setdefault(full, {"via": "same-account-link", "ct": None})
        for album_id in r.get("_album_ids", []):
            data = album_items(biz, album_id)
            lst = ((data.get("getalbum_resp") or {}).get("article_list")) or []
            if isinstance(lst, dict):
                lst = [lst]
            for it in lst:
                full = complete_link(it.get("url", ""))
                if full:
                    cands.setdefault(acc, {})[full] = {"via": "album", "ct": int(it.get("create_time") or 0) or None}
    json.dump(cands, open(os.path.join(STATE, "candidates.json"), "w"), ensure_ascii=False)
    print("accounts with candidates:", len(cands), "candidates:", sum(len(v) for v in cands.values()))


def cmd_fetch(per_account):
    cands = json.load(open(os.path.join(STATE, "candidates.json")))
    done = seen_urls()
    for acc, links in cands.items():
        todo = [(u, m) for u, m in links.items() if u not in done]
        todo.sort(key=lambda x: -(x[1].get("ct") or 0))  # album items carry a time; same-account links are older posts
        for url, m in todo[:per_account]:
            rec = fetch_article(url, acc)
            rec["via"] = m["via"]
            jl_append(structured_path(), rec)
            print(acc, rec["status"], m["via"], (rec.get("title") or "")[:30], rec.get("published_at"), flush=True)


# ---------------- login-free discovery through Sogou's article search (residential networks only) ----------------

SOGOU_JAR = os.path.join(STATE, "sogou-cookies.txt")


def sogou_get(url, referer):
    """Sogou is slow-paced on purpose: 25-40 s between requests; an anti-spider page stops the phase."""
    time.sleep(random.uniform(25, 40))
    status, body, _, _ = curl(url, "-c", SOGOU_JAR, "-b", SOGOU_JAR, "-e", referer)
    text = body.decode("utf-8", errors="replace")
    blocked = status in (302, 403) and "antispider" in text or "/antispider/" in text or "seccodeImage" in text
    return status, text, blocked


def cmd_sogou(max_accounts, seed_any=False, accounts_path=None, out_name="sogou.jsonl"):
    accounts = jl_read(accounts_path) if accounts_path else json.load(open(os.path.join(STATE, "accounts.json")))
    out = os.path.join(STATE, out_name)
    done = {r["account_id"] for r in jl_read(out)}
    home = "https://weixin.sogou.com/"
    tried = 0
    for a in accounts:
        if a["id"] in done:
            continue
        if tried >= max_accounts:
            break
        tried += 1
        q = urllib.parse.quote(a["name"])
        url = f"https://weixin.sogou.com/weixin?type=2&query={q}&ie=utf8"
        status, page, blocked = sogou_get(url, home)
        if blocked:
            jl_append(out, {"account_id": a["id"], "blocked": True, "at": now()})
            print("anti-spider page after", tried, "accounts; stopping", flush=True)
            return
        rows = []
        for blk in re.findall(r'<li id="sogou_vr_11002601_box_\d+".*?</li>', page, flags=re.S):
            link = re.search(r'<h3>\s*<a[^>]*href="([^"]+)"', blk, flags=re.S)
            name = re.search(r'<span class="all-time-y2">(.*?)</span>', blk, flags=re.S)
            ts = re.search(r"timeConvert\('(\d+)'\)", blk)
            title = re.search(r"<h3>\s*<a[^>]*>(.*?)</a>", blk, flags=re.S)
            rows.append({"account": re.sub(r"<[^>]+>", "", name.group(1)).strip() if name else None,
                         "ts": int(ts.group(1)) if ts else None,
                         "title": re.sub(r"<[^>]+>", "", title.group(1)).strip() if title else None,
                         "link": link.group(1).replace("&amp;", "&") if link else None})
        mine = [r for r in rows if r["account"] == a["name"]]
        recent = [r for r in mine if r["ts"] and time.time() - r["ts"] <= 7 * 86400]
        resolved = []
        # resolve at most the two newest recent ones; an account with no known biz also gets its newest post of any age,
        # because one real page of the account is enough to learn its biz (the key every listing route needs)
        pick = sorted(recent, key=lambda x: -x["ts"])[:2]
        if not pick and seed_any and not a.get("biz") and mine:
            pick = sorted([r for r in mine if r["ts"]], key=lambda x: -x["ts"])[:1]
        for r in pick:
            k = random.randint(1, 100)
            i = r["link"].find("url=")
            h = r["link"][i + 4 + 21 + k] if i >= 0 and len(r["link"]) > i + 25 + k else ""
            st, js, blocked = sogou_get(f"https://weixin.sogou.com{r['link']}&k={k}&h={h}", url)
            if blocked:
                break
            temp = "".join(re.findall(r"url \+= '([^']*)'", js)).replace("@", "")
            if temp.startswith("https://mp.weixin.qq.com/"):
                rec = fetch_article(temp, a["id"])
                rec["via"] = "sogou"
                jl_append(structured_path(), rec)
                resolved.append({"title": r["title"], "status": rec["status"], "published_at": rec.get("published_at")})
        jl_append(out, {"account_id": a["id"], "http": status, "results": len(rows), "by_account": len(mine), "within_7d": len(recent),
                        "newest_ts": max([r["ts"] for r in mine if r["ts"]], default=None), "resolved": resolved, "at": now()})
        print(a["id"], a["name"], "results", len(rows), "mine", len(mine), "7d", len(recent), "resolved", len(resolved), flush=True)


# ---------------- logged-in 公众号 backend (optional; needs a person to scan) ----------------

SESSION = os.path.join(STATE, "mp-session.json")


def _opener(jar):
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def _req(opener, url, data=None, referer="https://mp.weixin.qq.com/"):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None,
                                 headers={"User-Agent": UA, "Referer": referer, "Accept-Language": "zh-CN,zh;q=0.9"})
    with opener.open(req, timeout=30) as resp:
        return resp.read()


def cmd_login():
    jar = http.cookiejar.MozillaCookieJar(os.path.join(STATE, "mp-cookies.txt"))
    op = _opener(jar)
    session_id = str(int(time.time() * 1000)) + str(random.randint(10, 99))
    _req(op, "https://mp.weixin.qq.com/cgi-bin/bizlogin?action=startlogin",
         {"userlang": "zh_CN", "redirect_url": "", "login_type": "3", "sessionid": session_id, "token": "", "lang": "zh_CN", "f": "json", "ajax": "1"})
    png = _req(op, f"https://mp.weixin.qq.com/cgi-bin/scanloginqrcode?action=getqrcode&random={int(time.time() * 1000)}")
    qr_path = os.path.join(STATE, "mp-login-qr.png")
    open(qr_path, "wb").write(png)
    print("QR written to", qr_path, "- scan it with a WeChat account that administers any 公众号", flush=True)
    for _ in range(150):  # about five minutes
        time.sleep(2)
        ask = json.loads(_req(op, "https://mp.weixin.qq.com/cgi-bin/scanloginqrcode?action=ask&token=&lang=zh_CN&f=json&ajax=1"))
        status = ask.get("status")
        if status == 1:
            break
        if status in (2, 3):
            print("QR expired; run login again", flush=True)
            return
    else:
        print("not scanned in time", flush=True)
        return
    res = json.loads(_req(op, "https://mp.weixin.qq.com/cgi-bin/bizlogin?action=login",
                          {"userlang": "zh_CN", "redirect_url": "", "cookie_forbidden": "0", "cookie_cleaned": "0", "plugin_used": "0",
                           "login_type": "3", "token": "", "lang": "zh_CN", "f": "json", "ajax": "1"}))
    token = (re.search(r"token=(\d+)", res.get("redirect_url", "")) or [None, None])[1]
    if not token:
        print("login did not return a token:", res.get("base_resp"), flush=True)
        return
    jar.save(ignore_discard=True, ignore_expires=True)
    os.chmod(jar.filename, 0o600)
    with open(SESSION, "w") as handle:
        json.dump({"token": token, "logged_in_at": now()}, handle)
    os.chmod(SESSION, 0o600)
    os.remove(qr_path)
    print("logged in; session kept in the state directory (mode 0600)", flush=True)


def cmd_list(accounts_path):
    if not os.path.exists(SESSION):
        print("no session: run `login` first (needs a person to scan the QR)")
        return
    token = json.load(open(SESSION))["token"]
    jar = http.cookiejar.MozillaCookieJar(os.path.join(STATE, "mp-cookies.txt"))
    jar.load(ignore_discard=True, ignore_expires=True)
    op = _opener(jar)
    out = os.path.join(STATE, "backend-lists.jsonl")
    done = {r["account_id"] for r in jl_read(out)}
    for a in jl_read(accounts_path):
        if a["id"] in done:
            continue
        fakeid = a.get("biz")
        if not fakeid:
            time.sleep(random.uniform(20, 30))
            q = urllib.parse.urlencode({"action": "search_biz", "begin": 0, "count": 5, "query": a["name"], "token": token, "lang": "zh_CN", "f": "json", "ajax": 1})
            res = json.loads(_req(op, "https://mp.weixin.qq.com/cgi-bin/searchbiz?" + q))
            if (res.get("base_resp") or {}).get("ret") == 200013:
                print("frequency control; stopping", flush=True)
                return
            hit = next((x for x in res.get("list", []) if x.get("nickname") == a["name"]), None)
            fakeid = hit and hit.get("fakeid")
        if not fakeid:
            jl_append(out, {"account_id": a["id"], "error": "not-found"})
            continue
        time.sleep(random.uniform(20, 30))
        q = urllib.parse.urlencode({"sub": "list", "sub_action": "list_ex", "begin": 0, "count": 5, "fakeid": fakeid, "token": token,
                                    "lang": "zh_CN", "f": "json", "ajax": 1})
        res = json.loads(_req(op, "https://mp.weixin.qq.com/cgi-bin/appmsgpublish?" + q))
        ret = (res.get("base_resp") or {}).get("ret")
        if ret == 200013:
            print("frequency control; stopping", flush=True)
            return
        items = []
        page = json.loads(res.get("publish_page") or "{}")
        for pub in page.get("publish_list", []):
            info = json.loads(pub.get("publish_info") or "{}")
            for it in info.get("appmsgex", []):
                items.append({k: it.get(k) for k in ("title", "link", "digest", "create_time", "update_time", "itemidx", "author_name", "cover", "copyright_type", "album_id")})
        jl_append(out, {"account_id": a["id"], "fakeid": fakeid, "ret": ret, "items": items, "listed_at": now()})
        print(a["id"], ret, len(items), flush=True)


# ---------------- logged-in 微信读书 route (the one listing route still open in September 2026) ----------------
# Endpoints as rachelos/we-mp-rss uses them (driver/weread_qr.py, core/wx/model/weread_mp.py, v1.5.3+):
# login  GET /api/auth/getLoginUid -> QR of /web/confirm?uid= -> long-poll GET /api/auth/getLoginInfo?uid=&otp=
#        -> POST /web/login/renewal {"rq":"%2Fweb%2Fbook%2Fread","ql":true} -> verify GET /web/shelf/sync?userVid=&synckey=0
# shelf  POST /web/shelf/add {"bookIds":[...]}; bookId = "MP_WXS_" + base64-decoded biz
# list   GET /web/mp/articles?bookId=&offset=  (reviews[].subReviews[].review.mpInfo), fallback GET /api/mp/cover?bookId=

WEREAD = "https://weread.qq.com"
WR_JAR = os.path.join(STATE, "weread-cookies.txt")
QR_DIR = os.path.join(STATE, "qr")


def _wr_opener(jar):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", UA), ("Accept", "application/json, text/plain, */*"), ("Accept-Language", "zh-CN,zh;q=0.9"),
                     ("Origin", WEREAD), ("Referer", WEREAD + "/")]
    return op


def _wr_json(op, path, params=None, body=None, timeout=30):
    url = WEREAD + path + ("?" + urllib.parse.urlencode(params) if params else "")
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with op.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace") or "{}")


def cmd_weread_login(minutes=5):
    os.makedirs(QR_DIR, exist_ok=True)
    jar = http.cookiejar.MozillaCookieJar(WR_JAR)
    op = _wr_opener(jar)
    uid = _wr_json(op, "/api/auth/getLoginUid").get("uid")
    if not uid:
        print("no login uid returned", flush=True)
        return
    confirm = f"{WEREAD}/web/confirm?uid={uid}"
    png = os.path.join(QR_DIR, "weread-login.png")
    subprocess.run(["/tmp/medhot3/qrvenv/bin/python", "-c",
                    "import qrcode,sys; qrcode.make(sys.argv[1], box_size=10, border=4).save(sys.argv[2])", confirm, png], check=True)
    with open(os.path.join(QR_DIR, "index.html"), "w") as handle:
        handle.write('<!doctype html><meta charset="utf-8"><title>微信读书登录</title><body style="font-family:sans-serif;text-align:center;padding:24px">'
                     '<h2>用一个专用微信号扫码登录微信读书</h2><img src="weread-login.png" style="width:320px"><p>扫码后在手机上点「确认登录」。二维码几分钟内有效。</p></body>')
    print("QR ready:", png, flush=True)
    deadline = time.time() + minutes * 60
    info = {}
    while time.time() < deadline:
        try:
            info = _wr_json(op, "/api/auth/getLoginInfo", {"uid": uid, "otp": ""}, timeout=75)
        except Exception as error:  # long-poll timeouts are normal
            info = {"error": type(error).__name__}
        inner = info.get("data") or {}
        if info.get("succeed") or inner.get("succeed"):
            break
        code = info.get("logicCode")
        if code in ("LOGIN_TIMEOUT",):
            print("QR expired", flush=True)
            return
        time.sleep(1)
    else:
        print("not scanned in time", flush=True)
        return
    inner = info.get("data") or {}
    vid = str(info.get("webLoginVid") or info.get("vid") or info.get("userVid") or inner.get("webLoginVid") or inner.get("vid") or "")
    if vid and not any(c.name == "wr_vid" for c in jar):
        jar.set_cookie(http.cookiejar.Cookie(0, "wr_vid", vid, None, False, "weread.qq.com", True, False, "/", True, False, None, False, None, None, {}))
    try:
        _wr_json(op, "/web/login/renewal", body={"rq": "%2Fweb%2Fbook%2Fread", "ql": True})
    except Exception as error:
        print("renewal failed:", type(error).__name__, flush=True)
    check = _wr_json(op, "/web/shelf/sync", {"userVid": "", "synckey": 0})
    ok = not check.get("errCode")
    jar.save(ignore_discard=True, ignore_expires=True)
    os.chmod(WR_JAR, 0o600)
    os.remove(png)
    print("login", "verified" if ok else f"not verified (errCode {check.get('errCode')})", "- cookies kept in the state directory, mode 0600", flush=True)


def _book_id(biz):
    try:
        return "MP_WXS_" + base64.b64decode(biz + "=" * (-len(biz) % 4)).decode()
    except Exception:
        return None


def _mp_link(original_id):
    token = (original_id or "").split("_")[-1]
    return f"https://mp.weixin.qq.com/s/{urllib.parse.quote(token, safe='~')}" if token else None


def cmd_weread_run(accounts_path, max_fetch=5):
    jar = http.cookiejar.MozillaCookieJar(WR_JAR)
    jar.load(ignore_discard=True, ignore_expires=True)
    op = _wr_opener(jar)
    out = os.path.join(STATE, "weread-lists.jsonl")
    done = {r["account_id"] for r in jl_read(out)}
    shelf = _wr_json(op, "/web/shelf/sync", {"userVid": "", "synckey": 0})
    on_shelf = {b.get("bookId") for b in (shelf.get("books") or [])} | {b.get("bookId") for b in (shelf.get("mpBooks") or [])}
    for a in jl_read(accounts_path):
        if a["id"] in done:
            continue
        book = _book_id(a.get("biz") or "")
        if not book:
            jl_append(out, {"account_id": a["id"], "error": "no-biz"})
            continue
        if book not in on_shelf:
            time.sleep(random.uniform(8, 12))  # adding too fast is what WeRead's risk control punishes (24 h)
            res = _wr_json(op, "/web/shelf/add", body={"bookIds": [book]})
            if res.get("errCode") in (-2012, -2010, -2041):
                print("session rejected while adding to the shelf:", res.get("errCode"), "- stopping", flush=True)
                return
        time.sleep(random.uniform(3, 5))
        items, mode, err = [], "articles", None
        try:
            page = _wr_json(op, "/web/mp/articles", {"bookId": book, "offset": 0})
            if page.get("errCode"):
                raise RuntimeError(str(page.get("errCode")))
            for group in page.get("reviews") or []:
                for sub in group.get("subReviews") or []:
                    review = sub.get("review") or {}
                    mp = review.get("mpInfo") or {}
                    items.append({"reviewId": review.get("reviewId") or sub.get("reviewId"), "title": mp.get("title"),
                                  "link": _mp_link(mp.get("originalId") or review.get("reviewId")), "digest": mp.get("content"),
                                  "create_time": review.get("createTime") or group.get("createTime"), "read_num": mp.get("readNum")})
        except Exception as error:
            err, mode = str(error), "cover"
            try:
                cover = _wr_json(op, "/api/mp/cover", {"bookId": book})
                if cover.get("reviewId"):
                    items.append({"reviewId": cover["reviewId"], "title": cover.get("title"), "link": _mp_link(cover["reviewId"]),
                                  "digest": cover.get("digest"), "create_time": cover.get("time") or cover.get("createTime")})
            except Exception as error2:
                err += f"; cover {type(error2).__name__}"
        jl_append(out, {"account_id": a["id"], "book_id": book, "mode": mode, "error": err, "items": items, "listed_at": now()})
        print(a["id"], a["name"], mode, len(items), err or "", flush=True)
        recent = [i for i in items if i.get("create_time") and time.time() - int(i["create_time"]) <= 7 * 86400 and i.get("link")]
        for it in recent[:max_fetch]:
            rec = fetch_article(it["link"], a["id"])
            rec["via"] = "weread"
            rec["list_title"], rec["list_create_time"] = it.get("title"), it.get("create_time")
            jl_append(structured_path(), rec)


# ---------------- Wechat2RSS (the production listing route, owner decision 2026-09-21) ----------------
# API per https://wechat2rss.xlab.app/deploy/api.html (k = RSS_TOKEN): /login/list, /add/<mp_id>, /addurl?url=,
# /list?page=&size=, feeds /feed/<mp_id>.json|.xml; mp_id = int(base64-decoded biz). Base URL and token come from the
# environment (W2R_BASE, W2R_TOKEN_FILE) and are never printed.

def _w2r():
    base = os.environ.get("W2R_BASE", "http://127.0.0.1:8080").rstrip("/")
    token = open(os.environ["W2R_TOKEN_FILE"]).read().strip()
    return base, token


def _w2r_get(path, params=None, timeout=30):
    base, token = _w2r()
    q = dict(params or {}); q["k"] = token
    req = urllib.request.Request(base + path + "?" + urllib.parse.urlencode(q), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body) if body.lstrip().startswith(("{", "[")) else body


def _mp_id(biz):
    try:
        return str(int(base64.b64decode(biz + "=" * (-len(biz) % 4)).decode()))
    except Exception:
        return None


def cmd_w2r_health():
    res = _w2r_get("/login/list")
    rows = res.get("data") or []
    print(json.dumps({"accounts": len(rows), "available": sum(1 for r in rows if r.get("available")),
                      "in_risk_control": sum(1 for r in rows if r.get("needCheck")),
                      "next_check": [r.get("waitTime") for r in rows if r.get("needCheck")]}, ensure_ascii=False))


def cmd_w2r_subscribe(accounts_path):
    """Subscribe each account once, paced: every add triggers an immediate crawl, which is what risk control counts."""
    out = os.path.join(STATE, "w2r-subscriptions.jsonl")
    done = {r["account_id"] for r in jl_read(out) if not r.get("err")}
    for a in jl_read(accounts_path):
        if a["id"] in done:
            continue
        mp_id = _mp_id(a.get("biz") or "")
        if mp_id:
            res = _w2r_get(f"/add/{mp_id}")
        elif a.get("article_url"):
            res = _w2r_get("/addurl", {"url": a["article_url"]})
        else:
            jl_append(out, {"account_id": a["id"], "err": "no-biz-no-url"})
            continue
        jl_append(out, {"account_id": a["id"], "mp_id": mp_id, "err": (res or {}).get("err") if isinstance(res, dict) else "non-json",
                        "feed": (res or {}).get("data") if isinstance(res, dict) else None, "at": now()})
        print(a["id"], a["name"], (res or {}).get("err") or "ok", flush=True)
        time.sleep(random.uniform(20, 30))


def _feed_items(body):
    """JSON Feed or RSS 2.0 -> [{title, link, published, content_html}]."""
    if isinstance(body, dict):
        return [{"title": it.get("title"), "link": it.get("url") or it.get("id"), "published": it.get("date_published"),
                 "content_html": it.get("content_html") or it.get("content_text") or ""} for it in body.get("items", [])]
    items = []
    for blk in re.findall(r"<item>(.*?)</item>", body or "", flags=re.S):
        def tag(name):
            m = re.search(rf"<{name}[^>]*>(.*?)</{name}>", blk, flags=re.S)
            return re.sub(r"^<!\[CDATA\[|\]\]>$", "", m.group(1).strip()) if m else None
        items.append({"title": tag("title"), "link": tag("link"), "published": tag("pubDate"),
                      "content_html": tag("content:encoded") or tag("description") or ""})
    return items


def cmd_w2r_collect(accounts_path, max_fetch=5):
    """Read every subscribed account's feed; structure feed items; fetch the article page for recent ones (full fields)."""
    accounts = {(_mp_id(a.get("biz") or "") or a["id"]): a for a in jl_read(accounts_path)}
    subs, page = [], 1
    while True:
        res = _w2r_get("/list", {"page": page, "size": 100})
        batch = res.get("data") or []
        subs += batch
        if len(subs) >= (res.get("meta") or {}).get("total", 0) or not batch:
            break
        page += 1
    out = os.path.join(STATE, "w2r-feeds.jsonl")
    for sub in subs:
        feed = _w2r_get(f"/feed/{sub['id']}.json")
        items = _feed_items(feed)
        acc = accounts.get(str(sub["id"])) or {"id": f"w2r-{sub['id']}", "name": sub.get("name")}
        jl_append(out, {"account_id": acc["id"], "mp_id": sub["id"], "name": sub.get("name"), "items": len(items),
                        "newest": max((i.get("published") or "" for i in items), default=None), "at": now()})
        for it in items[:max_fetch]:
            link = complete_link(it.get("link") or "") or it.get("link")
            if not link:
                continue
            rec = fetch_article(link, acc["id"])
            rec["via"] = "wechat2rss"
            rec["feed_title"], rec["feed_published"], rec["feed_content_chars"] = it.get("title"), it.get("published"), len(it.get("content_html") or "")
            jl_append(structured_path(), rec)
        print(acc["id"], sub.get("name"), len(items), flush=True)


# ---------------- report ----------------

def pct(n, d):
    return {"n": n, "of": d, "share": round(n / d, 4) if d else None}


def dist(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return {"n": 0}
    return {"n": len(values), "median": statistics.median(values), "p90": values[int(0.9 * (len(values) - 1))], "max": values[-1]}


def cmd_report(out_path):
    accounts = json.load(open(os.path.join(STATE, "accounts.json")))
    rows = jl_read(structured_path())
    ok = [r for r in rows if r["status"] == "ok"]
    by_acc = {}
    for r in ok:
        by_acc.setdefault(r["account_id"], []).append(r)
    ref_rows = [r for r in ok if any(r["refs"][k] for k in ("doi", "pmid", "nct", "chictr"))]
    today = datetime.now(timezone.utc)
    ages = [(today - datetime.fromisoformat(r["published_at"].replace("Z", "+00:00"))).days for r in ok if r.get("published_at")]
    lanes = {}
    for a in accounts:
        lanes.setdefault(a.get("lane"), {"accounts": 0, "with_article": 0})
        lanes[a.get("lane")]["accounts"] += 1
        if a["id"] in by_acc:
            lanes[a.get("lane")]["with_article"] += 1
    name_match = sum(1 for a in accounts if any((r.get("account") or "") == a.get("name") for r in by_acc.get(a["id"], [])))
    report = {
        "generated_at": now(), "network": "dev box (Taipei ISP line, AS3462)",
        "accounts": len(accounts), "accounts_with_seed_url": sum(1 for a in accounts if a.get("article_url")),
        "accounts_with_biz": sum(1 for a in accounts if a.get("biz") or any(r.get("biz") for r in by_acc.get(a["id"], []))),
        "accounts_with_structured_article": len(by_acc), "accounts_name_matches_page": name_match,
        "fetches": len(rows), "status": {s: sum(1 for r in rows if r["status"] == s) for s in sorted({r["status"] for r in rows})},
        "articles_structured": len(ok), "articles_per_account": dist([len(v) for v in by_acc.values()]),
        "via": {v: sum(1 for r in ok if r.get("via") == v) for v in sorted({r.get("via") for r in ok})},
        "fields_present": {k: pct(sum(1 for r in ok if r.get(k) not in (None, "", [])), len(ok)) for k in
                           ("biz", "mid", "sn", "chksm", "gh_id", "title", "digest", "author", "published_at", "original", "source_url", "ip_region", "cover")},
        "show_types": {s: sum(1 for r in ok if r["show_type"] == s) for s in sorted({r["show_type"] for r in ok})},
        "original_true": pct(sum(1 for r in ok if r.get("original") is True), len(ok)),
        "text_chars": dist([r["text_chars"] for r in ok]), "images": dist([r["images"] for r in ok]),
        "short_text_under_200": pct(sum(1 for r in ok if r["text_chars"] < 200), len(ok)),
        "with_identifier_refs": pct(len(ref_rows), len(ok)),
        "with_journal_mention": pct(sum(1 for r in ok if r["refs"]["journals"]), len(ok)),
        "age_days": dist(ages), "published_within_7d": pct(sum(1 for a in ages if a <= 7), len(ages)),
        "transfer_bytes_per_page": dist([r.get("transfer_bytes") for r in rows]),
        "lanes": lanes,
    }
    lists = jl_read(os.path.join(STATE, "backend-lists.jsonl"))
    if lists:
        report["backend_lists"] = {"accounts_listed": sum(1 for x in lists if x.get("items")), "items": sum(len(x.get("items") or []) for x in lists)}
    json.dump(report, open(out_path, "w"), ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False)[:3000])


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "seed":
        cmd_seed(args[0])
    elif cmd == "expand":
        cmd_expand()
    elif cmd == "fetch":
        cmd_fetch(int(args[args.index("--per-account") + 1]) if "--per-account" in args else 4)
    elif cmd == "sogou":
        cmd_sogou(int(args[args.index("--max") + 1]) if "--max" in args else 100, seed_any="--seed-any" in args,
                  accounts_path=args[args.index("--accounts") + 1] if "--accounts" in args else None,
                  out_name=args[args.index("--out") + 1] if "--out" in args else "sogou.jsonl")
    elif cmd == "w2r-health":
        cmd_w2r_health()
    elif cmd == "w2r-subscribe":
        cmd_w2r_subscribe(args[0])
    elif cmd == "w2r-collect":
        cmd_w2r_collect(args[0])
    elif cmd == "weread-login":
        cmd_weread_login()
    elif cmd == "weread-run":
        cmd_weread_run(args[0])
    elif cmd == "login":
        cmd_login()
    elif cmd == "list":
        cmd_list(args[0])
    elif cmd == "report":
        cmd_report(args[0])
    else:
        sys.exit(__doc__)
