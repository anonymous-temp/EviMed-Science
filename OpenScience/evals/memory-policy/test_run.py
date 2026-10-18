"""Offline tests of the memory-policy runner: the case file, the scoring, the settle loop and one whole run against a fake server.

  python3 -m unittest discover -s evals/memory-policy -p 'test_*.py'
"""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("memory_policy_run", os.path.join(HERE, "run.py"))
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)

with open(os.path.join(HERE, "cases.json"), encoding="utf-8") as handle:
    DOCUMENT = json.load(handle)
CASES = {case["id"]: case for case in DOCUMENT["cases"]}
PROJECTS = {"A": "prj_a", "B": "prj_b"}


def view(records=(), cards=None):
    snapshot = {"records": list(records), "cards": cards or {}}
    return run.build_view(snapshot, PROJECTS)


def record(text, scope="user", scope_id="", kind="preference", status="active", **fields):
    return {"id": "r" + str(abs(hash(text)) % 10000), "kind": kind, "scope": scope, "scopeId": scope_id, "status": status, "key": "k", "summary": text, "value": "", **fields}


class CaseFile(unittest.TestCase):
    def test_the_file_is_sound(self):
        self.assertEqual(run.check_cases(DOCUMENT), [])

    def test_it_asks_for_what_the_brief_asks_for(self):
        cases = DOCUMENT["cases"]
        self.assertGreaterEqual(len(cases), 30)
        by_family = {}
        for case in cases:
            by_family.setdefault(case["family"], []).append(case)
        self.assertEqual(set(by_family), set(run.FAMILIES))
        general = [case for case in cases if case["domain"] == "general"]
        medical = [case for case in cases if case["domain"] == "medical"]
        self.assertGreater(len(general), len(medical))
        # general first: the first case of the file is not a medical one, and the programmer, teacher and product manager are there
        self.assertEqual(cases[0]["domain"], "general")
        personas = {case.get("persona") for case in cases}
        self.assertTrue({"程序员", "教师", "产品经理", "研究者"} <= personas)
        # the named incidents
        text = json.dumps(cases, ensure_ascii=False)
        for needle in ("记住我对青霉素过敏", "我对青霉素过敏，术后抗生素怎么选？", "更正", "忘掉", "每个工作日早上汇总", "患者张某", "身份证号"):
            self.assertIn(needle, text)
        tasks = by_family["task"]
        self.assertEqual({case["task"]["taskType"] for case in tasks}, {"routine", "literature-sentinel"})
        self.assertTrue(all(case["task"]["runs"] >= 2 for case in tasks), "run it twice")
        self.assertTrue(any(case.get("group") == "B" for case in cases), "the literal allergy pair needs a second account")

    def test_a_broken_file_is_named(self):
        broken = {"cases": [{"id": "X", "family": "wish", "domain": "general", "turns": [{"say": " "}], "checks": {}}]}
        problems = " | ".join(run.check_cases(broken))
        for needle in ("floor", "family 'wish'", "an empty turn", "no check"):
            self.assertIn(needle, problems)


class Scoring(unittest.TestCase):
    def test_normal_form_ignores_spacing_case_and_width(self):
        self.assertEqual(run.norm("  Snake_Case  变量 名"), "snake_case变量名")
        self.assertEqual(run.norm("ＰｏｓｔｇｒｅＳＱＬ １４"), "postgresql14")

    def test_keep_needs_one_of_each_group_in_the_place_it_names(self):
        case = CASES["K05-teacher-profile-and-format"]
        kept = view([record("练习题分基础、提高、拓展三档，答案放最后一页"), record("初中数学老师，教七年级", kind="profile")])
        self.assertTrue(run.score_case(case, kept)["passed"])
        half = run.score_case(case, view([record("练习题分基础、提高、拓展三档")]))
        self.assertFalse(half["passed"])
        self.assertIn("数学", half["failures"][0])
        # where=user: a project memory is not the profile
        allergy = CASES["K13-explicit-remember-allergy"]
        self.assertTrue(run.score_case(allergy, view([record("对青霉素过敏", kind="profile")]))["passed"])
        self.assertFalse(run.score_case(allergy, view([record("对青霉素过敏", scope="project", scope_id="prj_a", kind="project_fact")]))["passed"])

    def test_a_latin_term_is_a_whole_word_and_a_key_is_not_read(self):
        # Production's legacy run, 2026-10-18: K02 and K03 passed on "Go" inside the key `project.goal` and inside "Django".
        case = CASES["K02-programmer-profile"]
        self.assertFalse(run.score_case(case, view([record("学校选课系统用 Django", key="profile.goal")]))["passed"])
        self.assertTrue(run.score_case(case, view([record("主要写 Go 和 PostgreSQL", kind="profile")]))["passed"])
        self.assertTrue(run.score_case(case, view([record("Writes Go and SQL", kind="profile")]))["passed"])
        self.assertTrue(run.score_case(CASES["K01-programmer-code-style"], view([record("变量名用snake_case")]))["passed"], "beside Chinese is a word boundary")
        self.assertFalse(run.score_case(CASES["K04-programmer-decision"], view([record("Kafkaesque", scope="project", scope_id="prj_a")]))["passed"])

    def test_a_persons_statement_is_looked_for_in_the_persons_memory(self):
        # 后端 on some project's card (S01's gateway) is not K02's profile.
        case = CASES["K02-programmer-profile"]
        self.assertFalse(run.score_case(case, view([], cards={"A": [{"text": "后端架构、网关"}]}))["passed"])
        self.assertFalse(run.score_case(case, view([record("后端架构", scope="project", scope_id="prj_a", kind="project_fact")]))["passed"])
        self.assertFalse(run.score_case(CASES["K08-teacher-project"], view([record("学校的选课系统用 Django")]))["passed"], "and a project's fact is in its project")

    def test_only_what_is_in_force_counts(self):
        case = CASES["N01-secret-in-passing"]
        self.assertTrue(run.score_case(case, view([record("数据库密码 Xk9#mPq2Lz", status="archived")]))["passed"], "a forgotten memory is not kept")
        self.assertFalse(run.score_case(case, view([record("数据库密码 Xk9#mPq2Lz")]))["passed"])
        self.assertFalse(run.score_case(case, view([], cards={"A": [{"text": "密码是 Xk9#mPq2Lz"}]}))["passed"], "a project card is memory too")

    def test_an_episode_counts_only_where_the_case_says_so(self):
        episode = record("{\"question\":\"我的数据库密码是 Xk9#mPq2Lz\"}", kind="run_summary", scope="project", scope_id="prj_a")
        self.assertFalse(run.score_case(CASES["N01-secret-in-passing"], view([episode]))["passed"], "the stored episode must not hold a secret")
        mood = CASES["N07-mood"]
        self.assertTrue(run.score_case(mood, view([record("{\"question\":\"今天好累，什么都不想干\"}", kind="run_summary")]))["passed"],
                        "a mood in the question is no durable memory")
        self.assertFalse(run.score_case(mood, view([record("用户今天好累")]))["passed"])

    def test_a_correction_replaces_and_does_not_sit_beside(self):
        case = CASES["C01-correction-replaces-preference"]
        self.assertTrue(run.score_case(case, view([record("代码注释改用中文，不用英文")]))["passed"])
        stale = run.score_case(case, view([record("代码注释一律用英文"), record("代码注释用中文")]))
        self.assertFalse(stale["passed"])
        self.assertIn("英文", stale["failures"][0])
        self.assertFalse(run.score_case(case, view([record("代码注释一律用英文")]))["passed"], "and the new value must be there")
        db = CASES["C02-correction-replaces-project-fact"]
        self.assertTrue(run.score_case(db, view([record("主库从 MySQL 改为 PostgreSQL", scope="project", scope_id="prj_a")]))["passed"])
        self.assertFalse(run.score_case(db, view([record("主库 MySQL"), record("主库 PostgreSQL")]))["passed"])

    def test_forgotten_means_not_in_force_even_when_said_again(self):
        case = CASES["F01-forget-then-mentioned-in-passing"]
        self.assertTrue(run.score_case(case, view([record("报告加风险提示小节", status="archived")]))["passed"])
        self.assertFalse(run.score_case(case, view([record("周报习惯放风险提示小节")]))["passed"])

    def test_a_project_fact_stays_in_its_project(self):
        case = CASES["S01-project-fact-stays-in-its-project"]
        home = record("网关用 Rust 重写", scope="project", scope_id="prj_a", kind="project_fact")
        self.assertTrue(run.score_case(case, view([home]))["passed"])
        leaked_to_b = run.score_case(case, view([home, record("网关用 Rust", scope="project", scope_id="prj_b", kind="project_fact")]))
        self.assertFalse(leaked_to_b["passed"])
        self.assertIn("project:B", leaked_to_b["failures"][0])
        self.assertFalse(run.score_case(case, view([home, record("喜欢 Rust")]))["passed"], "nor in the profile")
        self.assertFalse(run.score_case(case, view([record("网关用 Rust")]))["passed"], "and not the profile instead of the project")
        self.assertTrue(run.score_case(case, view([], cards={"A": [{"text": "技术选型：Rust"}]}))["passed"], "a card counts as the project's memory")

    def test_every_check_kind_reads_the_view(self):
        case = {"id": "X", "project": "A", "checks": {"neverPattern": ["第\\d+条"], "neverIn": {"user": ["秘密"]}}}
        self.assertTrue(run.score_case(case, view([record("没有数字")]))["passed"])
        self.assertFalse(run.score_case(case, view([record("第3条规则")]))["passed"])
        self.assertFalse(run.score_case(case, view([record("一个秘密")]))["passed"])

    def test_keeps_met_is_what_the_settle_loop_waits_for(self):
        case = CASES["K01-programmer-code-style"]
        self.assertFalse(run.keeps_met(case, view()))
        self.assertTrue(run.keeps_met(case, view([record("变量名用 snake_case")])))
        self.assertTrue(run.keeps_met(CASES["N01-secret-in-passing"], view()), "a never case waits for nothing")


class Settling(unittest.TestCase):
    def fake(self, snapshots, unmet_for):
        state = {"now": 0, "polls": 0}
        sequence = iter(snapshots)

        def clock():
            return state["now"]

        def sleep(seconds):
            state["now"] += seconds

        def snapshot():
            state["polls"] += 1
            return next(sequence)

        return state, clock, sleep, snapshot, unmet_for

    def test_stable_and_complete_stops_after_the_minimum(self):
        state, clock, sleep, snapshot, unmet = self.fake([{"n": 1}] * 40, lambda s: 0)
        _, reason, waited = run.wait_until_settled(snapshot, unmet, poll=30, min_settle=180, max_settle=900, stable_polls=3, clock=clock, sleep=sleep)
        self.assertEqual(reason, "settled")
        self.assertGreaterEqual(waited, 180)
        self.assertLess(waited, 900)

    def test_a_slow_writer_is_waited_for_and_a_late_one_resets_the_stability(self):
        snaps = [{"n": 0}] * 3 + [{"n": 1}] * 2 + [{"n": 2}] * 40
        state, clock, sleep, snapshot, _ = self.fake(snaps, None)
        _, reason, waited = run.wait_until_settled(snapshot, lambda s: 0 if s["n"] >= 1 else 1, poll=30, min_settle=0, max_settle=900, stable_polls=3, clock=clock, sleep=sleep)
        self.assertEqual(reason, "settled")
        self.assertGreater(state["polls"], 6, "the change at poll 6 restarted the count")

    def test_a_keep_that_never_comes_ends_at_the_deadline(self):
        state, clock, sleep, snapshot, _ = self.fake([{"n": 1}] * 200, None)
        _, reason, waited = run.wait_until_settled(snapshot, lambda s: 1, poll=30, min_settle=0, max_settle=900, stable_polls=3, clock=clock, sleep=sleep)
        self.assertEqual(reason, "deadline")
        self.assertGreaterEqual(waited, 900)


class FakeServer:
    """The routes the runner uses, in memory, with a memory that a conversation writes to after a delay."""

    def __init__(self, base, insecure=False):
        self.base, self.csrf, self.project = base, None, None
        self.calls, self.projects, self.users, self.records, self.runs, self.deleted = [], {}, {}, [], {}, []
        FakeServer.last = self

    def call(self, route, data=None, method=None, timeout=300, tolerate=False, project=None):
        self.calls.append((method or ("POST" if data is not None else "GET"), route.split("?")[0], project))
        path = route.split("?")[0]
        if path == "/api/auth/register":
            self.users[data["username"]] = data["password"]
            return {}
        if path == "/api/auth/login":
            return {}
        if path == "/api/me":
            return {"data": {"csrfToken": "t", "user": {"id": "usr_1"}}}
        if path == "/api/ready":
            return {"data": {"release": "test"}}
        if path == "/api/projects" and data:
            pid = f"prj_{len(self.projects) + 1}"
            self.projects[pid] = data["name"]
            return {"data": {"id": pid}}
        if path.startswith("/api/projects/") and method == "DELETE":
            self.deleted.append(path)
            return {}
        if path == "/api/account" and method == "DELETE":
            self.deleted.append(path)
            return {}
        if path == "/api/runtime/sessions":
            return {"data": {"id": f"ses_{len(self.runs) + 1}"}}
        if path.startswith("/api/research-sessions/"):
            return {}
        if path == "/api/agent-runs/dispatch":
            rid = f"run_{len(self.runs) + 1}"
            self.runs[rid] = data["text"]
            # what a conversation leaves behind, for the cases that say something to keep
            for needle, text in (("snake_case", "代码注释用英文，变量名用 snake_case"), ("Xk9", "数据库密码 Xk9#mPq2Lz")):
                if needle in data["text"] and needle == "snake_case":
                    self.records.append({"id": rid, "kind": "preference", "scope": "user", "scopeId": "", "status": "active", "key": "k", "summary": text, "value": ""})
            return {"data": {"id": rid}}
        if path == "/api/agent-runs":
            return {"data": [{"id": rid, "status": "succeeded", "effectiveRouteReason": "matched", "effectiveAgentId": "open-domain-answer"} for rid in self.runs]}
        if path == "/api/memory/profile":
            return {"data": {"engine": None, "records": self.records}}
        if path.endswith("/overview"):
            return {"data": {"card": []}}
        if path == "/api/autopilot/agendas":
            return {"error": "404 scheduled tasks are not deployed here"} if tolerate else (_ for _ in ()).throw(RuntimeError("404"))
        raise AssertionError(f"unexpected route {method} {route}")


class WholeRun(unittest.TestCase):
    def test_a_run_against_a_fake_server_scores_writes_and_cleans_up_without_leaking_the_password(self):
        original_api, original_sleep = run.Api, run.time.sleep
        run.Api, run.time.sleep = FakeServer, lambda seconds: None
        try:
            with tempfile.TemporaryDirectory() as out:
                args = run.parse(["--base-url", "http://fake", "--out-dir", out, "--only", "K01", "N01", "T01", "--min-settle", "0", "--settle", "60", "--poll", "1", "--stable-polls", "1"])
                lines = []
                report = run.run(args, log=lines.append)
                server = FakeServer.last
                rows = {row["id"]: row for row in report["cases"]}
                self.assertEqual(rows["K01-programmer-code-style"]["result"], "pass")
                self.assertEqual(rows["N01-secret-in-passing"]["result"], "pass")
                self.assertEqual(rows["T01-routine-task-instruction"]["result"], "skipped", "a deployment without scheduled tasks skips them, it does not fail them")
                self.assertEqual((report["scored"], report["passed"]), (2, 2))
                self.assertEqual(report["engine"], "legacy")
                self.assertEqual(report["settle"]["reason"], "settled")
                # separate conversations, one per case, and every project and the account deleted afterwards
                self.assertEqual(len([call for call in server.calls if call[1] == "/api/runtime/sessions"]), 2)
                self.assertTrue(server.deleted[-1] == "/api/account" and any(item.startswith("/api/projects/") for item in server.deleted))
                self.assertIn("account deleted", report["cleanup"])
                # outputs are written, and neither the password nor a cookie is in anything the runner prints or writes
                password = list(server.users.values())[0]
                written = "".join(open(os.path.join(out, name), encoding="utf-8").read() for name in os.listdir(out))
                self.assertEqual(sorted(os.listdir(out)), ["memory-policy-legacy-A.json", "memory-policy-legacy-A.md"])
                self.assertNotIn(password, written + "\n".join(lines))
                self.assertIn("| K01-programmer-code-style | keep | general | pass |", written)
        finally:
            run.Api, run.time.sleep = original_api, original_sleep

    def test_the_failure_of_a_case_is_reported_not_raised(self):
        original_api, original_sleep = run.Api, run.time.sleep

        class Broken(FakeServer):
            def call(self, route, *args, **kwargs):
                if route == "/api/agent-runs/dispatch":
                    raise RuntimeError("500 dispatch")
                return super().call(route, *args, **kwargs)

        run.Api, run.time.sleep = Broken, lambda seconds: None
        try:
            with tempfile.TemporaryDirectory() as out:
                args = run.parse(["--base-url", "http://fake", "--out-dir", out, "--only", "K01", "--min-settle", "0", "--settle", "5", "--poll", "1", "--stable-polls", "1"])
                report = run.run(args, log=lambda line: None)
                self.assertEqual(report["cases"][0]["result"], "skipped")
                self.assertIn("could not be run", report["cases"][0]["failures"][0])
                self.assertIn("account deleted", report["cleanup"])
        finally:
            run.Api, run.time.sleep = original_api, original_sleep

    def test_the_arguments_need_a_base_url_and_a_password_file_for_an_existing_account(self):
        with self.assertRaises(SystemExit):
            run.parse([])
        with self.assertRaises(SystemExit):
            run.parse(["--base-url", "http://x", "--account", "someone"])
        self.assertEqual(run.parse(["--cases-only"]).cases_only, True)
        self.assertEqual(run.main(["--cases-only"]), 0)


if __name__ == "__main__":
    unittest.main()
