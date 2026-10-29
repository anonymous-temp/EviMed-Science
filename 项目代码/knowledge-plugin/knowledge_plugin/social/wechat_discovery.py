"""WeChat's line of automatic source discovery (ct-src 2026-10-24): accounts found in what we already read, validated
with one Dajiala call, then the ordinary seven-day trial (``discovery.py``, ``lifecycle.py``).

Where candidates come from:

- **Origin credits.** A WeChat article that carries another account's text says so in a line of its own — 「来源：医学界」,
  「本文转载自公众号「丁香园」」, 「文章来源 | 健康界」. The markers are a closed list (``ORIGIN_MARKERS``) read only at the start
  of a short paragraph of our own stored bodies (the first 1,500 and the last 2,500 characters of each): a format check,
  not language judgement; whether the named thing is an account is Dajiala's answer, whether it is medical is the
  platform's screen. A handful of credits that never name an account (「来源：网络」, 「来源：受访者供图」) are a closed list
  too (``NOT_ACCOUNTS``), so they are never paid for. Names credited by more accounts rank first.
  c2-fixes 2026-10-25 (the dry run of 60 candidates on production, read-only): the closed lists also name what a credit
  can be and is not an account — a document or a database (``NOT_ACCOUNT_SUFFIXES``: 「丁型肝炎防治专家共识」, 「米内网…数据库」),
  a department word (「门诊部」), the owner-excluded CDE (``OWNER_EXCLUDED_NAMES``) and the general news accounts that are not
  medical (``GENERAL_NEWS_ACCOUNTS``: their health channels, 「人民日报健康客户端」, are accounts) — and a credit is proposed
  only once at least ``MIN_CREDITING_ACCOUNTS`` (two) different accounts make it: a name one account mentions once is the
  commonest shape of a name that is no account, and each paid check is ¥0.16.
- **Reposts.** The ``social`` line's quoted authors (an X quote today; a WeChat post carries no repost author in
  Dajiala's answers — measured 2026-10-24, ``copyright_stat`` 0 and ``source_url`` empty on a reposting account's post —,
  so for WeChat the origin credits are that signal).
- **Leads.** WeChat links the platform's lead triggers hand in (contract E, ct-mix's ``lead`` line) become candidates of
  the same shape through ``candidate_from_link`` (key ``wechat:biz:<biz>``); any line's ``wechat:`` candidate is validated
  here. A key ``wechat:<biz>`` that an earlier build wrote for a lead's account is moved to the right key, once
  (``rekey_lead_candidates``): read as a nickname it could only answer code 107.

Validation, one paid call each and at most ``VALIDATIONS_PER_DAY`` a Shanghai day across every line (counted in the
provider ledger, purpose ``discovery``, so a restart never resets it): ``post_history`` by the credited nickname (¥0.16)
or by the lead's article link (¥0.14). The account is valid when Dajiala names exactly that nickname (a link: when its
posts carry the link's ``__biz``), its posts carry one biz, that biz and nickname are not already read, and it posted
within 30 days. The trial row is an ordinary WeChat row — ``expected_names`` the nickname, ``biz``, its newest article
as ``verified_url``, priority 4, one read a day — so the collector re-resolves and reads it like any listed account, and
the existing lifecycle admits or drops it on the platform's screen of what it delivered.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from psycopg.types.json import Jsonb

from ..discovery import Candidate, Verdict, candidate_id, count, shanghai_day
from ..registry import RegistryError, parse_registry
from .providers import ProviderError
from .spend import DAJIALA, SpendCapReached
from .wechat import article_link, normalize_name, post_bizes, post_time

log = logging.getLogger("knowledge_plugin.social.wechat_discovery")

VALIDATIONS_PER_DAY = 20
VALIDATION_PURPOSE = "discovery"
FRESH_DAYS = 30
ORIGIN_WINDOW = timedelta(days=3)
ORIGIN_ROWS = 1500
CREDIT_LINE_MAX = 80                  # a credit is a short paragraph of its own
PROPOSE_PER_CAP = 3
MIN_CREDITING_ACCOUNTS = 2            # an origin credit is validated (paid) only when this many accounts make it
# What an article says before the account it carries. Longest first: the alternation takes the first that matches.
ORIGIN_MARKERS = ("本文转载自", "本文来源于", "本文来源", "本内容来自", "本文来自", "文章来源", "内容来源", "信息来源", "稿件来源",
                  "转载自", "来源于", "来源", "出处")
# Markers that may run straight into the name (「本文转载自医学界」); the bare ones need a separator or a quote.
JOINED_MARKERS = ("本文转载自", "本文来源于", "本内容来自", "本文来自", "转载自")
NOT_ACCOUNTS = frozenset({"网络", "网络图片", "互联网", "图片", "图源", "本文", "作者", "原创", "受访者", "受访者供图", "企业供图",
                          "公开资料", "官网", "官方网站", "新闻", "资料", "整理", "编辑", "参考文献", "原文", "摄图网", "视觉中国",
                          "图虫创意", "网络公开资料", "公司官网", "公司公告", "企业官网", "医院官网", "pixabay", "unsplash",
                          # a word for a department or a person's role, never one account's name (c2-fixes 2026-10-25)
                          "门诊部", "编辑部", "本刊", "本报", "本网", "记者", "作者单位"})
# A credit to a web page or a document, not to an account (「来源/ 国家药监局网站」, 「来源：GSK官方公告」) — and, since
# c2-fixes 2026-10-25, to a guideline or a database (「丁型肝炎防治专家共识」, 「米内网…数据库」), or to a picture (「…截图」).
NOT_ACCOUNT_SUFFIXES = ("官网", "网站", "官方网站", "公告", "年报", "半年报", "章程", "招股书", "报告",
                        "共识", "指南", "截图", "数据库", "白皮书", "蓝皮书", "说明书")
# The owner excluded CDE for good (2026-09-29; the plugin refuses cde.org.cn and every CDE source row): its WeChat account is
# never asked for either. Compared after ``normalize_name`` (NFKC, no spaces, lower case).
OWNER_EXCLUDED_NAMES = frozenset({"cde", "中国药审", "药审中心", "cde药审中心", "国家药监局药品审评中心",
                                  "国家药品监督管理局药品审评中心"})
# General news accounts: not medical, so no source for the frontier feed (2026-10-25 review: five of the top twenty candidates
# of a dry run). Exact names only — 「人民日报健康客户端」 and the like are health accounts and stay candidates.
GENERAL_NEWS_ACCOUNTS = frozenset({"新华社", "人民日报", "人民日报评论", "央视新闻", "解放军报", "中国新闻网", "上观新闻",
                                   "澎湃新闻", "环球时报", "光明日报", "经济日报"})
NAME_SUFFIXES = ("微信公众号", "官方公众号", "公众号", "官方微信", "微信号", "微信")
# Up to four marks before the marker (「*」, 「▲」, 「（」), and an editor's note that opens the credit (「编者按：本文来自…」).
_LEAD = r"^[\s*#>▲●■◆·•|丨｜\-—【\[（(]{0,4}(?:编者按[：:]\s*|【编者按】\s*)?"
_NAME = r"[「“\"《【]?(?P<name>[^\s，,。；;、」”\"》】|丨｜/()（）:：!！?？<>]{2,40})"
_JOINED = re.compile(_LEAD + "(?:" + "|".join(JOINED_MARKERS) + r")\s*(?:于)?\s*(?:微信公众号|公众号|微信号|微信)?\s*"
                     r"[：:｜|丨\-—]*\s*" + _NAME)
_SEPARATED = re.compile(_LEAD + "(?:" + "|".join(ORIGIN_MARKERS) + r")\s*(?:于)?\s*(?:微信公众号|公众号|微信号|微信)?\s*"
                        r"(?:[：:｜|丨／/\-—]+\s*|(?=[「“\"《【]))" + _NAME)


_NEVER_ASKED = frozenset(normalize_name(n) for n in OWNER_EXCLUDED_NAMES | GENERAL_NEWS_ACCOUNTS)


def clean_name(raw: str) -> str | None:
    """A credited name as an account would be called, or ``None`` when it cannot be one (a web address, a number, a
    credit that never names an account)."""
    name = raw.strip().strip("「」“”\"《》【】'@")
    for suffix in NAME_SUFFIXES:
        if name.endswith(suffix) and len(name) > len(suffix) + 1:
            name = name[: -len(suffix)].strip()
    if not 2 <= len(name) <= 30 or name.isdigit():
        return None
    lowered = name.lower()
    if "http" in lowered or "www" in lowered or "." in name or lowered in NOT_ACCOUNTS or name.endswith(NOT_ACCOUNT_SUFFIXES):
        return None
    if normalize_name(name) in _NEVER_ASKED:
        return None
    return name


def origin_names(text: str | None) -> list[str]:
    """The account names a body credits as its origin (module docstring), in order, each once."""
    found: list[str] = []
    for paragraph in (text or "").splitlines():
        paragraph = paragraph.strip()
        if not paragraph or len(paragraph) > CREDIT_LINE_MAX:
            continue
        match = _JOINED.match(paragraph) or _SEPARATED.match(paragraph)
        name = clean_name(match.group("name")) if match else None
        if name and name not in found:
            found.append(name)
    return found


def stable_article_url(url: str | None) -> str | None:
    """A post's link reduced to what names the article (``__biz``, ``mid``, ``idx``, ``sn``, ``chksm``), https, no
    fragment; ``None`` without ``__biz``/``mid``/``idx``."""
    link, keys = article_link(url)
    if not link or not all(keys.get(k) for k in ("__biz", "mid", "idx")):
        return None
    query = dict(parse_qsl(urlsplit(link).query, keep_blank_values=True))
    kept = [(k, query[k]) for k in ("__biz", "mid", "idx", "sn", "chksm") if query.get(k)]
    return urlunsplit(("https", "mp.weixin.qq.com", "/s", urlencode(kept, safe="="), ""))


def candidate_from_link(line: str, url: str, *, name: str | None = None, evidence: dict | None = None) -> Candidate | None:
    """The candidate for the account behind a WeChat article link (for the lead line, contract E): key
    ``wechat:biz:<__biz>``, validated by ``post_history`` on the link. ``None`` when the link names no account."""
    stable = stable_article_url(url)
    if not stable:
        return None
    biz = article_link(stable)[1]["__biz"]
    return Candidate(line, "social", f"wechat:biz:{biz}", name=name,
                     hint={"platform": "wechat", "url": stable, "biz": biz, **({"account": name} if name else {})},
                     evidence=dict(evidence or {}))


def candidate_from_name(line: str, name: str, *, evidence: dict | None = None, via: str = "origin") -> Candidate | None:
    clean = clean_name(name)
    if not clean:
        return None
    return Candidate(line, "social", f"wechat:{clean}", name=clean, hint={"platform": "wechat", "account": clean, "via": via},
                     evidence=dict(evidence or {}))


def candidate_from_lead_read(line: str, link: str | None, nickname: str | None, biz: str | None, *, hint: dict,
                             evidence: dict) -> Candidate | None:
    """The candidate for the account a lead's WeChat article turned out to be from (``leads.LeadReader.read_wechat``).
    A link that names the account (``__biz``, ``mid``, ``idx``) keys it ``wechat:biz:<biz>`` and is validated by that link
    (``candidate_from_link``); a short ``/s/<token>`` link names no biz, so the account is asked for by its nickname
    (``wechat:<nickname>``, ``candidate_from_name``); with neither there is no candidate. ``hint`` adds what the read
    learned (the original id, the alias, the verified link, the names to expect).

    c2-fixes 2026-10-25: this key was ``wechat:<biz>`` before, and ``target_of`` read any ``wechat:<x>`` as a nickname —
    ``post_history`` asked for the account named ``MzIxNTc4NzU0MQ==``, code 107, six of six candidates ``wechat_not_found``."""
    extra = {k: v for k, v in hint.items() if v}
    found = candidate_from_link(line, link, name=nickname or None, evidence=evidence) if link else None
    if found is not None:
        found.hint.update(extra)
        return found
    found = candidate_from_name(line, nickname or "", evidence=evidence, via="lead")
    if found is not None:
        found.hint.update(({"biz": biz} if biz else {}) | extra)
    return found


async def rekey_lead_candidates(conn, now: datetime, day: str | None = None) -> dict:
    """Move the lead line's WeChat candidates that an earlier build keyed ``wechat:<biz>`` to the key
    ``candidate_from_lead_read`` gives them now — once, and idempotently: a row moved is no longer in the shape this reads,
    a second run finds none, a row whose new key already exists is merged into it (its sightings added, the old row dropped).
    One that failed ``wechat_not_found`` (or ``wechat_nickname_mismatch``: the biz asked for as a nickname) is a candidate
    again, to be validated by its link; any other state is kept as it was. A row no key can be made for (no link that names
    the account and no clean nickname) is left and counted. Returns ``{"moved", "reopened", "merged", "unmovable"}``."""
    rows = await (await conn.execute(
        """SELECT id, key, state, state_reason, sightings, evidence FROM evimed_knowledge.source_candidates
            WHERE line = 'lead' AND starts_with(key, 'wechat:') AND NOT starts_with(key, 'wechat:biz:')
              AND state IN ('candidate', 'failed') AND evidence #>> '{hint,biz}' IS NOT NULL
            ORDER BY first_seen_at, id""")).fetchall()
    report = {"moved": 0, "reopened": 0, "merged": 0, "unmovable": 0}
    for row in rows:
        evidence = dict(row["evidence"] or {})
        hint = dict(evidence.get("hint") or {})
        biz = str(hint.get("biz") or "").strip()
        if not biz or row["key"] != f"wechat:{biz}":
            continue                                    # a nickname's key, not the shape this build wrote by mistake
        stable = stable_article_url(hint.get("verified_url")) or stable_article_url(evidence.get("lead_url"))
        if stable and article_link(stable)[1].get("__biz") == biz:
            new_key, new_hint = f"wechat:biz:{biz}", {**hint, "url": stable}
        elif name := clean_name(str(hint.get("account") or "")):
            new_key, new_hint = f"wechat:{name}", {**hint, "account": name, "via": "lead"}
        else:
            report["unmovable"] += 1
            continue
        held = await (await conn.execute(
            "SELECT id FROM evimed_knowledge.source_candidates WHERE key = %s", (new_key,))).fetchone()
        if held:
            await conn.execute("UPDATE evimed_knowledge.source_candidates SET sightings = sightings + %s WHERE id = %s",
                               (int(row["sightings"]), held["id"]))
            await conn.execute("DELETE FROM evimed_knowledge.source_candidates WHERE id = %s", (row["id"],))
            report["merged"] += 1
            continue
        reopen = row["state"] == "failed" and row["state_reason"] in ("wechat_not_found", "wechat_nickname_mismatch")
        evidence.update(hint=new_hint, rekeyed_from=row["key"])
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET id = %(id)s, key = %(key)s, evidence = %(evidence)s,
                      state = CASE WHEN %(reopen)s THEN 'candidate' ELSE state END,
                      state_reason = CASE WHEN %(reopen)s THEN NULL ELSE state_reason END,
                      state_at = CASE WHEN %(reopen)s THEN %(now)s ELSE state_at END,
                      attempts = CASE WHEN %(reopen)s THEN 0 ELSE attempts END,
                      next_check_at = CASE WHEN %(reopen)s THEN NULL ELSE next_check_at END,
                      validation = CASE WHEN %(reopen)s THEN NULL ELSE validation END
                WHERE id = %(old)s""",
            {"id": candidate_id(new_key), "key": new_key, "evidence": Jsonb(evidence), "reopen": reopen, "now": now,
             "old": row["id"]})
        report["moved"] += 1
        report["reopened"] += int(reopen)
    if report["reopened"]:
        await count(conn, day or shanghai_day(now), "lead", candidates=report["reopened"])
    return report


@dataclass
class KnownAccounts:
    """The WeChat accounts already read or on trial: normalized names and bizes."""

    names: set[str] = field(default_factory=set)
    bizes: set[str] = field(default_factory=set)

    def add(self, *, names=(), biz: str | None = None) -> None:
        self.names |= {normalize_name(n) for n in names if isinstance(n, str) and n.strip()}
        if isinstance(biz, str) and biz.strip():
            self.bizes.add(biz.strip())

    def has_name(self, name: str | None) -> bool:
        return normalize_name(name) in self.names

    def has_biz(self, biz: str | None) -> bool:
        return bool(biz) and biz in self.bizes


async def known_accounts(conn) -> KnownAccounts:
    """Every WeChat row in the source table (retired included: a retired account comes back by its re-check) and every
    WeChat row on trial or admitted in the candidates."""
    known = KnownAccounts()
    rows = await (await conn.execute(
        "SELECT name, config, cursor FROM evimed_knowledge.sources WHERE access = 'dajiala'")).fetchall()
    candidates = await (await conn.execute(
        """SELECT row FROM evimed_knowledge.source_candidates
            WHERE row IS NOT NULL AND row->>'access' = 'dajiala'""")).fetchall()
    for row in [*rows, *[{"name": c["row"].get("name"), "config": c["row"].get("config"), "cursor": None}
                         for c in candidates]]:
        config = row["config"] or {}
        resolved = (row.get("cursor") or {}).get("resolved") or {}
        known.add(names=[row["name"], *(config.get("expected_names") or []), resolved.get("nickname")], biz=config.get("biz"))
        known.add(biz=resolved.get("biz"))
    return known


async def origin_candidates(conn, now: datetime, *, cap: int) -> list[Candidate]:
    """(a) The accounts recent WeChat bodies credit as their origin and that we do not read: up to ``cap × 3``, the most
    widely credited first (credited by more accounts, then more often) — and only the names at least
    ``MIN_CREDITING_ACCOUNTS`` different accounts credit: one account's single mention is where most of the names that are
    no account come from (c2-fixes 2026-10-25), and each check is paid."""
    if cap <= 0:
        return []
    known = await known_accounts(conn)
    rows = await (await conn.execute(
        """SELECT e.source_id, e.entry_id, s.name AS source_name, left(t.body_text, 1500) AS head,
                  CASE WHEN char_length(t.body_text) > 1500 THEN right(t.body_text, 2500) END AS tail
             FROM evimed_knowledge.entries e
             JOIN evimed_knowledge.entry_texts t USING (entry_id)
             JOIN evimed_knowledge.sources s ON s.id = e.source_id
            WHERE e.platform = 'wechat' AND e.first_seen_at > %s AND t.body_text IS NOT NULL
            ORDER BY e.first_seen_at DESC LIMIT %s""",
        (now - ORIGIN_WINDOW, ORIGIN_ROWS),
    )).fetchall()
    credited: dict[str, dict] = {}
    for row in rows:
        head = origin_names(row["head"])
        names = head + [name for name in origin_names(row["tail"]) if name not in head]
        for name in names:
            if known.has_name(name) or normalize_name(name) == normalize_name(row["source_name"]):
                continue
            seen = credited.setdefault(name, {"sources": set(), "mentions": 0, "example": row["entry_id"]})
            seen["sources"].add(row["source_id"])
            seen["mentions"] += 1
    ranked = sorted((n for n in credited if len(credited[n]["sources"]) >= MIN_CREDITING_ACCOUNTS),
                    key=lambda n: (-len(credited[n]["sources"]), -credited[n]["mentions"], n))
    found = []
    for name in ranked[: cap * PROPOSE_PER_CAP]:
        seen = credited[name]
        candidate = candidate_from_name("social", name, evidence={
            "credited_by": sorted(seen["sources"])[:5], "credited_by_count": len(seen["sources"]),
            "mentions": seen["mentions"], "example_entry": seen["example"]})
        if candidate:
            found.append(candidate)
    return found


def profile_url(biz: str) -> str:
    return "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=" + quote(biz, safe="=")


def trial_row(nickname: str, biz: str, verified_url: str | None, line: str) -> dict:
    """The registry row of a discovered account on trial: an ordinary WeChat row, read once a day at the lowest priority."""
    url = verified_url or profile_url(biz)
    config = {"url": url, "expected_names": [nickname], "priority": 4, "polls_per_day": 1, "role": "organisation",
              "allowed_hosts": ["mp.weixin.qq.com"], "biz": biz}
    if verified_url:
        config["verified_url"] = verified_url
    return {
        "id": "discovered-wx-" + hashlib.sha256(biz.encode("utf-8")).hexdigest()[:20], "name": nickname[:160],
        "homepage": url, "lane": "mixed", "source_type": "media", "access": "dajiala", "egress": "api", "authority": 2,
        "safety_feed": False, "owner_entity": nickname[:200], "launch_tier": "P2", "language": "zh", "region": "CN",
        "poll_floor_s": 86400, "poll_ceiling_s": 86400, "enabled": True, "disabled_reason": None,
        "category": f"wechat-discovered-{line}", "config": config,
    }


def target_of(candidate: dict) -> tuple[str, str, str | None] | None:
    """``("name", nickname, None)`` or ``("link", url, biz)`` for a ``wechat:`` candidate; ``None`` for anything else."""
    key = candidate.get("key") or ""
    hint = (candidate.get("evidence") or {}).get("hint") or {}
    if key.startswith("wechat:biz:"):
        stable = stable_article_url(hint.get("url"))
        biz = key[len("wechat:biz:"):]
        if stable and article_link(stable)[1].get("__biz") == biz:
            return "link", stable, biz
        return None
    if key.startswith("wechat:"):
        name = clean_name(key[len("wechat:"):])
        return ("name", name, None) if name else None
    return None


class WechatValidator:
    """Validates ``wechat:`` candidates (module docstring). One paid call each, serialized, at most
    ``VALIDATIONS_PER_DAY`` a Shanghai day, counted in the provider ledger."""

    def __init__(self, dajiala, ledger, clock, known: KnownAccounts, *, per_day: int = VALIDATIONS_PER_DAY) -> None:
        self.dajiala = dajiala
        self.ledger = ledger
        self.clock = clock
        self.known = known
        self.per_day = per_day
        self._lock = asyncio.Lock()

    async def validate(self, candidate: dict) -> Verdict:
        target = target_of(candidate)
        if target is None:
            return Verdict("failed", "wechat_key_invalid")
        kind, value, biz = target
        if (kind == "name" and self.known.has_name(value)) or (kind == "link" and self.known.has_biz(biz)):
            return Verdict("failed", "known")
        if not self.dajiala.configured:
            return Verdict("deferred", "adapter_unavailable:wechat")
        async with self._lock:
            now = self.clock()
            if await self.ledger.calls_today(DAJIALA, VALIDATION_PURPOSE, now) >= self.per_day:
                return Verdict("deferred", "wechat_validation_budget")
            try:
                if kind == "name":
                    history = await self.dajiala.post_history(nickname=value, purpose=VALIDATION_PURPOSE)
                else:
                    history = await self.dajiala.post_history(url=value, purpose=VALIDATION_PURPOSE)
            except SpendCapReached:
                return Verdict("deferred", "dajiala_daily_cap")
            except ProviderError as error:
                if error.kind in ("gone", "bad-request"):
                    return Verdict("failed", "wechat_not_found", validation={"provider": error.detail})
                return Verdict("deferred", f"dajiala_{error.kind}")
        return self.judge(candidate, kind, value, biz, history, now)

    def judge(self, candidate: dict, kind: str, value: str, biz: str | None, history, now: datetime) -> Verdict:
        bizes = post_bizes(history.posts)
        answered = (history.nickname or "").strip()
        validation = {"answered": answered[:100], "bizes": sorted(bizes)[:3], "posts": len(history.posts)}
        if not answered or (kind == "name" and normalize_name(answered) != normalize_name(value)):
            return Verdict("failed", "wechat_nickname_mismatch", validation=validation)
        if len(bizes) != 1 or (kind == "link" and bizes != {biz}):
            return Verdict("failed", "wechat_biz_mismatch", validation=validation)
        (account_biz,) = bizes
        if self.known.has_biz(account_biz) or self.known.has_name(answered):
            return Verdict("failed", "known", validation=validation)
        horizon = now - timedelta(days=FRESH_DAYS)
        dated = sorted(((post_time(p), p) for p in history.posts if post_time(p)), key=lambda pair: pair[0], reverse=True)
        fresh = [post for published, post in dated if published >= horizon]
        if not fresh:
            return Verdict("failed", "no_fresh_items", validation={**validation, "newest": dated[0][0].isoformat() if dated else None})
        row = trial_row(answered, account_biz, stable_article_url(fresh[0].get("url")), candidate["line"])
        try:
            parse_registry({"sources": [row]})
        except RegistryError as error:
            return Verdict("failed", f"row_invalid:{error.problems[0][:80]}", validation=validation)
        self.known.add(names=[answered], biz=account_biz)
        validation.update(fresh=len(fresh), newest=dated[0][0].isoformat(),
                          titles=[str(p.get("title") or "")[:160] for p in fresh[:5]])
        return Verdict("trial", None, row, validation, candidate.get("medical_basis"))
