"""Cross-arm identity excludes run ID intentionally; each arm is indexed separately."""
def row_identity(row):
    return (row.get("set"), row.get("split"), row["caseId"], row["kind"], row["id"], row.get("checkpoint"))


def index_rows(rows, kinds=("answer",)):
    out = {}
    for row in rows:
        if row.get("kind") not in kinds:
            continue
        key = row_identity(row)
        if key in out:
            raise ValueError("duplicate_score_identity")
        out[key] = row["verdict"] == "pass" if row.get("verdict") in ("pass", "fail") else None
    return out
