#!/usr/bin/env python3
"""Parse one mp.weixin.qq.com article page into the frontier feed's normalised entry.

Pure functions, stdlib only: page HTML in, dict out. No network, no language judgement: every rule below reads a
structured field the page itself carries (its embedded data object, the `var` assignments of the older template,
the #js_content markup) or matches a closed vocabulary (WeChat's own UI strings, identifier formats, the registry's
journal names). Deciding whether an article is news, promotion or a repost the model is asked about stays with the
model (plan 10.3.5); what is decided here is only what the page states about itself.

Usage as a script: wechat_article.py page.html [more.html ...]   -> one JSON object per page on stdout.
"""
import hashlib, html, json, re, sys
from datetime import datetime, timezone

# item_show_type as WeChat uses it: which kind of post this is. 0 is an ordinary article.
SHOW_TYPES = {0: "article", 5: "video", 7: "audio", 8: "image-post", 10: "text-post", 11: "repost-card"}
# The page's own status notices (closed vocabulary: WeChat UI strings, not prose).
STATUS_MARKERS = [
    ("deleted", "该内容已被发布者删除"),
    ("violation", "此内容因违规无法查看"),
    ("violation", "此内容被投诉且经审核涉嫌侵权"),
    ("violation", "该公众号已被屏蔽"),
    ("migrated", "该公众号已迁移"),
    ("expired", "链接已过期"),
    ("captcha", "wappoc_appmsgcaptcha"),
    ("captcha", "环境异常"),
]
# WeChat interface strings that end up inside the extracted text (closed list; they are the reader app's chrome).
UI_STRINGS = [
    "预览时标签不可点", "微信扫一扫关注该公众号", "微信扫一扫", "关注该公众号", "继续滑动看下一个", "向上滑动看下一个",
    "轻触阅读原文", "阅读原文", "知道了", "取消 允许", "在小说阅读器中沉浸阅读", "喜欢此内容的人还喜欢", "视频 小程序 赞",
    "，轻点两下取消赞", "，轻点两下取消在看", "分享 留言 收藏", "听过", "赞 在看 分享", "写留言", "留言",
]
DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"'<>，。；、）)]+", re.I)
PMID = re.compile(r"\bPMID[:：\s]*(\d{6,9})\b", re.I)
NCT = re.compile(r"\bNCT\d{8}\b")
CHICTR = re.compile(r"\bChiCTR[-\w]*\d{6,}\b", re.I)


def _js_value(page, key):
    """The value of `key` in the page's embedded data (window.cgiDataNew, 2024+ template) or its older `var` form."""
    patterns = [
        r"[\s,{]" + key + r"\s*:\s*'((?:[^'\\]|\\.)*)'(?:\s*\*\s*1)?",   # cgiDataNew: key: '...'
        r"[\s,{]" + key + r'\s*:\s*"((?:[^"\\]|\\.)*)"',                 # key: "..."
        r"var\s+" + key + r"\s*=\s*htmlDecode\(\s*\"((?:[^\"\\]|\\.)*)\"",  # var key = htmlDecode("...")
        r"var\s+" + key + r"\s*=\s*\"((?:[^\"\\]|\\.)*)\"",                # var key = "..."
        r"var\s+" + key + r"\s*=\s*'((?:[^'\\]|\\.)*)'",
    ]
    for pattern in patterns:
        m = re.search(pattern, page)
        if m and m.group(1) not in ("", "0"):
            return _unescape_js(m.group(1))
    return None


def _unescape_js(s):
    s = re.sub(r"\\x([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), s)
    s = s.replace("\\/", "/").replace('\\"', '"').replace("\\'", "'")
    for _ in range(3):  # links arrive as &amp;amp;amp; after repeated escaping
        s = html.unescape(s)
    return s


def _digits(page, key):
    m = re.search(r"(?:var\s+" + key + r"\s*=|[\s,{]" + key + r"\s*:)\s*[\"']?(\d{1,12})[\"']?", page)
    return m.group(1) if m else None


def _hex(page, key):
    m = re.search(r"(?:var\s+" + key + r"\s*=|[\s,{]" + key + r"\s*:)\s*[\"']([0-9a-f]{32})[\"']", page)
    return m.group(1) if m else None


def _int(value):
    try:
        return int(str(value).strip().split()[0].strip("'\""))
    except (TypeError, ValueError, IndexError):
        return None


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z") if ts else None


def _link_parts(link):
    q = dict(re.findall(r"[?&](__biz|mid|idx|sn|chksm)=([^&#]+)", link or ""))
    return q.get("__biz"), q.get("mid"), q.get("idx"), q.get("sn"), q.get("chksm")


def _content_html(page):
    m = re.search(r'<div[^>]+id="js_content"[^>]*>(.*?)</div>\s*(?:<script|<div[^>]+id="js_(?:tags|pc_qr_code|bottom_ad_area|toobar3))', page, re.S)
    if m:
        return m.group(1)
    m = re.search(r"content_noencode\s*:\s*'((?:[^'\\]|\\.)*)'", page)  # image/text posts carry their body here
    return _unescape_js(m.group(1)) if m else ""


def _text(fragment):
    fragment = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", fragment)
    fragment = re.sub(r"(?i)<br\s*/?>|</(p|section|h[1-6]|li|blockquote)>", "\n", fragment)
    text = html.unescape(re.sub(r"<[^>]+>", "", fragment))
    lines = [re.sub(r"[ \t 　]+", " ", line).strip() for line in text.splitlines()]
    out = []
    for line in lines:
        if not line or line in UI_STRINGS:
            continue
        out.append(line)
    return "\n".join(out)


def page_status(page, http_status=200):
    if http_status in (301, 302) or not page:
        return "redirect"
    for status, marker in STATUS_MARKERS:
        if marker in page:
            if status == "captcha" or "js_content" not in page:
                return status
    return "ok" if ("js_content" in page or "content_noencode" in page) else "unknown"


def parse_article(page, url=None, http_status=200, journals=()):
    status = page_status(page, http_status)
    record = {"status": status, "url_requested": url}
    if status != "ok":
        return record
    link = _js_value(page, "link") or _js_value(page, "msg_link") or url or ""
    biz, mid, idx, sn, chksm = _link_parts(link)
    biz = biz or _js_value(page, "biz")
    mid = mid if (mid or "").isdigit() else _digits(page, "mid")
    idx = idx if (idx or "").isdigit() else (_digits(page, "idx") or "1")
    sn = sn or _hex(page, "sn")
    ct = _int(_js_value(page, "ori_create_time")) or _int(_js_value(page, "ct")) or _int(_js_value(page, "create_time"))
    gh = None
    for m in re.finditer(r"user_name\s*[:=]\s*['\"](gh_[0-9a-f]{12})['\"]", page):
        gh = m.group(1)
        break
    show = _int(_js_value(page, "item_show_type")) or 0
    body_html = _content_html(page)
    text = _text(body_html)
    images = len(re.findall(r"<img[^>]+data-src=", body_html))
    videos = len(re.findall(r"(?:mpvideo|iframe[^>]+video|data-mpvid)", body_html))
    out_links = sorted(set(re.findall(r'href="(https?://[^"]+)"', html.unescape(body_html))))
    mp_links = [l for l in out_links if "mp.weixin.qq.com/s" in l]
    joined = text + " " + " ".join(out_links)
    copyright_stat = _int(_js_value(page, "copyright_stat"))
    source_url = _js_value(page, "source_url") or _js_value(page, "msg_source_url")
    record.update({
        "biz": biz, "mid": mid, "idx": idx, "sn": sn, "chksm": chksm, "gh_id": gh,
        "external_key": f"{biz}:{mid}:{idx}" if biz and mid else None,
        "canonical_url": f"https://mp.weixin.qq.com/s?__biz={biz}&mid={mid}&idx={idx}&sn={sn}&chksm={chksm}" if biz and mid and sn and chksm else None,
        "account": _js_value(page, "nick_name") or _js_value(page, "nickname"),
        "title": _js_value(page, "title") or _js_value(page, "msg_title"),
        "digest": _js_value(page, "desc") or _js_value(page, "msg_desc"),
        "author": _js_value(page, "author"),
        "cover": _js_value(page, "cdn_url") or _js_value(page, "msg_cdn_url"),
        "published_at": _iso(ct), "date_precision": "instant" if ct else "inferred",
        "show_type": SHOW_TYPES.get(show, f"type-{show}"),
        "original": copyright_stat == 1 if copyright_stat is not None else None,
        "source_url": source_url,
        "ip_region": (re.search(r"province_name\s*:\s*'([^']+)'", page) or [None, None])[1],
        "text_chars": len(text), "images": images, "videos": videos,
        "links_out": len(out_links), "mp_links": len(mp_links),
        "refs": {
            "doi": sorted({d.rstrip(".").lower() for d in DOI.findall(joined)})[:20],
            "pmid": sorted(set(PMID.findall(joined)))[:20],
            "nct": sorted(set(NCT.findall(joined)))[:20],
            "chictr": sorted({c.upper() for c in CHICTR.findall(joined)})[:20],
            "journals": sorted({j for j in journals if j and j in text})[:10],
        },
        "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "text_head": text[:300],
        "_text": text,
        "_mp_links": mp_links[:60],
        "_album_ids": sorted(set(re.findall(r"album_id=(\d{8,})", html.unescape(page))))[:10],
    })
    return record


if __name__ == "__main__":
    for path in sys.argv[1:]:
        rec = parse_article(open(path, encoding="utf-8", errors="replace").read(), url=path)
        rec.pop("_text", None)
        print(json.dumps(rec, ensure_ascii=False))
