"""Shared pins, constants and small helpers for the patient-matching boards.

Everything here is deterministic and label-free. The boards read public
benchmark files that were fetched at pinned commits; nothing downloaded is ever
imported as code except the two short official evaluators named in EVALUATORS,
and those only after their bytes match the digests below.
"""
import hashlib
import json
from pathlib import Path
import re

TG2_REPO = "https://github.com/TrialGPT2/TrialGPT2.0"
TG2_COMMIT = "1c5f9ebc3b98d1f780ceea68043efdaa2daba880"
TG1_REPO = "https://github.com/ncbi-nlp/TrialGPT"
TG1_COMMIT = "1b3242cd50c153a9c324661d4a0bd94fc68a4226"
ANNOTATIONS_SOURCE = "https://huggingface.co/datasets/ncbi/TrialGPT-Criterion-Annotations"
ANNOTATIONS_SHA256 = "14c547184fac9b013cd17441fd028845b40150c76b022e58334f5494077e5234"

# Path inside the TrialGPT 2.0 clone and the digest of the reviewed bytes.
EVALUATORS = {
    "rankings": ("scripts/eval_trialgpt_rankings_qrels.py",
                 "550f3e6d9dc222b0cd96e153b24d5e3bc9c676be521d45360228f88c198f8527"),
    "nih_recall": ("scripts/eval_nih_trialbench_target_recall_at10.py",
                   "a165ff5318a35372012d1688abfd5edd28fcd5c3a321a2ad96567d0448e3adee"),
}

# The candidate order a runtime sees is a function of ids and this seed only.
SHUFFLE_SEED = "vcr-matching-boards/v1"

# Board A cohorts: directory under data/, case and pair counts the paper reports.
COHORTS = {
    "sigir": {"cases": 59, "evaluable": 58, "pairs": 3835},
    "trec_2021": {"cases": 75, "evaluable": 75, "pairs": 35832},
    "trec_2022": {"cases": 50, "evaluable": 50, "pairs": 35394},
}
NIH = {"dir": "nih_trialbench", "cases": 126, "pairs": 101682}
CRITERION = {"rows": 1015, "patients": 53, "pairs": 105, "gpt4_agree": 886}

# TREC 2023 is not in the pinned data: forty topics, reserved as test.
TREC_2023_TOPICS = 40

DEV_TOPICS_PER_TREC_COHORT = 10

LABELS = ("included", "not included", "excluded", "not excluded",
          "not applicable", "not enough information")
FAVOURABLE = ("included", "not excluded")
DISQUALIFYING = ("not included", "excluded")
# The labels that assert a definite fact about the patient against a clause.
DECISIVE = ("included", "not included", "excluded")

PATIENT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NCT_ID = re.compile(r"^NCT\d{8}$")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_jsonl(path):
    rows = []
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_json(path, value):
    """Write once; an existing file is never replaced."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def write_jsonl(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def read_git_head(repo):
    """The checked-out commit of a clone, read from .git without running git."""
    head = (Path(repo) / ".git" / "HEAD").read_text().strip()
    if re.fullmatch(r"[0-9a-f]{40}", head):
        return head
    if head.startswith("ref: "):
        ref = Path(repo) / ".git" / head[5:]
        if ref.is_file():
            return ref.read_text().strip()
    raise ValueError("Cannot resolve the checked-out commit")


def check_evaluator(tg2_root, name):
    """Path of an official evaluator after its bytes match the reviewed digest."""
    relative, expected = EVALUATORS[name]
    path = Path(tg2_root) / relative
    if sha256_file(path) != expected:
        raise ValueError(f"Official evaluator {relative} differs from the reviewed bytes")
    return path


def candidate_order(patient_id, trial_ids, seed=SHUFFLE_SEED):
    """Deterministic shuffle that takes only ids: no label can reach the order."""
    def key(trial_id):
        return sha256_bytes(f"{seed}|{patient_id}|{trial_id}".encode()), trial_id
    return sorted(trial_ids, key=key)


def canonical_trial_id(value):
    return str(value or "").strip().upper()


def normalize_label(value):
    """A six-label string, or None when the value is not one of the six."""
    text = re.sub(r"[\s_\-]+", " ", str(value or "").strip().lower())
    return text if text in LABELS else None
