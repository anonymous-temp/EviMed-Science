"""WeChat official accounts through Dajiala (contract 1.5.0, channel ``wechat``).

After AIHOT's ``providers/dajiala.ts`` and ``sources/mp.ts`` (MIT, engine at 47531fa), with one rule of our own:

- **A saved id is not trusted.** On 2026-10-22 the id saved for 丁香园 (``gh_1e80bb81a1d2``) answered as a test account
  (「快乐测试123」), and the same id is saved for 雷峰网. So every account is re-resolved before its first read, from the
  link of an article verified to be its own (``config.verified_url``): ``article_detail`` on that link (¥0.03) names the
  account that published it — ``nick_name``, its original id ``user_name``, its WeChat id ``alias`` and ``biz``
  (measured 2026-10-22 on NEJM医学前沿's link). The account is kept only when the nickname is one of the names the
  registry expects (``config.expected_names``: the nickname its verified article page showed, and the name the list
  gave); otherwise it is parked for 30 days with the reason ``wechat_nickname_mismatch`` — a mismatch costs ¥0.03, not
  a read. A resolved account is read by its original id (``post_history``, ¥0.14); an answer without ``user_name`` is
  read by the link instead. The resolution lives in the source's cursor and starts again when the registry row changes.
- **By name when the link cannot say** (ct-src 2026-10-24). 44 of the 68 accounts listed on 2026-10-22 were never read:
  their verified link was a Sogou temporary link (``/s?src=11&timestamp=…&signature=…``, expired before the first
  resolution), and every ``article_detail`` on it answered code 20002. An account whose link is temporary, absent, or
  answers a code that passes (or names a deleted article) is asked for by its name instead: ``post_history`` by
  ``nickname`` (¥0.16) answers the account it found — ``nickname``, ``ghid`` — and its latest posts, whose links carry the
  account's ``__biz``. It is kept only when that nickname is one of ``expected_names`` and, when the registry knows the
  account's ``biz`` (``config.biz``), every post carries it (any other biz is a mismatch, parked for 30 days like a
  nickname mismatch; no post at all leaves it unconfirmed, asked again in three days). The posts of that call are the
  account's first read: nothing is paid twice. The name asked is the first of ``expected_names``.
- **Pace and priority.** At most ``config.polls_per_day`` reads a day (two for the first priority tier, one for the rest),
  due accounts highest priority first, every call within the day's cap — with the balance at about ¥30 on 2026-10-22,
  the regulators, journals and societies are read before the portals and the trade press.
- **Bodies.** A post seen for the first time (and not older than the first-contact window) has its text bought once
  (``article_detail``, ¥0.03, at most eight a read) and arrives with it; a body that fails, or that the cap no longer
  allows, leaves the post readable from its title and digest, and its text is bought later, when the platform asks
  ``/text`` for it (fr-ext 2026-10-22): the text worker hands a WeChat article to ``SocialCollector.wechat_text`` instead
  of the page reader, because mp.weixin.qq.com refuses every page read in its robots.txt — before that, a body lost to a
  provider hiccup was never recovered. A call that fails for a reason that passes is tried again later, at most
  ``BODY_CALLS`` times per entry with a doubling wait (``body_retry_after``); five such failures in a row pause every
  body purchase for an hour (``BODY_STREAK``, ``BODY_PAUSE``), so a key-level problem costs a handful of calls an hour.
- **The text is the article's own markup.** ``article_detail`` answers two texts: ``content`` (mode 1, "light HTML") puts
  every styled run of a paragraph in a ``<p>`` of its own — 「反义寡核苷酸</p><p>（ASO）</p><p>创新药」 — so a stored body
  read as a column of fragments (222 of 256 bodies on 2026-10-22); ``content_multi_text`` is the article's HTML as
  published, one ``<p>`` per paragraph with its runs as ``<span>``s. The body is read from the second, and from the
  first only when the second is missing.
- **Identity.** ``wx:<__biz>:<mid>:<idx>`` from the post's link (contract rule 3); a link without them keys by URL.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from ..adapters.common import clean_markup, registry_ids
from ..model import NormalizedEntry

MAX_BODIES_PER_READ = 8
MISMATCH_PARK = timedelta(days=30)
GONE_RETRY = timedelta(days=3)
FIRST_CONTACT_WINDOW = timedelta(days=7)
BODY_CALLS = 6                          # paid calls per entry's text, at most (entry_texts.paid_attempts)
BODY_RETRY_FIRST = timedelta(minutes=30)
BODY_RETRY_MAX = timedelta(hours=6)
BODY_STREAK = 5                         # body calls failing in a row that pause every body purchase ...
BODY_PAUSE = timedelta(hours=1)         # ... for this long


UNCONFIRMED_RETRY = timedelta(days=3)


def normalize_name(name: str | None) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(name or ""))).lower()


def nickname_matches(nickname: str | None, row: dict) -> bool:
    expected = (row.get("config") or {}).get("expected_names") or [row.get("name")]
    return bool(nickname) and normalize_name(nickname) in {normalize_name(name) for name in expected if name}


def temporary_link(url: str | None) -> bool:
    """A Sogou search result's temporary article link (``/s?src=11&timestamp=…&signature=…``, also ``src=3``): it expires
    within hours and names no account (module docstring). A format check, never a fetch."""
    if not isinstance(url, str):
        return False
    parts = urlsplit(url.strip().replace("&amp;", "&"))
    if parts.hostname != "mp.weixin.qq.com":
        return False
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    return "__biz" not in query and "signature" in query and "timestamp" in query


def resolvable_link(row: dict) -> str | None:
    """The registry's verified article link when it can name the account (a WeChat article link that is not a temporary
    one: the long ``__biz`` form or the short ``/s/<token>`` form), else ``None``."""
    url = (row.get("config") or {}).get("verified_url")
    if not isinstance(url, str) or temporary_link(url):
        return None
    parts = urlsplit(url.strip())
    return url.strip() if parts.hostname == "mp.weixin.qq.com" and parts.path.startswith("/s") else None


def ask_name(row: dict) -> str | None:
    """The nickname an account is asked for by: the first of ``expected_names``, else the row's name."""
    names = [name for name in (row.get("config") or {}).get("expected_names") or [] if isinstance(name, str) and name.strip()]
    name = names[0] if names else row.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else None


def known_biz(row: dict) -> str | None:
    value = (row.get("config") or {}).get("biz")
    return value.strip() if isinstance(value, str) and value.strip() else None


def post_bizes(posts: list[dict]) -> set[str]:
    """The ``__biz`` of every post link that has one."""
    return {keys["__biz"] for keys in (article_link(post.get("url"))[1] for post in posts) if keys.get("__biz")}


def name_resolution(nickname: str | None, ghid: str | None, posts: list[dict], row: dict,
                    now: datetime) -> tuple[dict | None, str | None]:
    """The account a ``post_history`` by nickname answered, when it is the one the registry expects: ``(resolution,
    None)``, else ``(None, reason)`` — ``wechat_nickname_mismatch``, ``wechat_biz_mismatch`` (a post of another
    account), or ``wechat_unconfirmed`` (the registry knows the biz and no post carries one)."""
    if not nickname_matches(nickname, row):
        return None, "wechat_nickname_mismatch"
    bizes = post_bizes(posts)
    expected = known_biz(row)
    if expected and bizes - {expected}:
        return None, "wechat_biz_mismatch"
    if expected and not bizes:
        return None, "wechat_unconfirmed"
    resolved = {"nickname": nickname.strip(), "at": now.isoformat(), "via": "nickname"}
    if isinstance(ghid, str) and ghid.strip():
        resolved["ghid"] = ghid.strip()
    biz = expected or (next(iter(bizes)) if len(bizes) == 1 else None)
    if biz:
        resolved["biz"] = biz
    return resolved, None


def polls_per_day(row: dict) -> int:
    value = (row.get("config") or {}).get("polls_per_day")
    return value if isinstance(value, int) and 1 <= value <= 2 else 1


def priority(row: dict) -> int:
    value = (row.get("config") or {}).get("priority")
    return value if isinstance(value, int) else 9


def body_retry_after(failed_calls: int) -> timedelta:
    """The wait after the ``failed_calls``-th body call that failed for a reason that passes: 30 minutes, doubling, at
    most six hours."""
    return min(BODY_RETRY_MAX, BODY_RETRY_FIRST * 2 ** max(0, failed_calls - 1))


def is_article(url: str | None) -> bool:
    """Whether a link is a WeChat article's (its text is bought, never read as a page)."""
    return article_link(url)[0] is not None


def article_link(url: str | None) -> tuple[str | None, dict]:
    """The https form of a post's link and its ``__biz``/``mid``/``idx``/``sn`` (empty when it has none)."""
    if not isinstance(url, str) or not url.strip():
        return None, {}
    parts = urlsplit(url.strip().replace("&amp;", "&"))
    if parts.hostname not in ("mp.weixin.qq.com",):
        return None, {}
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    keys = {key: query[key] for key in ("__biz", "mid", "idx", "sn") if query.get(key)}
    return urlunsplit(("https", parts.netloc, parts.path, parts.query, "")), keys


def post_time(post: dict) -> datetime | None:
    value = post.get("post_time")
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc) if seconds > 0 else None


def external_key(post: dict) -> str | None:
    url, keys = article_link(post.get("url"))
    if keys.get("__biz") and keys.get("mid") and keys.get("idx"):
        return f"{keys['__biz']}:{keys['mid']}:{keys['idx']}"
    return post.get("sn") or url


def resolution(detail: dict, row: dict, now: datetime) -> dict | None:
    """The account an ``article_detail`` answer names, when it is the one the registry expects; ``None`` otherwise."""
    nickname = detail.get("nick_name") if isinstance(detail.get("nick_name"), str) else None
    if not nickname_matches(nickname, row):
        return None
    resolved = {"nickname": nickname.strip(), "at": now.isoformat()}
    for key, field in (("ghid", "user_name"), ("alias", "alias"), ("biz", "biz")):
        value = detail.get(field)
        if isinstance(value, str) and value.strip():
            resolved[key] = value.strip()
    return resolved


def body_of(detail: dict) -> str | None:
    """The plain text of an ``article_detail`` answer, paragraph by paragraph: from the article's own HTML
    (``content_multi_text``), else from the light HTML (``content``, mode 1), whose paragraphs are split at every
    styled run (module docstring)."""
    for field in ("content_multi_text", "content"):
        content = detail.get(field)
        if isinstance(content, str) and content.strip():
            text = clean_markup(content, keep_paragraphs=True)
            if text:
                return text
    return None


def build_entry(post: dict, row: dict, nickname: str, *, now: datetime, cover: dict | None,
                detail: dict | None, alias: str | None = None) -> NormalizedEntry | None:
    """One post as an entry; ``None`` without a link or a title."""
    url, keys = article_link(post.get("url"))
    title = post.get("title") if isinstance(post.get("title"), str) else None
    key = external_key(post)
    if not url or not title or not key:
        return None
    digest = post.get("digest") if isinstance(post.get("digest"), str) else None
    body = body_of(detail) if detail else None
    facts: dict = {}
    if keys.get("__biz"):
        facts["wx_biz"] = keys["__biz"]
    if detail and isinstance(detail.get("author"), str) and detail["author"].strip():
        facts["wx_author"] = detail["author"].strip()
    if post.get("original") in (1, "1"):
        facts["wx_original"] = True
    elif post.get("original") in (2, "2"):
        facts["wx_original"] = False
    hint = f"wx:{keys['__biz']}:{keys['mid']}:{keys['idx']}" if all(keys.get(k) for k in ("__biz", "mid", "idx")) else None
    # The article's own counts when its text was bought (reads, likes, shares, comments), else the list's (reads, likes).
    counted = detail or {}

    def stated(field: str):
        value = _count(counted.get(field))
        return value if value is not None else _count(post.get(field))

    metrics = {"views": stated("read"), "likes": stated("zan"), "reposts": stated("share_count"),
               "replies": stated("comment_count"), "observed_at": now}
    return NormalizedEntry(
        external_key=key, url=url, title=title, summary=digest or (body[:500] if body else None),
        published_at=post_time(post), date_precision="instant", language="zh", identity_hint=hint, facts=facts,
        registry_ids=registry_ids(title, digest, body), channel="wechat", platform="wechat",
        author={"name": nickname, "handle": alias, "role": (row.get("config") or {}).get("role") or "organisation"},
        media=[cover] if cover else [], metrics=metrics, body_text=body, body_from="wechat" if body else None,
    )


def is_recent(post: dict, now: datetime) -> bool:
    published = post_time(post)
    return published is not None and now - published <= FIRST_CONTACT_WINDOW


def _count(value) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None
