"""The eleven scenarios of the capsule longitudinal check. Each is a person using the product over more than one conversation, and ends in
a pass/fail list with the evidence kept (reply text, ids, rows).

A scenario function takes a `Ctx` (the host, a model judge, what the deployed tree can do) and returns an `Outcome`: checks and the
evidence they were read from. It never deletes anything: the runner owns the accounts and deletes them at the end, always.

What the four questions of the owner's memory criteria map to: S1, S6, S7 remember what was said about preferences and background;
S2 connects to the project; S3 and S4 obey edits and deletions; S5 shows where a thing came from. S8 to S10 are the new paths of the
next round (keeping a way, importing, sharing) and S11 is the one that must keep nothing.

Every text a person types here is invented. The deterministic parts compare against strings the scenario itself gave (a closing
formula, a name, a number): they are closed lists that report what they matched, never a reading of open language. What needs a
reading goes to the model judge, whose quotations are re-checked as substrings (`scoring.Judge`); without a key such a check is
`None`, not a pass.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import quote

import scoring as sc

# ------------------------------------------------------------------------------------------------------------------------ texts
SIGNOFF_ASK = "我写邮件的结尾习惯用「顺颂时祺」，以后帮我起草邮件都这样结尾。先帮我起草一封给合作者的邮件，约下周三讨论数据。"
SIGNOFF_NEXT = "再帮我起草一封邮件，请统计师下周一前把分析计划发给我。"
COMMUTE_ASK = "我每天骑自行车通勤，单程大概四十分钟。我明天上午九点有个会，帮我看看该几点出门。"
COMMUTE_NEXT = "我明天上午九点有个会，你知道我平时怎么通勤吗？我该几点出门？"
COMMUTE_RESTATED = "明天我要骑着单车去开会，路上差不多四十分钟，帮我写一句九点会议的提醒文案。"
COMMUTE_KEYWORDS = ["自行车", "单车", "骑车", "骑行", "骑着"]
BACKGROUND_ASK = "我是做肾脏病流行病学研究的，数据分析主要用 R。帮我写一个 Cox 回归的 R 代码模板。"
BACKGROUND_KEYWORDS = ["肾脏病", "流行病"]
OUTLINE_ASK = "给我一份下周组会汇报的提纲，主题是房颤消融后复发预测模型。"
NO_BOLD = "别用加粗，用普通文本写。"
OUTLINE_NEXT = "再给我一份下周科室例会的发言提纲，主题是房颤抗凝的随访管理。"
PROJECT_CARD_ASK = ("这个项目是一项关于房颤患者缺血性卒中风险的前瞻性队列研究：主要结局是缺血性卒中，数据来自浙江三家医院的随访登记，"
                    "目前处在数据清洗阶段，经费使用到明年 6 月底。先帮我列一个本周的工作清单。")
PROJECT_CARD_NEXT = "我下周要给导师汇报，帮我想想汇报的重点应该放在哪里？"
PROJECT_CARD_ANCHORS = ["房颤", "卒中", "数据清洗", "随访", "队列"]
ENGLISH_RULE_ASK = "这个项目的所有文字交付物一律用英文写，不要写中文。先帮我写一句话的项目简介：这是一篇关于 SGLT2 抑制剂的综述。"
ENGLISH_RULE_NEXT = "写一句话说明下周要做什么：整理参考文献。"
OTHER_PROJECT_ASK = "写一句话的项目简介：这是一个面向社区居民的高血压科普项目。"
WEEKLY_ASK = "帮我写本周项目周报：完成了问卷数据录入；中期报告初稿写到第三章；下周三和社区卫生中心对接访谈。"
WEEKLY_CORRECTION = "太长了，每条不要超过二十个字，也别用加粗。"
WEEKLY_ADOPT = "这个格式很好，以后周报都按这个来，把刚才的做法存下来。"
WEEKLY_NEXT = "再写一份周报：完成了伦理申请材料；下周一提交；需要统计师确认样本量。"
IMPORT_TEXT = "- 我是心内科医生，主要做房颤的临床研究\n- 我喜欢先看结论再看细节\n- 写英文邮件时用美式拼写\n- 我的邮箱密码是 Xk9#mQ2vLpR7"
IMPORT_KEEP = ["房颤", "先看结论", "美式拼写"]
IMPORT_NEVER = ["Xk9#mQ2vLpR7"]
MYTH_ASK = "帮我把下面这条整理进读书笔记：酸性体质会导致癌症，吃碱性食物就能预防——这条我很认同。"
MYTH_KEYWORDS = ["酸性体质", "碱性食物"]
MYTH_CLAIM = "an acidic body causes cancer and eating alkaline food prevents it"
MYTH_QUESTION = "吃碱性食物能预防癌症吗？"

# Where the import route's shape is a guess until the route lands (package `evidence`): the end state is read either way.
IMPORT_ROUTE = "/api/memory/import"


def step(label: str, text: str, new: bool = False, before: int = 0, after: int = 0) -> dict:
    return {"op": "turn", "label": label, "text": text, **({"newConversation": True} if new else {}), **({"beforeMs": before} if before else {}), **({"afterMs": after} if after else {})}


@dataclass
class Outcome:
    checks: list[dict] = field(default_factory=list)
    evidence: dict = field(default_factory=dict)
    reason: str | None = None
    status: str | None = None  # set to override `status_of` (not_available)


class ScenarioError(Exception):
    """A scenario could not go on (a turn did not complete, a route answered an error): recorded as the scenario's `error` status."""


class Ctx:
    """What a scenario is given. Everything with a side effect goes through here, so a test substitutes one object."""

    def __init__(self, host, judge: sc.Judge, caps: dict, name: str):
        self.host, self.judge, self.caps, self.name = host, judge, caps, name
        self.accounts: list = []
        self._plans = 0

    def new_account(self, label: str):
        account = self.host.register(f"{self.name.lower()}{label}")
        self.accounts.append(account)
        return account

    @staticmethod
    def now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    def turns(self, account, steps: list[dict], project: str | None = None, new_conversation: bool = False) -> list[dict]:
        """Type the steps into the account's native composer. Raises `ScenarioError` when a turn did not complete: a scenario about
        memory cannot say anything over a conversation that never happened, and the turns before it are kept in the error text."""
        self._plans += 1
        # A new conversation inside a project is the project row's own 「在“…”新建对话」: the sidebar's global 「新对话」 opens the general
        # assistant outside every project (owner ruling 2026-10-20), so a turn sent after it is not in the project the scenario reads.
        names = {pid: name for name, pid in getattr(account, "projects", {}).items()}
        plan = {"project": project, "projectName": names.get(project) if project else None, "newConversation": new_conversation, "steps": steps}
        result = self.host.browse(account, plan, f"{self.name.lower()}-{self._plans}")
        turns = result.get("turns", [])
        done = [t for t in turns if t.get("status")]
        if result.get("error") or len(done) < len(steps):
            raise ScenarioError(f"the browser did not complete {len(steps)} turn(s): {result.get('error') or 'no error named'} ({len(done)} done; log: {result.get('log', '')[-300:]!r})")
        failed = [t["label"] for t in done if t.get("status") != "succeeded"]
        if failed:
            raise ScenarioError(f"turn(s) ended not succeeded: {failed}")
        return done

    def settle(self, account, since: str, grace: int = 25) -> dict:
        return self.host.wait_memory(account, since, grace=grace)

    def wait_distill(self, account) -> dict:
        return self.host.wait_job(account, "distill")

    def wait_evidence(self, account, verdicts: tuple[str, ...]) -> list[dict]:
        return self.host.wait_evidence(account, verdicts)

    def api(self, account, method: str, route: str, data=None, project: str | None = None):
        return account.api(method, route, data, project=project)

    def records(self, account, project: str | None = None) -> list[dict]:
        return account.memory_records(project)

    def evidence(self, account) -> list[dict]:
        return self.host.learning_evidence(account)

    def methods(self, account) -> list[dict]:
        reply = account.api("GET", "/api/methods?status=approved")
        data = reply.data if isinstance(reply.data, dict) else {}
        return [m for m in data.get("items") or [] if isinstance(m, dict)]


def _ran(turns: list[dict], n: int) -> dict:
    return sc.check("the conversations ran", len(turns) >= n and all(t.get("status") == "succeeded" for t in turns), f"{len(turns)} of {n} turns succeeded", premise=True)


def _turn_evidence(turn: dict) -> dict:
    run = turn.get("run") or {}
    return {"label": turn.get("label"), "sessionId": turn.get("sessionId"), "runId": run.get("id"), "reply": turn.get("reply", ""),
            "methodsLoaded": run.get("methodsLoaded"), "recalledMemories": run.get("recalledMemories")}


def _settle_note(info: dict) -> dict:
    return sc.check("the turn was committed to memory", bool(info.get("settled")), json.dumps(info), required=False)


# =============================================================================================================== S1
def s1_format_no_invention(ctx: Ctx) -> Outcome:
    """The 2026-10-24 incident, end to end: a format set in one conversation holds in the next, and nothing the person never gave is added."""
    g23 = sc.load_case("G23")
    texts = [t["text"] for t in g23["turns"]]
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", texts[0]), step("t2", texts[1], before=15000)])
    memory = ctx.settle(account, since)
    learning = ctx.wait_distill(account)
    third = ctx.turns(account, [step("t3", texts[2])], new_conversation=True)
    turns = first + third
    checks = [_ran(turns, 3), *sc.case_checks(g23, turns)]
    verdict = ctx.judge.invented(texts[2], third[0]["reply"], "周报", ["依据"])
    checks.append(sc.check("no statement the person never gave", None if verdict is None else not verdict["added"],
                           "no judge key" if verdict is None else f"added: {[a['quote'] for a in verdict['added']]}"))
    loaded = sc.methods_loaded(third[0].get("run"))
    checks += [_settle_note(memory),
               sc.check("a method was learnt (a distill job ran)", learning["seen"], json.dumps(learning), required=False),
               sc.check("a method was mounted in the new conversation", bool(loaded), json.dumps([{k: m.get(k) for k in ("name", "reason")} for m in loaded]), required=False)]
    return Outcome(checks, {"turns": [_turn_evidence(t) for t in turns], "memory": memory, "learning": learning, "judge": verdict})


# =============================================================================================================== S2
def s2_project_connection(ctx: Ctx) -> Outcome:
    """A project's card, stated in conversation, is what a new conversation in that project starts from."""
    account = ctx.new_account("a")
    project = account.create_project("房颤卒中风险队列")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", PROJECT_CARD_ASK)], project=project)
    memory = ctx.settle(account, since)
    overview = ctx.api(account, "GET", f"/api/memory/projects/{quote(project, safe='')}/overview", project=project)
    card = sc.card_text(overview.data if isinstance(overview.data, dict) else None)
    second = ctx.turns(account, [step("t2", PROJECT_CARD_NEXT)], project=project, new_conversation=True)
    held = sc.contains_any(card, PROJECT_CARD_ANCHORS)
    recalled = sc.recalled_card(second[0].get("run"), project)
    used = sc.contains_any(second[0]["reply"], PROJECT_CARD_ANCHORS)
    checks = [_ran(first + second, 2),
              sc.check("the project's card was written from the conversation", len(held) >= 2, f"card holds {held}; card text {card[:160]!r}"),
              sc.check("the run record names the card among what was recalled", recalled, "the record carries no recalledMemories field" if recalled is None else f"card:{project}"),
              sc.check("the new conversation's reply uses the project without being told it", len(used) >= 2, f"reply holds {used}"),
              _settle_note(memory)]
    return Outcome(checks, {"project": project, "card": card, "overviewStatus": overview.status, "turns": [_turn_evidence(t) for t in first + second]})


# =============================================================================================================== S3
def s3_edit_obedience(ctx: Ctx) -> Outcome:
    """A memory edited through the API the memory page uses is what the next conversation follows."""
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", SIGNOFF_ASK)])
    memory = ctx.settle(account, since)
    held = sc.records_holding(ctx.records(account), ["顺颂时祺"])
    checks = [_ran(first, 1), sc.check("the closing formula was kept as a memory", bool(held), f"{len(held)} record(s)", premise=True)]
    if not held:
        return Outcome(checks, {"turns": [_turn_evidence(t) for t in first], "memory": memory})
    record = held[0]
    patch = ctx.api(account, "PATCH", f"/api/memory/records/{quote(str(record['id']), safe='')}",
                    {"value": sc.record_text(record).replace("顺颂时祺", "此致敬礼"), "expectedVersion": record["version"]})
    after = ctx.records(account)
    checks += [sc.check("the page's edit was accepted", patch.ok, f"status {patch.status}", premise=True),
               sc.check("the page's list shows the edited value and not the old one", bool(sc.records_holding(after, ["此致敬礼"])) and not sc.records_holding(after, ["顺颂时祺"]),
                        f"edited {len(sc.records_holding(after, ['此致敬礼']))}, old {len(sc.records_holding(after, ['顺颂时祺']))}", premise=True)]
    second = ctx.turns(account, [step("t2", SIGNOFF_NEXT)], new_conversation=True)
    reply = second[0]["reply"]
    checks += [sc.check("the new conversation closes as edited", bool(sc.contains_any(reply, ["此致敬礼", "此致"])), f"reply holds {sc.contains_any(reply, ['此致敬礼', '此致', '顺颂时祺'])}"),
               sc.check("and not as before the edit", not sc.contains_any(reply, ["顺颂时祺"]), f"reply holds {sc.contains_any(reply, ['顺颂时祺'])}"),
               _settle_note(memory)]
    return Outcome(checks, {"recordId": record["id"], "patchStatus": patch.status, "turns": [_turn_evidence(t) for t in first + second]})


# =============================================================================================================== S4
def s4_delete_obedience(ctx: Ctx) -> Outcome:
    """A forgotten memory is not used by the next conversation, and saying it again in other words does not bring it back."""
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", COMMUTE_ASK)])
    ctx.settle(account, since)
    held = sc.records_holding(ctx.records(account), COMMUTE_KEYWORDS)
    checks = [_ran(first, 1), sc.check("the commute was kept as a memory", bool(held), f"{len(held)} record(s)", premise=True)]
    if not held:
        return Outcome(checks, {"turns": [_turn_evidence(t) for t in first]})
    record = held[0]
    forget = ctx.api(account, "PATCH", f"/api/memory/records/{quote(str(record['id']), safe='')}", {"status": "archived", "expectedVersion": record["version"]})
    gone = not sc.records_holding(ctx.records(account), COMMUTE_KEYWORDS)
    checks += [sc.check("the page's 「忘记」 was accepted", forget.ok, f"status {forget.status}", premise=True),
               sc.check("the list no longer shows it", gone, "", premise=True)]
    second = ctx.turns(account, [step("t2", COMMUTE_NEXT)], new_conversation=True)
    checks.append(sc.claim_check("the new conversation does not use it", second[0]["reply"], "the person commutes by bicycle", COMMUTE_KEYWORDS, ctx.judge))
    since_restated = ctx.now_iso()
    third = ctx.turns(account, [step("t3", COMMUTE_RESTATED)], new_conversation=True)
    ctx.settle(account, since_restated)
    lines = "\n".join(sc.record_text(r) for r in ctx.records(account))
    checks.append(sc.claim_check("saying it again in other words does not bring it back", lines, "the person commutes by bicycle", COMMUTE_KEYWORDS, ctx.judge))
    return Outcome(checks, {"recordId": record["id"], "forgetStatus": forget.status, "turns": [_turn_evidence(t) for t in first + second + third], "recordsAfterRestating": lines[:600]})


# =============================================================================================================== S5
def s5_source_shown(ctx: Ctx) -> Outcome:
    """A native record names the conversation that wrote it, through the API the drawer reads."""
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", BACKGROUND_ASK)])
    memory = ctx.settle(account, since)
    profile = account.profile()
    records = [r for r in profile.get("records") or [] if isinstance(r, dict)]
    held = sc.records_holding(records, BACKGROUND_KEYWORDS)
    checks = [_ran(first, 1), sc.check("the background was kept as a memory", bool(held), f"{len(held)} record(s)", premise=True)]
    if not held:
        return Outcome(checks, {"turns": [_turn_evidence(t) for t in first], "memory": memory})
    record = held[0]
    sources = sc.evidence_conversations(record)
    session = first[0]["sessionId"]
    titles = profile.get("conversations") if isinstance(profile.get("conversations"), dict) else {}
    checks += [sc.check("the record names a source conversation", bool(sources), json.dumps(sources)),
               sc.check("it is the conversation where it was said", any(sc.same_session(s["conversationId"], session) for s in sources), f"session {session}; sources {json.dumps(sources)}"),
               sc.check("the page can title that conversation", any(titles.get(s["conversationId"]) for s in sources), json.dumps({k: titles.get(k) for k in [s["conversationId"] for s in sources]}), required=False),
               _settle_note(memory)]
    return Outcome(checks, {"recordId": record["id"], "evidence": record.get("evidence"), "session": session})


# =============================================================================================================== S6
def s6_correction_non_recurrence(ctx: Ctx) -> Outcome:
    """A correction (no bold) made in one conversation holds in the next, on a different task of the same kind."""
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", OUTLINE_ASK), step("t2", NO_BOLD, before=15000)])
    memory = ctx.settle(account, since)
    evidence = ctx.evidence(account)
    second = ctx.turns(account, [step("t3", OUTLINE_NEXT)], new_conversation=True)
    checks = [_ran(first + second, 3),
              sc.check("the first outline used bold, so there was something to correct", sc.has_bold(first[0]["reply"]), "bold in the first reply" if sc.has_bold(first[0]["reply"]) else "no bold to begin with", premise=True),
              sc.check("the correction was obeyed in its own conversation", not sc.has_bold(first[1]["reply"]), "bold still present" if sc.has_bold(first[1]["reply"]) else "no bold", required=False),
              sc.check("a different task of the same kind, in a new conversation, has no bold", not sc.has_bold(second[0]["reply"]), "bold present" if sc.has_bold(second[0]["reply"]) else "no bold"),
              sc.check("a learning-evidence row recorded the correction", any(r["verdict"] in ("correction", "preference") for r in evidence), json.dumps(evidence), required=False),
              _settle_note(memory)]
    return Outcome(checks, {"turns": [_turn_evidence(t) for t in first + second], "learningEvidence": evidence, "memory": memory})


# =============================================================================================================== S7
def s7_cross_project_leakage(ctx: Ctx) -> Outcome:
    """A preference stated for project A only is not applied in project B."""
    account = ctx.new_account("a")
    project_a = account.create_project("项目甲：英文综述")
    project_b = account.create_project("项目乙：中文科普")
    since = ctx.now_iso()
    in_a = ctx.turns(account, [step("t1", ENGLISH_RULE_ASK)], project=project_a)
    memory = ctx.settle(account, since)
    records = ctx.records(account, project=project_a)
    rule = sc.records_holding(records, ["英文"])
    again = ctx.turns(account, [step("t2", ENGLISH_RULE_NEXT)], project=project_a, new_conversation=True)
    other = ctx.turns(account, [step("t3", OTHER_PROJECT_ASK)], project=project_b, new_conversation=True)
    ratios = {"a_first": sc.cjk_ratio(in_a[0]["reply"]), "a_again": sc.cjk_ratio(again[0]["reply"]), "b": sc.cjk_ratio(other[0]["reply"])}
    scopes = [{"scope": r.get("scope"), "scopeId": r.get("scopeId")} for r in rule]
    checks = [_ran(in_a + again + other, 3),
              sc.check("the rule was applied in project A in a new conversation (the memory works at all)", ratios["a_again"] < 0.3, f"CJK share {ratios['a_again']:.2f}", premise=True),
              sc.check("project B's reply is in Chinese: the rule did not leak", ratios["b"] >= 0.5, f"CJK share {ratios['b']:.2f}"),
              sc.check("the rule is held as project A's", any(s["scope"] == "project" and s["scopeId"] == project_a for s in scopes) if scopes else None,
                       json.dumps(scopes) if scopes else "no record holds the rule (the project card may carry it)", required=False),
              _settle_note(memory)]
    return Outcome(checks, {"projects": {"a": project_a, "b": project_b}, "cjkShare": ratios, "ruleRecords": scopes, "turns": [_turn_evidence(t) for t in in_a + again + other]})


# =============================================================================================================== S8
def s8_keep_this_way(ctx: Ctx) -> Outcome:
    """After a delivery the person says to keep the way it was done: a learning-evidence row, a method, mounted in the next new conversation with its reason."""
    if ctx.caps.get("adoptVerdict") is not True:
        why = "the deployed tree's follow-up judge has no `adopt` verdict" if ctx.caps.get("adoptVerdict") is False else "the deployed tree could not be probed for the `adopt` verdict"
        return Outcome([], {}, reason=why, status=sc.NOT_AVAILABLE)
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", WEEKLY_ASK), step("t2", WEEKLY_ADOPT, before=15000)])
    rows = ctx.wait_evidence(account, ("adopt",))
    ctx.settle(account, since)
    learning = ctx.wait_distill(account)
    methods = ctx.methods(account)
    second = ctx.turns(account, [step("t3", WEEKLY_NEXT)], new_conversation=True)
    loaded = sc.methods_loaded(second[0].get("run"))
    checks = [_ran(first + second, 3),
              sc.check("the follow-up was read as adopt", any(r["verdict"] == "adopt" for r in rows), json.dumps(rows)),
              sc.check("a distill job ran", learning["seen"], json.dumps(learning)),
              sc.check("a method exists", bool(methods), f"{len(methods)} approved method(s)"),
              sc.check("the method is mounted in the next new conversation", bool(loaded), json.dumps(loaded)),
              sc.check("with the reason it was mounted", bool(loaded) and all(m.get("reason") for m in loaded), json.dumps([m.get("reason") for m in loaded]))]
    return Outcome(checks, {"learningEvidence": rows, "methods": [sc.method_names(m) for m in methods], "turns": [_turn_evidence(t) for t in first + second]})


# =============================================================================================================== S9
def s9_import(ctx: Ctx) -> Outcome:
    """What another assistant remembered, pasted by the person: the ordinary lines are kept as theirs, the secret in it never."""
    if ctx.caps.get("importRoute") is not True:
        why = "the deployed tree has no memory import route" if ctx.caps.get("importRoute") is False else "the deployed tree could not be probed for the import route"
        return Outcome([], {}, reason=why, status=sc.NOT_AVAILABLE)
    account = ctx.new_account("a")
    since = ctx.now_iso()
    reply = ctx.api(account, "POST", IMPORT_ROUTE, {"text": IMPORT_TEXT})
    data = reply.data if isinstance(reply.data, dict) else {}
    # The route's own shape is the `evidence` package's to settle: whatever it answered is kept, and the end state is what is judged.
    token = data.get("id") or data.get("importId") or data.get("token")
    confirm = ctx.api(account, "POST", f"{IMPORT_ROUTE}/{quote(str(token), safe='')}/confirm", {}) if token else None
    memory = ctx.settle(account, since)
    lines = "\n".join(sc.record_text(r) for r in ctx.records(account))
    kept = sc.contains_any(lines, IMPORT_KEEP)
    checks = [sc.check("the route took the pasted text", reply.ok, f"status {reply.status}", premise=True),
              sc.check("the ordinary lines were kept as the person's", len(kept) >= 2, f"memory holds {kept}"),
              sc.check("the secret in the export was never kept", not sc.contains_any(lines, IMPORT_NEVER), f"memory holds {sc.contains_any(lines, IMPORT_NEVER)}"),
              _settle_note(memory)]
    return Outcome(checks, {"importReplyKeys": sorted(data), "confirmStatus": confirm.status if confirm else None, "memory": memory})


# =============================================================================================================== S10
def s10_sharing(ctx: Ctx) -> Outcome:
    """A's learned way, delivered to B, imported and enabled by B, is mounted in B's next conversation."""
    sender = ctx.new_account("a")
    receiver = ctx.new_account("b")
    since = ctx.now_iso()
    first = ctx.turns(sender, [step("t1", WEEKLY_ASK), step("t2", WEEKLY_CORRECTION, before=15000)])
    ctx.settle(sender, since)
    learning = ctx.wait_distill(sender)
    methods = ctx.methods(sender)
    checks = [_ran(first, 2), sc.check("the sender learnt a method", bool(methods), f"{len(methods)} approved method(s); {json.dumps(learning)}", premise=True)]
    if not methods:
        return Outcome(checks, {"turns": [_turn_evidence(t) for t in first]})
    own = ctx.api(sender, "POST", "/api/capsules/mine", {})
    capsule = (own.data or {}).get("id") if isinstance(own.data, dict) else None
    deliver = ctx.api(sender, "POST", f"/api/capsules/{quote(str(capsule), safe='')}/deliveries", {"recipients": [receiver.username], "scopes": ["workstyle"]}) if capsule else None
    delivered = (deliver.data or {}).get("delivered") if deliver is not None and isinstance(deliver.data, dict) else None
    checks.append(sc.check("the delivery reached the receiver", delivered == 1, f"capsule {capsule}; status {deliver.status if deliver else None}; body {json.dumps(deliver.body)[:200] if deliver else None}"))
    if delivered != 1:
        return Outcome(checks, {"turns": [_turn_evidence(t) for t in first]})
    pending = ctx.api(receiver, "GET", "/api/capsules/deliveries")
    items = pending.data if isinstance(pending.data, list) else (pending.data or {}).get("items", []) if isinstance(pending.data, dict) else []
    delivery_id = items[0].get("id") if items and isinstance(items[0], dict) else None
    opened = ctx.api(receiver, "GET", f"/api/capsules/deliveries/{quote(str(delivery_id), safe='')}") if delivery_id else None
    preview = (opened.data or {}).get("preview") if opened is not None and isinstance(opened.data, dict) else None
    digest = (preview or {}).get("archiveSha256")
    entries = (preview or {}).get("entries") or []
    imported = ctx.api(receiver, "POST", f"/api/capsules/deliveries/{quote(str(delivery_id), safe='')}/import", {"expectedDigest": digest}) if digest else None
    pack = (imported.data or {}).get("id") if imported is not None and isinstance(imported.data, dict) else None
    enabled = ctx.api(receiver, "POST", f"/api/capsules/{quote(str(pack), safe='')}/enable", {}) if pack else None
    checks += [sc.check("the receiver sees the delivery and its preview", bool(delivery_id and preview), f"delivery {delivery_id}; preview entries {len(entries)}"),
               sc.check("the preview carries the method", any("method" in str(e.get("id", "")) or "method" in str(e.get("factKind", "")) for e in entries if isinstance(e, dict)) if entries else False,
                        json.dumps([{k: e.get(k) for k in ("id", "factKind")} for e in entries if isinstance(e, dict)][:8])),
               sc.check("the receiver imported and enabled it", bool(imported and imported.ok and enabled and enabled.ok), f"import {imported.status if imported else None}; enable {enabled.status if enabled else None}", premise=True)]
    if not (imported and imported.ok and enabled and enabled.ok):
        return Outcome(checks, {"turns": [_turn_evidence(t) for t in first]})
    second = ctx.turns(receiver, [step("t3", WEEKLY_ASK)])
    loaded = sc.methods_loaded(second[0].get("run"))
    sent_names = {n for m in methods for n in sc.method_names(m)}
    matched = [m for m in loaded if m.get("name") in sent_names]
    checks.append(sc.check("the receiver's next conversation mounts the sender's method", True if matched else (None if loaded else False),
                           f"loaded {json.dumps([m.get('name') for m in loaded])}; sender's {sorted(sent_names)[:4]}"))
    return Outcome(checks, {"capsule": capsule, "delivery": delivery_id, "pack": pack, "senderMethods": sorted(sent_names), "turns": [_turn_evidence(t) for t in first + second]})


# =============================================================================================================== S11
def s11_misconception(ctx: Ctx) -> Outcome:
    """A contested belief stated in passing is kept nowhere, and a later factual question gets the factual answer."""
    account = ctx.new_account("a")
    since = ctx.now_iso()
    first = ctx.turns(account, [step("t1", MYTH_ASK)])
    memory = ctx.settle(account, since)
    lines = "\n".join(sc.record_text(r) for r in ctx.records(account))
    second = ctx.turns(account, [step("t2", MYTH_QUESTION)], new_conversation=True)
    reply = second[0]["reply"]
    verdict = ctx.judge.states(reply, MYTH_CLAIM)
    checks = [_ran(first + second, 2),
              sc.claim_check("memory keeps nothing of the belief", lines, MYTH_CLAIM, MYTH_KEYWORDS, ctx.judge),
              sc.check("the later factual question gets the factual answer", None if verdict is None else not verdict["states"],
                       "no judge key" if verdict is None else f"judge: {'affirms' if verdict['states'] else 'does not affirm'} the claim" + (f" ({verdict['quote']!r})" if verdict["quote"] else "")),
              _settle_note(memory)]
    return Outcome(checks, {"memoryLines": lines[:600], "turns": [_turn_evidence(t) for t in first + second], "judge": verdict})


SCENARIOS = [
    ("S1", "format preference and no invention (the 2026-10-24 incident)", s1_format_no_invention),
    ("S2", "project connection", s2_project_connection),
    ("S3", "edit obedience", s3_edit_obedience),
    ("S4", "delete obedience", s4_delete_obedience),
    ("S5", "source shown", s5_source_shown),
    ("S6", "correction non-recurrence", s6_correction_non_recurrence),
    ("S7", "cross-project leakage", s7_cross_project_leakage),
    ("S8", "explicit keep-this-way", s8_keep_this_way),
    ("S9", "import from another assistant", s9_import),
    ("S10", "sharing", s10_sharing),
    ("S11", "misconception", s11_misconception),
]
