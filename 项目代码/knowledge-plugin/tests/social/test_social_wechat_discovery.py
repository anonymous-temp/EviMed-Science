"""WeChat's line of source discovery (ct-src 2026-10-24): accounts our WeChat bodies credit as their origin, validated by
one Dajiala call (at most 20 a day), then the ordinary trial — and lead links handed in by another line."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

from knowledge_plugin.discovery import Candidate, candidate_id, run_discovery, upsert_candidates
from knowledge_plugin.registry import parse_registry, sync_registry
from knowledge_plugin.social import wechat_discovery as wd
from knowledge_plugin.social.collector import SocialCollector

from social_fakes import FakeFetcher

NOW = datetime(2026, 10, 24, 6, 0, tzinfo=timezone.utc)
DAY = "2026-10-24"
HISTORY = "https://www.dajiala.com/fbmain/monitor/v3/post_history"
DETAIL = "https://www.dajiala.com/fbmain/monitor/v3/article_detail"


# ------------------------------------------------------------------------------------ pure


def test_origin_credits_are_read_from_short_lines_that_start_with_a_marker():
    body = "\n".join([
        "当地时间 10 月 20 日，GSK 宣布，其下反义寡核苷酸创新药已获批。",
        "截图来源：GSK 官网",                          # not at the start: an image credit
        "本文转载自公众号「医学界」",
        "文章来源 | 健康界",
        "来源：丁香园公众号",
        "来源：网络",                                  # a credit that never names an account
        "来源：https://www.nmpa.gov.cn/",
        "*来源于：医药观澜",
        "来源不明的说法在网上流传，并且引发了很多讨论，我们来看看专家怎么说这件事情的来龙去脉以及背后的科学依据到底是什么。",
        "来源：医学界",                                # once
        "出处：《中华医学杂志》",
    ])
    assert wd.origin_names(body) == ["医学界", "健康界", "丁香园", "医药观澜", "中华医学杂志"]
    assert wd.origin_names("本文来自微信公众号：赛柏蓝（ID：saibailan）") == ["赛柏蓝"]
    # Shapes cut from production bodies of 2026-10-24 (赛柏蓝's reposts; a credit to a web page is not an account's).
    assert wd.origin_names("编者按：本文来自米内网，作者玲珑；赛柏蓝授权转载，编辑晓琳") == ["米内网"]
    assert wd.origin_names("（来源｜赛柏蓝；作者｜亿路）") == ["赛柏蓝"]
    assert wd.origin_names("来源/ 国家药监局网站\n来源：GSK官方公告\n图片来源：东方财富网") == []
    assert wd.origin_names("来源于临床实践") == [], "a bare marker needs a separator or a quote"
    assert wd.origin_names(None) == []


def test_a_lead_link_becomes_a_biz_candidate_and_keys_say_how_to_validate():
    link = "http://mp.weixin.qq.com/s?__biz=MzNew==&mid=22&idx=1&sn=abc&chksm=def&scene=126&sessionid=9#rd"
    candidate = wd.candidate_from_link("lead", link, name="新号")
    assert candidate.key == "wechat:biz:MzNew==" and candidate.kind == "social" and candidate.line == "lead"
    assert candidate.hint["url"] == "https://mp.weixin.qq.com/s?__biz=MzNew==&mid=22&idx=1&sn=abc&chksm=def"
    assert wd.candidate_from_link("lead", "https://mp.weixin.qq.com/s/9jkBYr7mpX9NTKEX-VskfA") is None
    stored = {"key": candidate.key, "line": "lead", "evidence": {"hint": candidate.hint}}
    assert wd.target_of(stored) == ("link", candidate.hint["url"], "MzNew==")
    assert wd.target_of({"key": "wechat:医学界", "evidence": {}}) == ("name", "医学界", None)
    assert wd.target_of({"key": "wechat:来源", "evidence": {}}) == ("name", "来源", None)
    assert wd.target_of({"key": "wechat:网络", "evidence": {}}) is None
    assert wd.target_of({"key": "x:somedoctor", "evidence": {}}) is None


def test_a_document_a_database_a_department_cde_and_general_news_are_never_asked_for():
    """c2-fixes F2: the dry run of 60 candidates on production (2026-10-25) put these in its top twenty."""
    not_accounts = ["丁型肝炎防治专家共识", "中国急性胰腺炎诊治指南", "病例截图", "米内网药品数据库", "公司白皮书", "门诊部", "编辑部",
                    "CDE", "cde", "中国药审", "药审中心", "国家药监局药品审评中心",
                    "新华社", "人民日报", "人民日报评论", "央视新闻", "解放军报", "中国新闻网", "上观新闻", "澎湃新闻", "环球时报",
                    "光明日报", "经济日报"]
    for name in not_accounts:
        assert wd.clean_name(name) is None, name
        assert wd.candidate_from_name("social", name) is None, name
        assert wd.target_of({"key": f"wechat:{name}", "evidence": {}}) is None, "a stored one is refused unpaid"
    assert wd.origin_names("\n".join(f"来源：{name}" for name in not_accounts)) == []
    # Their health channels, and an account that merely ends like a place, are accounts.
    for name in ["人民日报健康客户端", "央视新闻客户端", "米内网", "新华社健康", "门诊部落格", "指南针药事"]:
        assert wd.clean_name(name) == name, name
    assert wd.origin_names("来源：米内网（药品数据库）") == ["米内网"], "the database in brackets is not the account's name"


def test_a_lead_read_keys_the_account_by_its_biz_by_its_nickname_or_not_at_all():
    link = "https://mp.weixin.qq.com/s?__biz=MzNew==&mid=22&idx=1&sn=abc&chksm=def"
    hint = {"platform": "wechat", "account": "新号", "biz": "MzNew==", "ghid": "gh_new", "alias": None, "verified_url": link,
            "expected_names": ["新号"]}
    evidence = {"lead_url": link, "trigger": "zh-report"}
    by_link = wd.candidate_from_lead_read("lead", link, "新号", "MzNew==", hint=hint, evidence=evidence)
    assert by_link.key == "wechat:biz:MzNew==" and by_link.line == "lead" and by_link.name == "新号"
    assert by_link.hint["url"] == link and by_link.hint["verified_url"] == link and by_link.hint["ghid"] == "gh_new"
    assert "alias" not in by_link.hint, "an empty fact is not carried"
    stored = {"key": by_link.key, "line": "lead", "evidence": {"hint": by_link.hint}}
    assert wd.target_of(stored) == ("link", link, "MzNew=="), "validated by the link, never by the biz read as a nickname"
    # A short link names no biz: the account is asked for by its nickname.
    short = "https://mp.weixin.qq.com/s/9jkBYr7mpX9NTKEX-VskfA"
    by_name = wd.candidate_from_lead_read("lead", short, "新号", "MzNew==", hint={**hint, "verified_url": short}, evidence=evidence)
    assert by_name.key == "wechat:新号" and by_name.hint["via"] == "lead" and by_name.hint["biz"] == "MzNew=="
    assert wd.target_of({"key": by_name.key, "evidence": {"hint": by_name.hint}}) == ("name", "新号", None)
    # No link that names it and no nickname that can be one: no candidate.
    assert wd.candidate_from_lead_read("lead", short, "", "MzNew==", hint=hint, evidence=evidence) is None
    assert wd.candidate_from_lead_read("lead", short, "新华社", "MzNew==", hint=hint, evidence=evidence) is None


def test_a_trial_row_is_an_ordinary_wechat_row_read_once_a_day():
    row = wd.trial_row("新号", "MzNew==", "https://mp.weixin.qq.com/s?__biz=MzNew==&mid=22&idx=1&sn=abc", "social")
    parsed = parse_registry({"sources": [row]})[0].source
    assert parsed.access == "dajiala" and parsed.poll_floor_s == 86400 and parsed.id.startswith("discovered-wx-")
    assert parsed.config["expected_names"] == ["新号"] and parsed.config["biz"] == "MzNew=="
    assert parsed.config["priority"] == 4 and parsed.config["polls_per_day"] == 1


# ------------------------------------------------------------------------------------ the line, end to end


def wx_row(source_id, name, biz):
    return {"id": source_id, "name": name, "homepage": f"https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz={biz}",
            "lane": "mixed", "source_type": "media", "access": "dajiala", "egress": "api", "authority": 3,
            "safety_feed": False, "owner_entity": name, "launch_tier": "P1", "language": "zh", "region": "CN",
            "poll_floor_s": 86400, "poll_ceiling_s": 86400, "enabled": True,
            "config": {"url": f"https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz={biz}", "expected_names": [name],
                       "priority": 2, "polls_per_day": 1, "role": "organisation", "allowed_hosts": ["mp.weixin.qq.com"],
                       "biz": biz}}


def post(biz, mid, *, days=0.1, title="一篇文章"):
    return {"url": f"http://mp.weixin.qq.com/s?__biz={biz}&mid={mid}&idx=1&sn=s{mid}&chksm=c{mid}#rd", "title": title,
            "digest": "摘要", "post_time": int((NOW - timedelta(days=days)).timestamp()), "original": 0}


ACCOUNTS = {"医学界": "MzYxj==", "丁香园": "MzDxy==", "新号": "MzNew==", "旧号": "MzOld==", "冒名号": "MzFake=="}


@pytest.fixture()
def discovery_settings(social_settings, tmp_path, monkeypatch):
    registry = tmp_path / "sources.json"
    registry.write_text(json.dumps({"sources": []}))
    social = tmp_path / "social-sources.json"
    social.write_text(json.dumps({"sources": [wx_row("wx-yxj", "医学界", ACCOUNTS["医学界"]),
                                              wx_row("wx-dxy", "丁香园", ACCOUNTS["丁香园"])]}))
    monkeypatch.setenv("KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY", str(social))
    return replace(social_settings, registry_path=str(registry))


def dajiala(bodies: dict, histories: dict):
    """post_history answers by asked nickname/ghid/url; article_detail answers by the post's mid."""
    asked = []

    def on_history(spec):
        payload = json.loads(spec.body)
        asked.append(payload)
        key = payload.get("nickname") or payload.get("ghid") or payload.get("url")
        return 200, histories.get(key, {"code": 105, "msg": "参数错误"})

    def on_detail(spec):
        mid = parse_qs(urlsplit(parse_qs(urlsplit(spec.url).query)["url"][0]).query)["mid"][0]
        return 200, {"code": 0, "content_multi_text": "".join(f"<p>{line}</p>" for line in bodies.get(mid, ["正文。"])),
                     "cost_money": 0.03}

    return FakeFetcher({("POST", HISTORY): on_history, ("GET", DETAIL): on_detail}), asked


def history(name, *posts, ghid="gh_x"):
    return {"code": 0, "nickname": name, "ghid": ghid, "data": list(posts), "cost_money": 0.16}


async def read_listed_accounts(settings, pool, fetcher):
    async with pool.connection() as conn:
        from knowledge_plugin.dynamic_registry import sync_dynamic_registry
        from knowledge_plugin.registry import load_registry
        await sync_dynamic_registry(conn, lambda: load_registry(settings.registry_path), NOW)
    collector = SocialCollector(settings, pool, fetcher, clock=lambda: NOW)
    assert (await collector.tick())["wechat"] == {"ok": 2}


async def candidates(pool):
    async with pool.connection() as conn:
        return {row["key"]: row for row in await (await conn.execute(
            "SELECT * FROM evimed_knowledge.source_candidates ORDER BY key")).fetchall()}


@pytest.mark.db
async def test_credited_accounts_become_candidates_and_a_valid_one_goes_on_trial(discovery_settings, pool):
    yxj, dxy, new = ACCOUNTS["医学界"], ACCOUNTS["丁香园"], ACCOUNTS["新号"]
    histories = {
        "医学界": history("医学界", post(yxj, 1), post(yxj, 2)),
        "丁香园": history("丁香园", post(dxy, 3)),
        "新号": history("新号", post(new, 9, days=2, title="新号的文章"), post(new, 8, days=40)),
        "旧号": history("旧号", post(ACCOUNTS["旧号"], 7, days=45)),
        "冒名号": history("冒名号研究院", post(ACCOUNTS["冒名号"], 6)),
    }
    # Each name is credited by both listed accounts (a name one account mentions is not proposed: ``MIN_CREDITING_ACCOUNTS``);
    # 孤号 is credited once; the CDE, a general news account and a guideline are credited twice and are never an account.
    bodies = {"1": ["正文。", "来源：新号", "来源：孤号", "来源：新华社", "来源：中国药审", "来源：丁型肝炎防治专家共识"],
              "2": ["本文转载自公众号「旧号」", "来源：冒名号", "正文。"],
              "3": ["来源：新号", "来源：丁香园", "来源：冒名号", "来源：医学界", "来源：旧号", "来源：新华社", "来源：中国药审",
                    "来源：丁型肝炎防治专家共识"]}
    fetcher, asked = dajiala(bodies, histories)
    await read_listed_accounts(discovery_settings, pool, fetcher)

    report = await run_discovery(discovery_settings, pool, fetcher, lambda: NOW, data={"exclude_hosts": [], "directories": []},
                                 gather_lines=["social"])
    found = await candidates(pool)
    assert set(found) == {"wechat:新号", "wechat:旧号", "wechat:冒名号"}, (
        "a listed account, a self-credit, a single credit, CDE, general news and a guideline are no candidate")
    assert found["wechat:新号"]["evidence"]["credited_by_count"] == 2
    assert found["wechat:新号"]["state"] == "trial" and found["wechat:旧号"]["state_reason"] == "no_fresh_items"
    assert found["wechat:冒名号"]["state_reason"] == "wechat_nickname_mismatch"
    row = found["wechat:新号"]["row"]
    assert row["access"] == "dajiala" and row["config"]["biz"] == new and row["config"]["expected_names"] == ["新号"]
    assert row["config"]["verified_url"] == f"https://mp.weixin.qq.com/s?__biz={new}&mid=9&idx=1&sn=s9&chksm=c9"
    assert report["validated"]["social"] == {"trial": 1, "failed": 2}
    async with pool.connection() as conn:
        source = await (await conn.execute("SELECT access, enabled FROM evimed_knowledge.sources WHERE id = %s",
                                           (row["id"],))).fetchone()
        ledger = await (await conn.execute(
            "SELECT count(*) AS n, round(sum(amount), 2) AS cny FROM evimed_knowledge.provider_calls WHERE purpose = 'discovery'")).fetchone()
    assert source["access"] == "dajiala" and source["enabled"], "the trial row is in the registry; the collector reads it"
    assert ledger["n"] == 3 and float(ledger["cny"]) == 0.48

    # The collector re-resolves the trial account from its newest article like any listed one.
    collector = SocialCollector(discovery_settings, pool, fetcher, clock=lambda: NOW + timedelta(minutes=1))
    detail_answer = {"code": 0, "nick_name": "新号", "user_name": "gh_new", "biz": new, "cost_money": 0.03,
                     "content_multi_text": "<p>正文。</p>"}
    fetcher.routes[("GET", DETAIL)] = lambda spec: (200, detail_answer)
    histories["gh_new"] = history("新号", post(new, 9, days=2))
    assert (await collector.tick())["wechat"] == {"ok": 1}


@pytest.mark.db
async def test_twenty_validations_a_day_across_lines_and_a_lead_link_is_validated_by_its_biz(discovery_settings, pool):
    new = ACCOUNTS["新号"]
    link = f"https://mp.weixin.qq.com/s?__biz={new}&mid=9&idx=1&sn=s9&chksm=c9"
    fetcher, asked = dajiala({}, {link: history("新号", post(new, 9, days=1))})
    lead = wd.candidate_from_link("lead", link)
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("social", "social", "wechat:某号", name="某号",
                                                     hint={"platform": "wechat", "account": "某号"})], NOW, DAY)
            await upsert_candidates(conn, [lead], NOW, DAY)
            for _ in range(wd.VALIDATIONS_PER_DAY):
                await conn.execute("""INSERT INTO evimed_knowledge.provider_calls (provider, called_at, purpose, outcome, amount, currency)
                                      VALUES ('dajiala', %s, 'discovery', 'ok', 0.16, 'CNY')""", (NOW - timedelta(hours=1),))
    caps = {"social": 20, "lead": 20}
    from knowledge_plugin import discovery

    lines = discovery.LINES
    discovery.LINES = tuple(lines) + (() if "lead" in lines else ("lead",))
    try:
        await run_discovery(discovery_settings, pool, fetcher, lambda: NOW, caps=caps,
                            data={"exclude_hosts": [], "directories": []}, gather_lines=[])
        assert asked == [], "the day's twenty validations are spent: nothing is paid"
        found = await candidates(pool)
        assert {key: row["state_reason"] for key, row in found.items()} == {
            "wechat:某号": "wechat_validation_budget", f"wechat:biz:{new}": "wechat_validation_budget"}
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM evimed_knowledge.provider_calls")
            await conn.execute("UPDATE evimed_knowledge.source_candidates SET next_check_at = NULL")
            await conn.execute("DELETE FROM evimed_knowledge.meta WHERE key = 'source_discovery'")
        await run_discovery(discovery_settings, pool, fetcher, lambda: NOW, caps=caps,
                            data={"exclude_hosts": [], "directories": []}, gather_lines=[])
    finally:
        discovery.LINES = lines
    assert {"url": link, "verifycode": ""} in asked and {"nickname": "某号", "verifycode": ""} in asked
    found = await candidates(pool)
    assert found[f"wechat:biz:{new}"]["state"] == "trial" and found["wechat:某号"]["state_reason"] == "wechat_not_found"


@pytest.mark.db
async def test_lead_candidates_keyed_by_biz_by_an_earlier_build_move_once_and_are_validated_by_their_link(discovery_settings, pool):
    """c2-fixes F1: ``wechat:<biz>`` (read as a nickname: code 107, ``wechat_not_found``) becomes ``wechat:biz:<biz>``."""
    new, other, third, lone = ACCOUNTS["新号"], "MzOther==", "MzThird==", "MzLone=="
    link = f"https://mp.weixin.qq.com/s?__biz={new}&mid=9&idx=1&sn=s9&chksm=c9"
    third_link = f"https://mp.weixin.qq.com/s?__biz={third}&mid=5&idx=1&sn=s5"
    short = "https://mp.weixin.qq.com/s/9jkBYr7mpX9NTKEX-VskfA"

    def old(biz, name, verified, **extra):
        return Candidate("lead", "social", f"wechat:{biz}", name=name, evidence={"lead_url": verified, "trigger": "zh-report", **extra},
                         hint={"platform": "wechat", "account": name, "biz": biz, "ghid": "gh_x", "verified_url": verified,
                               "expected_names": [name]})

    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [
                old(new, "新号", link),                       # the bug's shape: failed wechat_not_found
                old(other, "齐鲁号", short),                   # a short link: asked for by its nickname
                old(third, "第三号", third_link),              # its new key is already held
                old(lone, "新华社", short),                    # no link that names it, no nickname that can be one
                Candidate("lead", "social", "wechat:biz:" + third, name="第三号", hint={"platform": "wechat", "url": third_link}),
                Candidate("social", "social", "wechat:某号", name="某号", hint={"platform": "wechat", "account": "某号"}),
            ], NOW, DAY)
            await conn.execute("""UPDATE evimed_knowledge.source_candidates SET state = 'failed', state_reason = 'wechat_not_found',
                                         attempts = 1, validation = '{"provider": "gone"}'::jsonb
                                   WHERE key = ANY(%s)""", ([f"wechat:{new}", f"wechat:{other}", f"wechat:{lone}"],))
            await conn.execute("""UPDATE evimed_knowledge.source_candidates SET sightings = 4 WHERE key = %s""", (f"wechat:{third}",))
            report = await wd.rekey_lead_candidates(conn, NOW, DAY)
    assert report == {"moved": 2, "reopened": 2, "merged": 1, "unmovable": 1}
    found = await candidates(pool)
    assert set(found) == {f"wechat:biz:{new}", "wechat:齐鲁号", f"wechat:biz:{third}", f"wechat:{lone}", "wechat:某号"}
    moved = found[f"wechat:biz:{new}"]
    assert (moved["state"], moved["state_reason"], moved["attempts"], moved["validation"]) == ("candidate", None, 0, None)
    assert moved["id"] == candidate_id(moved["key"]) and moved["evidence"]["rekeyed_from"] == f"wechat:{new}"
    assert moved["evidence"]["hint"]["url"] == link and moved["evidence"]["hint"]["verified_url"] == link
    assert wd.target_of(moved) == ("link", link, new)
    by_nickname = found["wechat:齐鲁号"]
    assert by_nickname["state"] == "candidate" and by_nickname["evidence"]["hint"]["via"] == "lead"
    assert wd.target_of(by_nickname) == ("name", "齐鲁号", None)
    assert found[f"wechat:biz:{third}"]["sightings"] == 1 + 4, "the old row's sightings join the one that already held the key"
    assert found[f"wechat:{lone}"]["state"] == "failed", "unmovable: left as it was"
    assert found["wechat:某号"]["evidence"] == {"kind": "social", "hint": {"platform": "wechat", "account": "某号"}}
    # A second run changes nothing (the unmovable one is counted again, as it still is).
    async with pool.connection() as conn:
        async with conn.transaction():
            assert await wd.rekey_lead_candidates(conn, NOW + timedelta(hours=1), DAY) == {"moved": 0, "reopened": 0, "merged": 0, "unmovable": 1}
    assert await candidates(pool) == found
    async with pool.connection() as conn:
        daily = await (await conn.execute("SELECT candidates FROM evimed_knowledge.discovery_daily WHERE line = 'lead' AND day = %s", (DAY,))).fetchone()
    assert daily["candidates"] == 5 + 2, "five lead rows were first seen; the two reopened ones are counted as candidates again"

    # The next discovery run does the move itself and validates the account by its link: one call, a trial.
    fetcher, asked = dajiala({}, {link: history("新号", post(new, 9, days=1))})
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM evimed_knowledge.source_candidates")
            await upsert_candidates(conn, [old(new, "新号", link)], NOW, DAY)
            await conn.execute("""UPDATE evimed_knowledge.source_candidates SET state = 'failed', state_reason = 'wechat_not_found'""")
    report = await run_discovery(discovery_settings, pool, fetcher, lambda: NOW, caps={"social": 20, "lead": 20},
                                 data={"exclude_hosts": [], "directories": []}, gather_lines=[])
    assert report["rekeyed"] == {"moved": 1, "reopened": 1, "merged": 0, "unmovable": 0}
    assert asked == [{"url": link, "verifycode": ""}], "asked by the article link — never by the biz as a nickname"
    found = await candidates(pool)
    assert found[f"wechat:biz:{new}"]["state"] == "trial" and found[f"wechat:biz:{new}"]["row"]["config"]["biz"] == new


@pytest.mark.db
async def test_without_a_dajiala_key_a_wechat_candidate_waits_and_uses_no_validation(settings, pool, tmp_path, monkeypatch):
    registry = tmp_path / "sources.json"
    registry.write_text(json.dumps({"sources": []}))
    monkeypatch.setenv("KNOWLEDGE_PLUGIN_SOCIAL_REGISTRY", str(tmp_path / "none.json"))
    plain = replace(settings, registry_path=str(registry))
    async with pool.connection() as conn:
        async with conn.transaction():
            await upsert_candidates(conn, [Candidate("social", "social", "wechat:某号", hint={"platform": "wechat"}),
                                           Candidate("social", "social", "x:somedoctor", hint={"platform": "x"})], NOW, DAY)
    report = await run_discovery(plain, pool, FakeFetcher(), lambda: NOW, data={"exclude_hosts": [], "directories": []},
                                 gather_lines=[])
    assert report["validated"]["social"] == {"deferred": 2}
    async with pool.connection() as conn:
        status = await (await conn.execute("SELECT value FROM evimed_knowledge.meta WHERE key = 'source_discovery'")).fetchone()
    assert status["value"]["attempts"].get("social", 0) == 0, "a candidate waiting for its adapter uses none of the day's room"
