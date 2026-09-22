#!/usr/bin/env python3
"""How fresh is the EviMed evidence index? One day's sweep; run it once a day for 14 days (plan 12.2).

NOT RUN YET: it needs the deployment's EviMed API key, and the platform's rule is that touching a credential needs the
owner's go-ahead first. Once given, run it from this machine so nothing is written on the host:

  ssh evimed 'docker exec -i web-open-science-web-1 python3 - ' < tools/evimed_api_freshness.py >> research/evimed-freshness.jsonl

Inside the web container the key is the file the control plane already reads (/run/secrets/evimed-api-key, see
deploy/web/docker-compose.yml); this script opens it, sends it only in the Authorization header, and never prints,
logs or writes it. Output is one JSON line per sweep: which ids it saw and their own publication / registration
dates, so the day an id first appears can be compared with the date it carries.
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timezone

BASE = os.environ.get("EVIMED_EVIDENCE_SEARCH_URL", "https://www.evimed.com/api-evimed/medicine-api/ai-api").rstrip("/")
KEY_FILE = os.environ.get("EVIMED_EVIDENCE_SEARCH_KEY_FILE", "/run/secrets/evimed-api-key")
YEAR = datetime.now(timezone.utc).year
PUBLISHER_GROUPS = [
    ["中华医学会"], ["中国医师协会"], ["中国临床肿瘤学会", "CSCO"], ["中国抗癌协会"], ["中华医学会心血管病学分会"],
    ["中华医学会内分泌学分会", "中华医学会糖尿病学分会"], ["中华医学会呼吸病学分会"], ["中华医学会消化病学分会"],
    ["中华医学会神经病学分会"], ["中华医学会感染病学分会"], ["中华医学会儿科学分会"], ["中华医学会妇产科学分会"],
    ["中华医学会重症医学分会", "中华医学会急诊医学分会"], ["中华医学会肾脏病学分会"], ["中华医学会风湿病学分会"],
    ["中国药学会"], ["中华中医药学会"], ["中国中西医结合学会"], ["国家卫生健康委员会"], ["国家药品监督管理局药品审评中心"],
    ["NCCN"], ["ESC"], ["ACC", "AHA"], ["ADA"], ["WHO"], ["NICE"], ["ESMO"], ["ASCO"], ["KDIGO"], ["GOLD", "GINA"],
]
TRIAL_TERMS = ["肿瘤", "心血管", "糖尿病", "神经", "精神", "感染", "呼吸", "重症", "消化", "肝病", "肾脏", "风湿免疫", "血液",
               "儿科", "妇产", "老年", "外科", "麻醉", "中医药", "药物"]


def key():
    with open(KEY_FILE, encoding="utf-8") as handle:
        return handle.read().strip()


def post(path, body, secret):
    req = urllib.request.Request(f"{BASE}/{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    secret = key()
    day = datetime.now(timezone.utc).date().isoformat()
    for group in PUBLISHER_GROUPS:
        body = {"query": "指南 共识", "type": "guide", "count": 100, "startYear": YEAR, "publishers": group}
        try:
            data = (post("review/api/v2/literature-guide", body, secret).get("data") or {}).get("guide") or {}
            rows = [{"id": r.get("id"), "date": r.get("publicationDate"), "year": r.get("year"), "publisher": r.get("publisher")} for r in data.get("list", [])]
            print(json.dumps({"day": day, "kind": "guide", "group": group, "total": data.get("total"), "rows": rows}, ensure_ascii=False), flush=True)
        except Exception as error:  # a failure is reported, never invented into a result
            print(json.dumps({"day": day, "kind": "guide", "group": group, "error": type(error).__name__}), flush=True)
        time.sleep(2)
    for term in TRIAL_TERMS:
        body = {"query": term, "count": 100, "registry": 0, "startYear": YEAR}
        try:
            data = post("review/api/v2/clinical-trial", body, secret).get("data") or {}
            lst = data.get("list", []) if isinstance(data, dict) else []
            rows = [{"id": r.get("registrationNo"), "date": r.get("registrationDate")} for r in lst]
            print(json.dumps({"day": day, "kind": "chictr", "term": term, "total": data.get("total") if isinstance(data, dict) else None, "rows": rows}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"day": day, "kind": "chictr", "term": term, "error": type(error).__name__}), flush=True)
        time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
