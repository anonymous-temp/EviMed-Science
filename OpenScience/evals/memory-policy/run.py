#!/usr/bin/env python3
"""Memory policy evaluation: what the platform keeps and what it never keeps, read from the memory it shows afterwards.

A throwaway self-registered account says the turns of `cases.json` (keep, never keep, correct, forget, scope, a scheduled task's
instruction) in separate conversations, waits until the memory has settled, reads it back through the memory page's own API
(`/api/memory/profile` and each project's `/api/memory/projects/<id>/overview`) and scores every case. Every check is a substring
or a pattern over that text, never a model's judgement, and the statements are invented. Projects and account are deleted at
the end. The password and the session cookie are never printed or written.

  python3 run.py --base-url https://host --out-dir /tmp/memory-policy                  # the account's default engine
  python3 run.py --base-url ... --engine native --engine-ready-file /tmp/ready          # wait for the controller to move it
  python3 run.py --base-url ... --account NAME --password-file FILE [--delete-account]  # an existing throwaway account
  python3 run.py --cases-only                                                           # check the case file, touch nothing

`--engine native|legacy`: the controller moves an account between engines (`scripts/ops/memory-engine.mjs`), so the runner
registers the account, prints `ENGINE-WAIT <engine> <account>` and waits for `--engine-ready-file` to exist (up to
`--engine-wait` seconds) before the first case. `--group B` runs the cases that cannot share an account with the default group.
The native engine extracts minutes after a conversation ends: scoring waits until every keep is found and the memory has been
unchanged for `--stable-polls` polls, but at least `--min-settle` and at most `--settle` seconds after the last case.
Writes `memory-policy-<engine>.json` and `.md` to `--out-dir`; the exit status is 0 when every scored case passed.
"""
import argparse
import http.cookiejar
import json
import os
import re
import secrets
import ssl
import sys
import time

THROWAWAY_ACCOUNT = re.compile(r"mempol-[0-9a-f]{8}")
import unicodedata
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FAMILIES = ("keep", "never", "correct", "forget", "scope", "task")
RUNNING = {"running", "queued", "planned", "dispatching", "starting", "waiting", "pending", "scheduled", "dispatched", "verifying"}


# ---------------------------------------------------------------------------------------------------------------- scoring
def norm(text):
    """The comparison form: NFKC, lower case, no white space, so a paraphrase's spacing and full-width forms do not matter."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text or ""))).lower()


def spaced(text):
    """NFKC and lower case with the white space kept (collapsed): the form a whole-word match reads."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(text or ""))).strip().lower()


# A term written in Latin letters and digits only ("Go", "SaaS", "Kafka") is a word, and is found only as a word: "Go" is not in
# "Django", "MongoDB" or "goal". Production's legacy run of 2026-10-18 passed K02 and K03 on exactly that.
ASCII_WORD = re.compile(r"[0-9a-z_]+")


def is_active(record):
    return str(record.get("status") or "active") == "active"


def record_text(record):
    """What a person reads of a record: its summary and its value. The key is a machine identifier and is not read."""
    return "\n".join(str(record.get(field) or "") for field in ("summary", "value"))


def entry(text):
    return {"text": norm(text), "words": spaced(text)}


def mentions(item, term):
    """Whether one text of the view mentions a term: a Latin word as a whole word, anything else as a substring."""
    flat = norm(term)
    if ASCII_WORD.fullmatch(flat):
        return re.search(r"(?<![0-9a-z_])" + re.escape(spaced(term)) + r"(?![0-9a-z_])", item["words"]) is not None
    return flat in item["text"]


def build_view(snapshot, projects):
    """What the memory page shows, as texts: active durable records (scope, project), project cards, episodes.

    `snapshot` is `{"records": [...], "cards": {label: [slot, ...]}}`; `projects` maps a project label to its id.
    """
    ids = {value: key for key, value in projects.items()}
    durable, episodes = [], []
    for record in snapshot.get("records") or []:
        if str(record.get("kind")) == "run_summary":
            episodes.append(entry(record_text(record)))
            continue
        if not is_active(record):
            continue
        scope_id = str(record.get("scopeId") or "")
        durable.append({"scope": str(record.get("scope") or ""), "project": ids.get(scope_id), **entry(record_text(record))})
    cards = {label: [entry(slot.get("text")) for slot in slots or []] for label, slots in (snapshot.get("cards") or {}).items()}
    return {"durable": durable, "cards": cards, "episodes": episodes}


def text_in(view, where, case_project="A"):
    """The texts a check looks in: `any`, `user`, `project` (the case's own) or `project:<label>`."""
    if where in ("any", None, ""):
        return list(view["durable"]) + [item for cards in view["cards"].values() for item in cards]
    if where == "user":
        return [item for item in view["durable"] if item["scope"] == "user"]
    label = case_project if where == "project" else where.split(":", 1)[1]
    return [item for item in view["durable"] if item["scope"] == "project" and item["project"] == label] + list(view["cards"].get(label, []))


def score_case(case, view):
    """`{"passed": bool, "failures": [str]}` for one case against the memory view. Pure; the runner and the tests share it."""
    checks = case.get("checks") or {}
    failures = []
    project = case.get("project", "A")
    for group in checks.get("keep") or []:
        if not any(any(mentions(item, term) for term in group["any"]) for item in text_in(view, group.get("in", "any"), project)):
            failures.append(f"nothing kept mentions any of {group['any']} (in {group.get('in', 'any')})")
    everywhere = text_in(view, "any")
    for term in checks.get("never") or []:
        if any(mentions(item, term) for item in everywhere):
            failures.append(f"a kept memory carries {term!r}")
    for term in checks.get("neverEpisode") or []:
        if any(mentions(item, term) for item in everywhere + view["episodes"]):
            failures.append(f"a kept memory or a conversation's stored episode carries {term!r}")
    for pattern in checks.get("neverPattern") or []:
        if any(re.search(pattern, item["text"]) for item in everywhere):
            failures.append(f"a kept memory matches {pattern!r}")
    for rule in checks.get("neverUnless") or []:
        for item in everywhere:
            if mentions(item, rule["term"]) and not any(mentions(item, other) for other in rule["unless"]):
                failures.append(f"a kept memory still carries {rule['term']!r} without {rule['unless']}")
                break
    for where, terms in (checks.get("neverIn") or {}).items():
        for term in terms:
            if any(mentions(item, term) for item in text_in(view, where, project)):
                failures.append(f"{where} carries {term!r}")
    return {"passed": not failures, "failures": failures}


def keeps_met(case, view):
    """Whether every keep of the case is already in the memory (the settle loop waits for these)."""
    project = case.get("project", "A")
    for group in (case.get("checks") or {}).get("keep") or []:
        if not any(any(mentions(item, term) for term in group["any"]) for item in text_in(view, group.get("in", "any"), project)):
            return False
    return True


def check_cases(document):
    """The problems of a case file, as strings (empty when it is sound): ids, families, turns, checks, Chinese, general first."""
    problems, seen = [], set()
    cases = document.get("cases") or []
    if len(cases) < 30:
        problems.append(f"only {len(cases)} cases, 30 are the floor")
    for case in cases:
        name = case.get("id", "?")
        if name in seen:
            problems.append(f"{name}: duplicate id")
        seen.add(name)
        if case.get("family") not in FAMILIES:
            problems.append(f"{name}: family {case.get('family')!r}")
        if case.get("domain") not in ("general", "medical"):
            problems.append(f"{name}: domain {case.get('domain')!r}")
        if bool(case.get("turns")) == bool(case.get("task")):
            problems.append(f"{name}: needs turns or a task, not both")
        for turn in case.get("turns") or []:
            if not str(turn.get("say") or "").strip():
                problems.append(f"{name}: an empty turn")
        checks = case.get("checks") or {}
        if not any(checks.get(key) for key in ("keep", "never", "neverEpisode", "neverPattern", "neverUnless", "neverIn")):
            problems.append(f"{name}: no check")
        for rule in checks.get("neverUnless") or []:
            if not rule.get("term") or not rule.get("unless"):
                problems.append(f"{name}: a neverUnless rule needs term and unless")
        for pattern in checks.get("neverPattern") or []:
            try:
                re.compile(pattern)
            except re.error as error:
                problems.append(f"{name}: pattern {pattern!r}: {error}")
        if case.get("family") in ("keep", "correct", "scope") and not any(checks.get("keep") or []):
            problems.append(f"{name}: a {case.get('family')} case needs a keep")
        if case.get("family") == "never" and not (checks.get("never") or checks.get("neverEpisode")):
            problems.append(f"{name}: a never case needs a never")
    chinese = sum(1 for case in cases if any(re.search(r"[一-鿿]", str(t.get("say"))) for t in case.get("turns") or []) or case.get("task"))
    if chinese < len(cases) - 2:
        problems.append("the cases are written in Chinese (one or two may be English)")
    general = [c for c in cases if c.get("domain") == "general"]
    medical = [c for c in cases if c.get("domain") == "medical"]
    if not general or not medical or len(general) <= len(medical):
        problems.append("general cases come first and outnumber the medical controls")
    families = {case.get("family") for case in cases}
    for family in FAMILIES:
        if family not in families:
            problems.append(f"no {family} case")
    return problems


def wait_until_settled(snapshot, unmet, *, poll, min_settle, max_settle, stable_polls, clock=time.monotonic, sleep=time.sleep):
    """Poll the memory until it is final enough to score. Returns `(snapshot, reason, waited_seconds)`.

    Final enough: every keep is found and the snapshot has not changed for `stable_polls` polls, and at least `min_settle`
    seconds have passed (a slow writer gets its chance to write what should not be there). Otherwise `max_settle` ends it.
    """
    started = clock()
    last, same = None, 0
    while True:
        current = snapshot()
        signature = json.dumps(current, sort_keys=True, ensure_ascii=False)
        same = same + 1 if signature == last else 0
        last = signature
        waited = clock() - started
        if unmet(current) == 0 and same >= stable_polls and waited >= min_settle:
            return current, "settled", waited
        if waited >= max_settle:
            return current, "deadline" if unmet(current) else "settled-at-deadline", waited
        sleep(poll)


def markdown(report):
    lines = [f"# Memory policy — {report['engine']} — {report['finishedAt']}", "",
             f"base {report['baseUrl']} · release {report.get('release') or '?'} · group {report['group']} · "
             f"{report['passed']}/{report['scored']} passed · settle: {report['settle']['reason']} after {report['settle']['waitedSeconds']} s", ""]
    for key in ("family", "domain"):
        parts = []
        for name, row in report["by" + key.capitalize()].items():
            parts.append(f"{name} {row['passed']}/{row['scored']}")
        lines.append(f"By {key}: " + " · ".join(parts))
    lines += ["", "| case | family | domain | result | why |", "|---|---|---|---|---|"]
    for row in report["cases"]:
        lines.append(f"| {row['id']} | {row['family']} | {row['domain']} | {row['result']} | {'; '.join(row['failures']).replace('|', '/')[:300]} |")
    return "\n".join(lines) + "\n"


def summarise(rows):
    out = {"scored": 0, "passed": 0}
    by_family, by_domain = {}, {}
    for row in rows:
        if row["result"] == "skipped":
            continue
        out["scored"] += 1
        out["passed"] += row["result"] == "pass"
        for table, key in ((by_family, row["family"]), (by_domain, row["domain"])):
            cell = table.setdefault(key, {"scored": 0, "passed": 0})
            cell["scored"] += 1
            cell["passed"] += row["result"] == "pass"
    return out, by_family, by_domain


# ---------------------------------------------------------------------------------------------------------------------- HTTP
RESERVED_FOR_AUTOPILOT = "runtime_reserved_for_autopilot"


class Api:
    def __init__(self, base, insecure=False, reserved_wait=900, poll=15, sleep=time.sleep, clock=time.monotonic):
        self.base = base.rstrip("/")
        self.csrf = None
        self.project = None
        # A case's own scheduled research reserves its project's runtime for the episode (423 runtime_reserved_for_autopilot);
        # the episode ends by itself, so the runner waits for it instead of skipping the cases after it (R19.1 production run).
        self.reserved_wait, self.poll, self.sleep, self.clock = reserved_wait, poll, sleep, clock
        context = ssl.create_default_context()
        if insecure:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), urllib.request.HTTPSHandler(context=context))

    def call(self, route, data=None, method=None, timeout=300, tolerate=False, project=None):
        headers = {"Content-Type": "application/json", "Origin": self.base}
        if project or self.project:
            headers["x-open-science-project"] = project or self.project
        if self.csrf:
            headers["x-open-science-csrf"] = self.csrf
        body = None if data is None else json.dumps(data).encode()
        deadline = self.clock() + self.reserved_wait
        while True:
            request = urllib.request.Request(self.base + route, body, headers, method=method)
            try:
                with self.opener.open(request, timeout=timeout) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as error:
                detail = error.read().decode(errors="replace")
                if error.code == 423 and RESERVED_FOR_AUTOPILOT in detail and self.clock() < deadline:
                    self.sleep(self.poll)
                    continue
                text = f"{error.code} {route.split('?')[0][:80]} {detail[:200]}"
                if tolerate:
                    return {"error": text}
                raise RuntimeError(text) from None
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if tolerate:
                    return {"error": f"{route.split('?')[0][:80]} {error}"}
                raise


class Session:
    """One run of the cases against one account."""

    def __init__(self, api, args, log=print):
        self.api, self.args, self.log = api, args, log
        self.projects = {}
        self.turns = []
        self.created = []

    def project(self, label):
        if label not in self.projects:
            project = self.api.call("/api/projects", {"name": f"记忆策略验收 {label}"})["data"]["id"]
            self.projects[label] = project
            self.created.append(project)
        return self.projects[label]

    def new_conversation(self, project):
        session = self.api.call("/api/runtime/sessions", {}, project=project)["data"]["id"]
        self.api.call(f"/api/research-sessions/{session}", {"mode": "open-domain"}, "PUT", tolerate=True, project=project)
        return session

    def turn(self, session, text, project, tag, wait=300):
        started = time.time()
        run = self.api.call("/api/agent-runs/dispatch", {"sessionId": session, "dispatchId": f"mempol-{tag}-{secrets.token_hex(3)}", "text": text}, project=project)["data"]
        row, status = None, "running"
        for _ in range(wait):
            rows = self.api.call("/api/agent-runs", project=project)["data"]
            row = next((item for item in rows if item["id"] == run["id"]), None)
            status = row["status"] if row else "missing"
            if row and status not in RUNNING:
                break
            time.sleep(3)
        item = {"tag": tag, "status": status, "seconds": round(time.time() - started), "route": (row or {}).get("effectiveRouteReason"), "agent": (row or {}).get("effectiveAgentId")}
        self.turns.append(item)
        return item

    def snapshot(self):
        profile = self.api.call("/api/memory/profile", tolerate=True)
        data = profile.get("data") or {}
        records = [{key: record.get(key) for key in ("id", "kind", "scope", "scopeId", "origin", "status", "key", "summary", "value", "nativeType")} for record in data.get("records") or []]
        cards = {}
        for label, project in self.projects.items():
            overview = self.api.call(f"/api/memory/projects/{project}/overview", tolerate=True)
            cards[label] = [{"slot": slot.get("slot"), "text": slot.get("text")} for slot in ((overview.get("data") or {}).get("card") or [])]
        return {"engine": data.get("engine"), "records": records, "cards": cards, "error": profile.get("error")}

    def run_turns(self, case, view_fn):
        sessions = {}
        for index, turn in enumerate(case["turns"]):
            label = turn.get("project", case.get("project", "A"))
            project = self.project(label)
            key = (label, turn.get("session", "s1"))
            if key not in sessions:
                sessions[key] = self.new_conversation(project)
            self.turn(sessions[key], turn["say"], project, f"{case['id']}-{index + 1}")
            if turn.get("waitFor"):
                if not self.wait_for(turn["waitFor"], view_fn, case):
                    return f"precondition never met: {turn['waitFor']} did not appear before the next turn"
            elif turn.get("settle"):
                time.sleep(turn["settle"])
        return None

    def wait_for(self, groups, view_fn, case):
        deadline = time.time() + self.args.checkpoint_wait
        while time.time() < deadline:
            view = view_fn(self.snapshot())
            if all(any(mentions(item, term) for term in group for item in text_in(view, "any")) for group in groups):
                return True
            time.sleep(self.args.poll)
        return False

    def run_task(self, case):
        task = case["task"]
        project = self.project(case.get("project", "A"))
        body = {"projectId": project, "title": task["title"], "prompt": task["prompt"], "taskTypes": [task["taskType"]],
                "maxEpisodeCny": 100, "dailyBudgetCny": 500, "weeklyBudgetCny": 3000,
                "schedule": {"kind": "daily", "time": "03:00", "timeZone": "Asia/Shanghai"}}
        agenda = self.api.call("/api/autopilot/agendas", body, tolerate=True)
        if "error" in agenda:
            return f"scheduled tasks unavailable: {agenda['error']}"
        record = agenda["data"]
        started = self.api.call(f"/api/autopilot/agendas/{record['id']}/start", {"expectedRevision": record.get("revision")}, tolerate=True)
        if "error" in started:
            return f"the task would not start: {started['error']}"
        for number in range(task.get("runs", 2)):
            run = self.api.call(f"/api/autopilot/agendas/{record['id']}/run-now", {"requestId": f"mempol-{case['id']}-{number}-{secrets.token_hex(3)}"}, tolerate=True)
            if "error" in run:
                return f"run-now refused: {run['error']}"
            episode = ((run.get("data") or {}).get("episode") or {}).get("id")
            deadline = time.time() + self.args.task_wait
            while time.time() < deadline:
                page = self.api.call(f"/api/autopilot/episodes?projectId={project}&agendaId={record['id']}", tolerate=True)
                items = (page.get("data") or {}).get("items") or []
                mine = next((item for item in items if item["id"] == episode), None)
                if mine and str((mine.get("payload") or {}).get("status")) not in RUNNING:
                    break
                time.sleep(10)
            else:
                return f"execution {number + 1} did not finish in {self.args.task_wait} s"
        return None

    def cleanup(self, delete_account, user_id, password):
        notes = []
        for project in self.created:
            try:
                self.api.call(f"/api/projects/{project}", {"confirm": project}, "DELETE", project=project)
                notes.append("project deleted")
            except Exception as error:  # noqa: BLE001 - reported, never raised from cleanup
                notes.append(f"project delete failed: {str(error)[:80]}")
        if delete_account and user_id:
            try:
                self.api.call("/api/account", {"confirm": user_id, "password": password}, "DELETE")
                notes.append("account deleted")
            except Exception as error:  # noqa: BLE001
                notes.append(f"account delete failed: {str(error)[:80]}")
        return "; ".join(notes)


def read_password_file(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def run(args, log=print):
    with open(args.cases, encoding="utf-8") as handle:
        document = json.load(handle)
    cases = [case for case in document["cases"] if case.get("group", "A") == args.group and (not args.only or case["id"].split("-")[0] in args.only or case["id"] in args.only)]
    api = Api(args.base_url, args.insecure)
    session = Session(api, args, log)
    password = read_password_file(args.password_file) if args.password_file else secrets.token_urlsafe(18)
    username = args.account or "mempol-" + secrets.token_hex(4)
    delete_account = not args.account or args.delete_account
    user_id = None
    report = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "baseUrl": args.base_url, "group": args.group, "engine": args.engine, "cases": []}
    skipped = {}
    try:
        if not args.account:
            api.call("/api/auth/register", {"username": username, "password": password})
        api.call("/api/auth/login", {"username": username, "password": password})
        me = api.call("/api/me")["data"]
        api.csrf = me.get("csrfToken")
        user_id = (me.get("user") or {}).get("id") or me.get("id") or username
        report["account"] = username
        log(f"ACCOUNT {username}")
        if args.engine != "default":
            log(f"ENGINE-WAIT {args.engine} {username}")
            deadline = time.time() + args.engine_wait
            while args.engine_ready_file and not os.path.exists(args.engine_ready_file) and time.time() < deadline:
                time.sleep(2)
        report["release"] = (api.call("/api/ready", tolerate=True).get("data") or {}).get("release")
        seen = session.snapshot().get("engine")
        report["engineSeen"] = seen
        # The engine the memory is on, as the memory page says it (the legacy profile names none).
        report["engine"] = seen or "legacy"
        for case in cases:
            log(f"CASE {case['id']}")
            view_fn = lambda snap: build_view(snap, session.projects)  # noqa: E731
            try:
                skipped_reason = session.run_task(case) if case.get("task") else session.run_turns(case, view_fn)
            except Exception as error:  # noqa: BLE001 - one case's failure is that case's result
                skipped_reason = f"the case could not be run: {str(error)[:160]}"
            if skipped_reason:
                skipped[case["id"]] = skipped_reason
        settle_started = time.time()
        final, reason, waited = wait_until_settled(
            session.snapshot,
            lambda snap: sum(1 for case in cases if case["id"] not in skipped and not keeps_met(case, build_view(snap, session.projects))),
            poll=args.poll, min_settle=args.min_settle, max_settle=args.settle, stable_polls=args.stable_polls)
        report["settle"] = {"reason": reason, "waitedSeconds": round(time.time() - settle_started)}
        view = build_view(final, session.projects)
        for case in cases:
            row = {"id": case["id"], "family": case["family"], "domain": case["domain"], "persona": case.get("persona", "")}
            if case["id"] in skipped:
                row.update(result="skipped", failures=[skipped[case["id"]]])
            else:
                scored = score_case(case, view)
                row.update(result="pass" if scored["passed"] else "fail", failures=scored["failures"])
            report["cases"].append(row)
        report["records"] = [{key: record.get(key) for key in ("kind", "scope", "scopeId", "origin", "status", "key", "summary")} for record in final["records"]]
        report["cards"] = final["cards"]
        report["turns"] = session.turns
    finally:
        report["cleanup"] = session.cleanup(delete_account, user_id, password)
        report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    totals, by_family, by_domain = summarise(report["cases"])
    report.update(totals)
    report["byFamily"], report["byDomain"] = by_family, by_domain
    os.makedirs(args.out_dir, exist_ok=True)
    stem = os.path.join(args.out_dir, f"memory-policy-{report['engine']}-{args.group}")
    with open(stem + ".json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)
    with open(stem + ".md", "w", encoding="utf-8") as handle:
        handle.write(markdown(report))
    log(f"RESULT {report['passed']}/{report['scored']} passed; {len([r for r in report['cases'] if r['result'] == 'skipped'])} skipped; {report['cleanup']}; {stem}.json")
    return report


def parse(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url")
    parser.add_argument("--cases", default=os.path.join(HERE, "cases.json"))
    parser.add_argument("--cases-only", action="store_true", help="check the case file and exit")
    parser.add_argument("--only", nargs="*", default=[], help="case ids or their prefixes (K01 N03)")
    parser.add_argument("--group", default="A")
    parser.add_argument("--engine", choices=("default", "legacy", "native"), default="default")
    parser.add_argument("--engine-ready-file")
    parser.add_argument("--engine-wait", type=int, default=900)
    parser.add_argument("--account")
    parser.add_argument("--password-file")
    parser.add_argument("--delete-account", action="store_true")
    parser.add_argument("--out-dir", default="memory-policy-out")
    parser.add_argument("--poll", type=int, default=30)
    parser.add_argument("--min-settle", type=int, default=180)
    parser.add_argument("--settle", type=int, default=900)
    parser.add_argument("--stable-polls", type=int, default=3)
    parser.add_argument("--checkpoint-wait", type=int, default=900)
    parser.add_argument("--task-wait", type=int, default=900)
    parser.add_argument("--insecure", action="store_true", help="accept a self-signed certificate (a local stack)")
    args = parser.parse_args(argv)
    # The runner speaks as a person (memory learns only from attended turns), so it may only ever speak as an account it made
    # for itself: an existing account is accepted when it has this runner's throwaway name, never anyone's own.
    if args.account and not THROWAWAY_ACCOUNT.fullmatch(args.account):
        parser.error("--account must be a throwaway account this runner registered (mempol-<8 hex digits>)")
    if not args.cases_only and not args.base_url:
        parser.error("--base-url is required")
    if args.account and not args.password_file:
        parser.error("--account needs --password-file")
    return args


def main(argv):
    args = parse(argv)
    with open(args.cases, encoding="utf-8") as handle:
        problems = check_cases(json.load(handle))
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 2
    if args.cases_only:
        print("cases ok")
        return 0
    report = run(args)
    return 0 if report["scored"] and report["passed"] == report["scored"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
