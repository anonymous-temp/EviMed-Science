"""The scenarios against a fake host: the wiring (which turn is typed where, which route is called with what, what is read back) and the
verdicts, with canned replies. No server, no browser, no model."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import host as hosting  # noqa: E402
import run as runner  # noqa: E402
import scenarios as sce  # noqa: E402
import scoring as sc  # noqa: E402

G23_THIRD = "1. 做完敏感性分析\n2. 和统计师讨论缺失值\n3. 下周准备投会议摘要"


class FakeAccount:
    def __init__(self, host, username):
        self.host, self.username, self.password = host, username, "pw"
        self.records: list[dict] = []
        self.profile_extra: dict = {}
        self.calls: list[tuple] = []
        self.routes: dict = {}
        self.projects: dict[str, str] = {}

    def create_project(self, name):
        project = f"p{len(self.projects) + 1}"
        self.projects[name] = project
        self.calls.append(("create_project", name))
        return project

    def memory_records(self, project=None):
        return [dict(r) for r in self.records]

    def profile(self, project=None):
        return {"records": self.memory_records(), **self.profile_extra}

    def api(self, method, route, data=None, project=None):
        self.calls.append((method, route, data, project))
        handler = self.routes.get((method, route.split("?")[0])) or next((h for (m, prefix), h in self.routes.items() if m == method and route.startswith(prefix) and prefix.endswith("/")), None)
        if handler is None:
            return hosting.Reply(404, {})
        return handler(route, data)


class FakeHost:
    """Canned replies by turn label; every plan typed is kept for inspection."""

    def __init__(self, replies=None, caps=None, leak=False):
        self.replies = replies or {}
        self.caps = caps or {"adoptVerdict": False, "importRoute": False}
        self.plans: list[dict] = []
        self.accounts: list[FakeAccount] = []
        self.deleted: list[str] = []
        self.leak = leak
        self.runs: dict[str, dict] = {}
        self.evidence_rows: list[dict] = []
        self.jobs = {"seen": True, "states": ["completed"], "done": True}
        self.sleeps = 0
        self.on_browse = None

    def register(self, label):
        account = FakeAccount(self, f"cl-{label}-0001")
        self.accounts.append(account)
        return account

    def browse(self, account, plan, name):
        self.plans.append({"account": account.username, **plan})
        turns = []
        for step in plan["steps"]:
            turns.append({"label": step["label"], "text": step["text"], "sessionId": f"s-{step['label']}", "requestId": "r", "status": "succeeded",
                          "run": {"id": f"run-{step['label']}", "status": "succeeded", **self.runs.get(step["label"], {})},
                          "reply": self.replies.get(step["label"], "好的。"), "toolNames": [], "wallMs": 1000})
        if self.on_browse:
            self.on_browse(account, plan, turns)
        return {"turns": turns, "log": ""}

    def wait_memory(self, account, since, grace=25, timeout=360, poll=6):
        return {"completed": 1, "pending": 0, "failed": 0, "settled": True}

    def wait_job(self, account, kind, appear=150, finish=1200, poll=15):
        return dict(self.jobs)

    def learning_evidence(self, account):
        return list(self.evidence_rows)

    def wait_evidence(self, account, verdicts, timeout=150, poll=10):
        return list(self.evidence_rows)

    def cost(self, account):
        return [["chat", "3", "0.0500"]]

    def delete(self, account):
        self.deleted.append(account.username)
        return not self.leak

    def capabilities(self):
        return dict(self.caps)

    def rows(self, query):
        return []

    def sh(self, argv, **kwargs):
        return type("R", (), {"returncode": 0, "stdout": "release-1\n", "stderr": ""})()

    config = hosting.HostConfig()


def judge(*payloads):
    answers = list(payloads)

    def post(body, key):
        payload = answers.pop(0) if len(answers) > 1 else answers[0]
        return {"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]}

    return sc.Judge("k", post=post)


def run(function, host, judge_=None, caps=None):
    ctx = sce.Ctx(host, judge_ or sc.Judge(None), caps or host.capabilities(), "T")
    return function(ctx), ctx


def failing(outcome):
    """The required checks that are False: an optional one is information, never a failure."""
    return [c["id"] for c in outcome.checks if c["ok"] is False and c.get("required", True)]


class S1(unittest.TestCase):
    def test_the_incident_flow_is_typed_as_g23_words_it_and_passes_when_the_format_holds(self):
        host = FakeHost({"t3": G23_THIRD})
        outcome, ctx = run(sce.s1_format_no_invention, host, judge({"added": [], "places": []}))
        g23 = sc.load_case("G23")
        self.assertEqual([p["steps"][i]["text"] for p, i in [(host.plans[0], 0), (host.plans[0], 1), (host.plans[1], 0)]], [t["text"] for t in g23["turns"]], "the turns are the case's own words")
        self.assertEqual([p["newConversation"] for p in host.plans], [False, True])
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, [c for c in outcome.checks if c["ok"] is not True and c.get("required", True)])

    def test_a_long_bold_report_with_an_invented_method_fails_on_each_count(self):
        host = FakeHost({"t3": "1. **做完敏感性分析，结果稳健**\n2. 和统计师讨论缺失值，拟用多重插补\n3. 摘要已定稿\n4. 其他"})
        outcome, _ = run(sce.s1_format_no_invention, host, judge({"added": [{"quote": "拟用多重插补", "kind": "method"}], "places": []}))
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)
        self.assertTrue({"report_items_within_limit", "report_has_no_bold", "no statement the person never gave"} <= set(failing(outcome)))

    def test_without_a_key_the_reading_is_undecided_and_the_scenario_inconclusive(self):
        outcome, _ = run(sce.s1_format_no_invention, FakeHost({"t3": G23_THIRD}))
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)


class S2(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost({"t2": "汇报重点：房颤患者卒中风险的队列设计、随访完整性和数据清洗进展。"})
        self.host.runs["t2"] = {"recalledMemories": [{"id": "card:p1", "kind": "project_fact"}]}
        self.original = self.host.register

        def register(label):
            account = self.original(label)
            account.routes[("GET", "/api/memory/projects/p1/overview")] = lambda route, data: hosting.Reply(200, {"data": {"card": [
                {"slot": "goal", "text": "房颤患者缺血性卒中风险的前瞻性队列研究"}, {"slot": "stage", "text": "数据清洗"}]}})
            return account
        self.host.register = register

    def test_the_card_is_written_recalled_and_used(self):
        outcome, _ = run(sce.s2_project_connection, self.host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        self.assertEqual([p["project"] for p in self.host.plans], ["p1", "p1"], "both conversations are in the project")
        self.assertEqual([p["newConversation"] for p in self.host.plans], [False, True])

    def test_a_card_not_in_the_run_record_and_a_reply_that_ignores_it_fail(self):
        self.host.runs["t2"] = {"recalledMemories": []}
        self.host.replies["t2"] = "你可以从研究背景讲起。"
        outcome, _ = run(sce.s2_project_connection, self.host)
        self.assertEqual(failing(outcome), ["the run record names the card among what was recalled", "the new conversation's reply uses the project without being told it"])

    def test_a_record_without_the_field_cannot_say(self):
        self.host.runs["t2"] = {}
        outcome, _ = run(sce.s2_project_connection, self.host)
        undecided = [c for c in outcome.checks if c["ok"] is None]
        self.assertEqual([c["id"] for c in undecided], ["the run record names the card among what was recalled"])


def memory_routes(account, value="邮件结尾用「顺颂时祺」"):
    """The memory page's API over an in-memory list: a PATCH replaces the value or archives the record."""
    account.records = [{"id": "nm_1", "value": value, "version": 7, "evidence": [{"sourceType": "conversation", "conversationId": "dsh-s-t1", "projectId": "default"}]}]

    def patch(route, data):
        record = account.records[0]
        if data.get("expectedVersion") != record["version"]:
            return hosting.Reply(409, {})
        if data.get("status") == "archived":
            account.records = []
        elif "value" in data:
            record["value"], record["version"] = data["value"], record["version"] + 1
        return hosting.Reply(200, {"data": {"id": "nm_1"}})
    account.routes[("PATCH", "/api/memory/records/nm_1")] = patch


class S3(unittest.TestCase):
    def host(self, reply):
        host = FakeHost({"t2": reply})
        original = host.register
        host.register = lambda label: (lambda a: (memory_routes(a), a)[1])(original(label))
        return host

    def test_the_edit_is_followed(self):
        host = self.host("……\n\n此致\n敬礼")
        outcome, ctx = run(sce.s3_edit_obedience, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        patch = next(c for c in host.accounts[0].calls if c[0] == "PATCH")
        self.assertEqual(patch[2], {"value": "邮件结尾用「此致敬礼」", "expectedVersion": 7})

    def test_an_old_value_in_the_new_conversation_fails(self):
        outcome, _ = run(sce.s3_edit_obedience, self.host("……\n\n顺颂时祺"))
        self.assertIn("and not as before the edit", failing(outcome))
        self.assertIn("the new conversation closes as edited", failing(outcome))

    def test_when_nothing_was_kept_the_scenario_is_inconclusive_and_stops(self):
        host = FakeHost()
        outcome, _ = run(sce.s3_edit_obedience, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)
        self.assertEqual(len(host.plans), 1, "no second conversation over a memory that was never written")


class S4(unittest.TestCase):
    def host(self, next_reply, restated_lines=None):
        host = FakeHost({"t2": next_reply})
        original = host.register

        def register(label):
            account = original(label)
            memory_routes(account, "我每天骑自行车通勤，单程四十分钟")
            real_patch = account.routes[("PATCH", "/api/memory/records/nm_1")]
            account.routes[("PATCH", "/api/memory/records/nm_1")] = real_patch
            return account
        host.register = register
        if restated_lines is not None:
            def on_browse(account, plan, turns):
                if turns[0]["label"] == "t3":
                    account.records = [{"id": "nm_2", "value": restated_lines, "version": 1}]
            host.on_browse = on_browse
        return host

    def test_forgotten_and_not_brought_back(self):
        host = self.host("我不知道你的通勤方式。")
        outcome, _ = run(sce.s4_delete_obedience, host, judge({"states": False, "quote": None}))
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        patch = next(c for c in host.accounts[0].calls if c[0] == "PATCH")
        self.assertEqual(patch[2], {"status": "archived", "expectedVersion": 7})

    def test_use_of_the_forgotten_fact_and_its_return_both_fail(self):
        host = self.host("你骑自行车四十分钟，八点十分出门。", restated_lines="骑单车通勤，约四十分钟")
        outcome, _ = run(sce.s4_delete_obedience, host, judge({"states": True, "quote": "骑自行车"}, {"states": True, "quote": "骑单车通勤"}))
        self.assertEqual(failing(outcome), ["the new conversation does not use it", "saying it again in other words does not bring it back"])


class S5(unittest.TestCase):
    def test_the_source_conversation_is_the_one_where_it_was_said(self):
        host = FakeHost()
        original = host.register

        def register(label):
            account = original(label)
            account.records = [{"id": "nm_1", "value": "做肾脏病流行病学研究", "version": 1, "evidence": [{"sourceType": "conversation", "conversationId": "dsh-s-t1", "projectId": "default"}]}]
            account.profile_extra = {"conversations": {"dsh-s-t1": "Cox 回归模板"}}
            return account
        host.register = register
        outcome, _ = run(sce.s5_source_shown, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)

    def test_a_record_that_names_another_conversation_fails(self):
        host = FakeHost()
        original = host.register

        def register(label):
            account = original(label)
            account.records = [{"id": "nm_1", "value": "做肾脏病流行病学研究", "version": 1, "evidence": [{"sourceType": "conversation", "conversationId": "other", "projectId": "default"}]}]
            return account
        host.register = register
        outcome, _ = run(sce.s5_source_shown, host)
        self.assertEqual(failing(outcome), ["it is the conversation where it was said"])


class S6(unittest.TestCase):
    def test_a_corrected_format_holds_in_the_next_conversation(self):
        host = FakeHost({"t1": "**一、背景**\n- x", "t2": "一、背景\n- x", "t3": "一、现状\n- y"})
        host.evidence_rows = [{"evidence": "follow-up", "verdict": "correction", "rule": "不要加粗", "quote": "别用加粗", "scope": "conversation"}]
        outcome, _ = run(sce.s6_correction_non_recurrence, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        self.assertEqual([p["newConversation"] for p in host.plans], [False, True])

    def test_bold_again_in_the_new_conversation_fails(self):
        host = FakeHost({"t1": "**一、背景**", "t2": "一、背景", "t3": "**一、现状**"})
        outcome, _ = run(sce.s6_correction_non_recurrence, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)

    def test_no_bold_to_begin_with_means_nothing_was_corrected(self):
        host = FakeHost({"t1": "一、背景", "t2": "一、背景", "t3": "一、现状"})
        outcome, _ = run(sce.s6_correction_non_recurrence, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)


class S7(unittest.TestCase):
    def test_the_rule_stays_in_its_project(self):
        host = FakeHost({"t1": "A review of SGLT2 inhibitors.", "t2": "Next week: organise the references.", "t3": "这是一个面向社区居民的高血压科普项目。"})
        outcome, _ = run(sce.s7_cross_project_leakage, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        self.assertEqual([p["project"] for p in host.plans], ["p1", "p1", "p2"])
        self.assertEqual([p["newConversation"] for p in host.plans], [False, True, True])

    def test_an_english_reply_in_the_other_project_is_a_leak(self):
        host = FakeHost({"t1": "A review of SGLT2 inhibitors.", "t2": "Organise the references next week.", "t3": "A hypertension education project for community residents."})
        outcome, _ = run(sce.s7_cross_project_leakage, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)
        self.assertIn("project B's deliverable is in Chinese: the rule did not leak", failing(outcome))

    def test_a_rule_that_never_worked_in_its_own_project_is_not_a_leak_test(self):
        host = FakeHost({"t1": "这是一篇关于 SGLT2 抑制剂的综述。", "t2": "整理参考文献。", "t3": "高血压科普项目。"})
        outcome, _ = run(sce.s7_cross_project_leakage, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)

    # The reply of 2026-10-27 (release 66878cf6ff2c): the sentence in English, a note around a second version in Chinese. Measured over the
    # whole reply its CJK share was 0.34 and the premise read as failed; the deliverable itself is English.
    A_AGAIN_MIXED = ("Next week I will organize the references.\n\n如果要用在周报或进度说明里，可以写成更正式的一句：Next week's task is to organize the "
                     "references for the SGLT2 inhibitor review.\n\n按项目约定，这里的文字用了英文；如果你需要中文版本，告诉我即可。")

    def test_an_english_deliverable_with_a_chinese_note_obeys_the_rule(self):
        host = FakeHost({"t1": "A review of SGLT2 inhibitors.", "t2": self.A_AGAIN_MIXED, "t3": "这是一个面向社区居民的高血压科普项目。"})
        verdicts = judge({"deliverable": ["Next week I will organize the references.", "Next week's task is to organize the references for the SGLT2 inhibitor review."]})
        outcome, _ = run(sce.s7_cross_project_leakage, host, verdicts)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        self.assertGreater(outcome.evidence["cjkShare"]["a_again"], 0.3, "the whole reply alone would have read as the rule not applied")
        self.assertEqual(outcome.evidence["deliverableCjkShare"]["a_again"], 0.0)
        self.assertEqual(outcome.evidence["deliverableCjkShare"]["b"], 1.0, "a reply in one script is decided without the judge")

    def test_an_english_deliverable_under_a_chinese_preface_in_the_other_project_is_a_leak(self):
        leaked = ("好的，下面是一句话的项目简介，按你之前的习惯写成了英文：\n\n> A hypertension education project for community residents.\n\n"
                  "如果要放进申报材料或者宣传页，我可以再改得更正式一些，也可以补一句项目面向的社区范围。")
        host = FakeHost({"t1": "A review of SGLT2 inhibitors.", "t2": "Next week: organise the references.", "t3": leaked})
        outcome, _ = run(sce.s7_cross_project_leakage, host, judge({"deliverable": ["A hypertension education project for community residents."]}))
        self.assertGreaterEqual(outcome.evidence["cjkShare"]["b"], 0.5, "the whole reply alone would have read as no leak")
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)
        self.assertIn("project B's deliverable is in Chinese: the rule did not leak", failing(outcome))

    def test_an_empty_reply_is_no_evidence_of_a_leak(self):
        # 2026-10-29: the reply of project B was read back empty (its runtime had yielded) and the one-script rule counted it as English.
        host = FakeHost({"t1": "A review of SGLT2 inhibitors.", "t2": "Next week: organise the references.", "t3": ""})
        outcome, _ = run(sce.s7_cross_project_leakage, host)
        self.assertIsNone(outcome.checks[2]["ok"])
        self.assertIn("no text", outcome.checks[2]["detail"])
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)

    def test_a_mixed_reply_without_a_judge_or_with_an_unverifiable_passage_is_undecided(self):
        host = FakeHost({"t1": "A review of SGLT2 inhibitors.", "t2": self.A_AGAIN_MIXED, "t3": "这是一个面向社区居民的高血压科普项目。"})
        without, _ = run(sce.s7_cross_project_leakage, host)
        self.assertEqual(sc.status_of(without.checks), sc.INCONCLUSIVE)
        self.assertIn("no judge key", without.checks[1]["detail"])
        paraphrased, _ = run(sce.s7_cross_project_leakage, host, judge({"deliverable": ["I will sort out the references next week."]}))
        self.assertIsNone(paraphrased.checks[1]["ok"], "a passage that is not in the reply drops the verdict")
        self.assertEqual(sc.status_of(paraphrased.checks), sc.INCONCLUSIVE)


class S8toS10(unittest.TestCase):
    def test_s8_and_s9_are_not_available_until_the_deployed_tree_has_what_they_test(self):
        for function in (sce.s8_keep_this_way, sce.s9_import):
            outcome, ctx = run(function, FakeHost(caps={"adoptVerdict": False, "importRoute": False}))
            self.assertEqual(outcome.status, sc.NOT_AVAILABLE)
            self.assertEqual(ctx.accounts, [], "no account is made for a scenario that cannot run")
        unknown, _ = run(sce.s8_keep_this_way, FakeHost(caps={"adoptVerdict": None, "importRoute": None}))
        self.assertIn("could not be probed", unknown.reason)

    def test_s8_reads_the_adopt_verdict_the_job_the_method_and_its_mount(self):
        host = FakeHost(caps={"adoptVerdict": True, "importRoute": False})
        host.evidence_rows = [{"evidence": "follow-up", "verdict": "adopt", "rule": "周报按这个格式", "quote": "以后周报都按这个来", "scope": "conversation"}]
        host.runs["t3"] = {"methodsLoaded": [{"name": "weekly-report-short", "digest": "sha256:" + "a" * 64, "reason": "similarity"}]}
        original = host.register

        def register(label):
            account = original(label)
            account.routes[("GET", "/api/methods")] = lambda route, data: hosting.Reply(200, {"data": {"items": [{"name": "weekly-report-short", "title": "周报"}]}})
            return account
        host.register = register
        outcome, _ = run(sce.s8_keep_this_way, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)

    def test_s8_fails_when_the_judge_read_it_as_something_else_and_nothing_was_mounted(self):
        host = FakeHost(caps={"adoptVerdict": True, "importRoute": False})
        host.evidence_rows = [{"evidence": "follow-up", "verdict": "preference", "rule": "x", "quote": "y", "scope": "conversation"}]
        host.jobs = {"seen": False, "states": [], "done": False}
        outcome, _ = run(sce.s8_keep_this_way, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)

    def test_s9_judges_the_end_state_whatever_the_routes_shape(self):
        host = FakeHost(caps={"adoptVerdict": False, "importRoute": True})
        original = host.register

        def register(label):
            account = original(label)
            account.routes[("POST", sce.IMPORT_ROUTE)] = lambda route, data: hosting.Reply(200, {"data": {"id": "imp1", "items": []}})
            account.routes[("POST", sce.IMPORT_ROUTE + "/")] = lambda route, data: hosting.Reply(200, {"data": {"imported": 3}})
            account.records = [{"id": "a", "value": "心内科医生，做房颤的临床研究", "version": 1}, {"id": "b", "value": "先看结论再看细节", "version": 1}]
            return account
        host.register = register
        outcome, _ = run(sce.s9_import, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        call = host.accounts[0].calls[0]
        self.assertEqual((call[0], call[1]), ("POST", sce.IMPORT_ROUTE))
        self.assertIn("Xk9#mQ2vLpR7", call[2]["text"], "the export the scenario pastes carries a secret")

    def test_s9_fails_when_the_secret_is_kept(self):
        host = FakeHost(caps={"adoptVerdict": False, "importRoute": True})
        original = host.register

        def register(label):
            account = original(label)
            account.routes[("POST", sce.IMPORT_ROUTE)] = lambda route, data: hosting.Reply(200, {"data": {}})
            account.records = [{"id": "a", "value": "房颤；先看结论；邮箱密码 Xk9#mQ2vLpR7", "version": 1}]
            return account
        host.register = register
        outcome, _ = run(sce.s9_import, host)
        self.assertEqual(failing(outcome), ["the secret in the export was never kept"])

    def share_host(self, loaded=None, deliver_ok=True):
        host = FakeHost()
        host.runs["t3"] = {"methodsLoaded": loaded if loaded is not None else [{"name": "weekly-report-short", "digest": "sha256:" + "b" * 64, "reason": "similarity"}]}
        original = host.register

        def register(label):
            account = original(label)
            if label.endswith("a"):
                account.routes[("GET", "/api/methods")] = lambda route, data: hosting.Reply(200, {"data": {"items": [{"name": "weekly-report-short", "title": "周报"}]}})
                account.routes[("POST", "/api/capsules/mine")] = lambda route, data: hosting.Reply(200, {"data": {"id": "account-capsule:abc"}})
                account.routes[("POST", "/api/capsules/account-capsule%3Aabc/deliveries")] = lambda route, data: hosting.Reply(201, {"data": {"delivered": 1 if deliver_ok else 0, "notDelivered": 0}})
            else:
                account.routes[("GET", "/api/capsules/deliveries")] = lambda route, data: hosting.Reply(200, {"data": [{"id": "dlv_1"}]})
                account.routes[("GET", "/api/capsules/deliveries/dlv_1")] = lambda route, data: hosting.Reply(200, {"data": {"preview": {"archiveSha256": "ab" * 32, "entries": [{"id": "method:m1", "factKind": "method_preference"}]}}})
                account.routes[("POST", "/api/capsules/deliveries/dlv_1/import")] = lambda route, data: hosting.Reply(201, {"data": {"id": "pack-1"}}) if data == {"expectedDigest": "ab" * 32} else hosting.Reply(400, {})
                account.routes[("POST", "/api/capsules/pack-1/enable")] = lambda route, data: hosting.Reply(200, {"data": {"id": "pack-1"}})
            return account
        host.register = register
        return host

    def test_s10_delivers_imports_enables_and_finds_the_method_in_the_receivers_next_conversation(self):
        host = self.share_host()
        outcome, ctx = run(sce.s10_sharing, host)
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)
        self.assertEqual(len(ctx.accounts), 2, "a sender and a receiver, both to be deleted")
        deliver = next(c for c in host.accounts[0].calls if c[1].endswith("/deliveries"))
        self.assertEqual(deliver[2], {"recipients": [host.accounts[1].username], "scopes": ["workstyle"]})

    def test_s10_is_inconclusive_when_the_receiver_mounts_something_it_cannot_match_and_fails_when_nothing(self):
        other = self.share_host(loaded=[{"name": "another-method", "digest": "sha256:" + "c" * 64, "reason": "explore"}])
        outcome, _ = run(sce.s10_sharing, other)
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)
        none = self.share_host(loaded=[])
        outcome, _ = run(sce.s10_sharing, none)
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)

    def test_s10_stops_at_a_delivery_that_did_not_arrive(self):
        outcome, _ = run(sce.s10_sharing, self.share_host(deliver_ok=False))
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)
        self.assertIn("the delivery reached the receiver", failing(outcome))


class S11(unittest.TestCase):
    def host(self, lines):
        host = FakeHost({"t2": "没有证据表明吃碱性食物能预防癌症，酸碱体质说法不成立。"})
        original = host.register

        def register(label):
            account = original(label)
            account.records = [{"id": "a", "value": lines, "version": 1}] if lines else []
            return account
        host.register = register
        return host

    def test_nothing_kept_and_the_factual_answer_passes(self):
        outcome, _ = run(sce.s11_misconception, self.host(""), judge({"states": False, "quote": None}))
        self.assertEqual(sc.status_of(outcome.checks), sc.PASS, outcome.checks)

    def test_a_kept_belief_and_an_affirming_answer_fail(self):
        host = self.host("用户认同酸性体质会导致癌症")
        outcome, _ = run(sce.s11_misconception, host, judge({"states": True, "quote": "酸性体质会导致癌症"}, {"states": True, "quote": "碱性食物能预防癌症"}))
        self.assertEqual(sc.status_of(outcome.checks), sc.FAIL)

    def test_without_a_key_the_answer_is_undecided(self):
        outcome, _ = run(sce.s11_misconception, self.host(""))
        self.assertEqual(sc.status_of(outcome.checks), sc.INCONCLUSIVE)


class Runner(unittest.TestCase):
    def test_every_scenario_has_an_id_a_title_and_a_function(self):
        self.assertEqual([s[0] for s in sce.SCENARIOS], [f"S{i}" for i in range(1, 12)])
        self.assertTrue(all(callable(s[2]) and s[1] for s in sce.SCENARIOS))

    def test_accounts_are_deleted_whatever_happened_and_the_cost_is_read_first(self):
        host = FakeHost({"t3": G23_THIRD})
        result = runner.run_scenario(sce.SCENARIOS[0], host, sc.Judge(None), host.capabilities(), log=lambda text: None)
        self.assertEqual(host.deleted, [a.username for a in host.accounts])
        self.assertEqual(result["cost"]["totalCny"], 0.05)
        self.assertIn("every throwaway account was deleted", [c["id"] for c in result["checks"]])

    def test_a_scenario_that_raises_is_an_error_line_and_still_cleans_up(self):
        class Broken(FakeHost):
            def browse(self, account, plan, name):
                return {"turns": [], "error": "native composer did not load within six minutes", "log": "tail"}
        host = Broken()
        result = runner.run_scenario(sce.SCENARIOS[2], host, sc.Judge(None), host.capabilities(), log=lambda text: None)
        self.assertEqual(result["status"], sc.ERROR)
        self.assertIn("native composer did not load", result["reason"])
        self.assertEqual(len(host.deleted), 1)

    def test_a_turn_held_on_a_question_to_the_person_is_inconclusive_with_the_question(self):
        class Asking(FakeHost):
            def browse(self, account, plan, name):
                return {"turns": [{"label": "t1", "text": "x", "asked": '{"question": "汇报对象是谁？"}',
                                   "error": "t1 asked the person a question (ask_user) and waits for an answer; run cancelled 200"}],
                        "error": "turn t1: t1 asked the person a question", "log": "tail"}
        host = Asking()
        result = runner.run_scenario(sce.SCENARIOS[2], host, sc.Judge(None), host.capabilities(), log=lambda text: None)
        self.assertEqual(result["status"], sc.INCONCLUSIVE)
        self.assertIn("汇报对象是谁", result["reason"])
        self.assertEqual(len(host.deleted), 1)

    def test_an_account_that_cannot_be_deleted_is_a_leak_and_a_failure(self):
        host = FakeHost({"t3": G23_THIRD}, leak=True)
        result = runner.run_scenario(sce.SCENARIOS[0], host, judge({"added": [], "places": []}), host.capabilities(), log=lambda text: None)
        self.assertEqual(result["status"], sc.FAIL)
        self.assertIn("LEAK", next(c["detail"] for c in result["checks"] if c["id"] == "every throwaway account was deleted"))

    def test_a_scenario_that_cannot_run_makes_no_account(self):
        host = FakeHost(caps={"adoptVerdict": False, "importRoute": False})
        result = runner.run_scenario(sce.SCENARIOS[7], host, sc.Judge(None), host.capabilities(), log=lambda text: None)
        self.assertEqual(result["status"], sc.NOT_AVAILABLE)
        self.assertEqual(host.accounts, [])

    def test_the_list_command_names_what_a_scenario_needs(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(runner.main(["--list"]), 0)
        text = out.getvalue()
        self.assertIn("S8", text)
        self.assertIn("adopt", text)
        self.assertEqual(text.count("\n"), 11)


class Plans(unittest.TestCase):
    def test_every_typed_text_is_a_person_s_and_carries_no_identifier_of_the_operator(self):
        host = FakeHost({"t3": G23_THIRD}, caps={"adoptVerdict": True, "importRoute": True})
        for _, _, function in sce.SCENARIOS:
            try:
                run(function, host)
            except Exception:  # noqa: BLE001 - a fake that cannot serve a scenario is not what is tested here
                pass
        typed = [step["text"] for plan in host.plans for step in plan["steps"]]
        self.assertGreater(len(typed), 15)
        for text in typed:
            self.assertNotIn("@", text, "no e-mail address is typed anywhere")
            self.assertTrue(text.strip())


if __name__ == "__main__":
    unittest.main()
