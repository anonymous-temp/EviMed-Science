"""The FDA approval-records index: US drug applications, their submissions, patents and exclusivities.

A read-only SQLite file built by `build_fda_approvals.py` from two public snapshots -- the Orange Book data files
(Products, Patent, Exclusivity) and the Drugs@FDA data file (applications, products, submissions, marketing status) --
and queried here by `drug_approval_records` wherever the file is mounted. The runtime image carries it beside the SIDER
index (`data/fda-approvals.sqlite`), so a lookup makes no request: FDA replaces these files in place (Drugs@FDA every
weekday, the Orange Book every month), and a run reads the one snapshot the image was built from, dated on every answer.

Two actions, one responsibility: say what FDA's files hold about a US drug application.

  find    a brand or an ingredient name -> every application that carries it, NDA / ANDA / BLA, side by side
  record  one application (optionally one product) -> its submissions, patents and exclusivities

`find` lists the candidates and never chooses between them; the choice (the reference product, the right strength, the
original applicant rather than a generic's) is the reader's, who can see the rows next to one another. An unknown name
answers close names and no row.

Standard library only: this module is imported by the research server, and a third-party import there forces a full
runtime rebuild.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import sqlite3
import stat
import unicodedata
import urllib.parse

SCHEMA = "evimed-fda-approvals-v1"
DATABASE_ENV = "EVIMED_FDA_APPROVALS_DB"
MAX_DATABASE_BYTES = 256 * 1024 * 1024
TOOL_NAME = "drug_approval_records"

FIND_LIMIT_DEFAULT = 30
FIND_LIMIT_MAX = 100
RECORD_LIMIT_DEFAULT = 60
RECORD_LIMIT_MAX = 200
FIND_PRODUCT_LINES = 8
RECORD_PRODUCT_LINES = 60
PATENT_ROWS_MAX = 150
MAX_NAME_CHARS = 120
CLOSE_MATCHES = 8

DRUGS_AT_FDA_PAGE = "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=%s"
ORANGE_BOOK_PATENT_PAGE = "https://www.accessdata.fda.gov/scripts/cder/ob/patent_info.cfm?Product_No=%s&Appl_No=%s&Appl_type=%s"

APPLICATION_TYPES = ("NDA", "ANDA", "BLA")
_TYPE_RANK = {"NDA": 0, "BLA": 1, "ANDA": 2}

# Words a name carries when someone writes a product rather than a drug ("metformin 500 mg tablets"). They are dropped
# from a query only after the query as written found nothing.
_DOSAGE_WORDS = frozenset(
    "mg mcg ug g gm kg ml l iu unit units meq mmol percent tablet tablets tab tabs capsule capsules cap caps injection "
    "injectable solution suspension oral cream ointment gel patch spray drops syrup powder and with of the for in".split()
)


class DrugApprovalError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable

    def stop_reason(self):
        if self.code == "drug_approval_input_invalid":
            return "invalid_input"
        if self.code == "drug_approval_application_not_found":
            return "not_found"
        return "unsupported"


def tool_definitions():
    return [{
        "name": TOOL_NAME,
        "description": (
            "Look up US FDA drug applications in the Orange Book and Drugs@FDA data files, from a dated local snapshot "
            "(no request is made; a change after the snapshot date is not in it). action=find: a brand or ingredient name "
            "lists every application that carries it, labelled NDA/ANDA/BLA, with applicant, original and latest approval "
            "dates, marketing status and strengths; it lists all candidates and does not choose among them. action=record: "
            "one application's submissions (dates, types), patents (expiry, use code, flags) and exclusivities (code, expiry, "
            "meaning). An unknown name returns close names, not a row."
        ),
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["action"],
            "properties": {
                "action": {"type": "string", "enum": ["find", "record"]},
                "name": {"type": "string", "minLength": 1, "maxLength": MAX_NAME_CHARS,
                         "description": "find, required: a brand or ingredient name, any case; a salt or a dose word does not stop the match."},
                "applType": {"type": "string", "enum": list(APPLICATION_TYPES),
                             "description": "find, optional: keep one application type (a common generic has hundreds of ANDAs)."},
                "applNo": {"type": "string", "minLength": 1, "maxLength": 12,
                           "description": "record, required: the application number as find gives it, 6 digits (NDA 020610 -> 020610)."},
                "productNo": {"type": "string", "minLength": 1, "maxLength": 3,
                              "description": "record, optional: one product (3 digits, 001); default every product of the application."},
                "limit": {"type": "integer", "minimum": 1, "maximum": RECORD_LIMIT_MAX,
                          "description": "find: applications listed (default 30, at most 100); record: submissions listed (default 60, at most 200)."},
            },
        },
    }]


def normalize(value) -> str:
    """The one spelling a name is compared in: ASCII, lower case, letters and digits separated by single spaces."""
    text = unicodedata.normalize("NFKD", str(value if value is not None else "")).encode("ascii", "ignore").decode("ascii").casefold()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def ingredient_parts(value) -> list:
    """The components of an ingredient field: both source files separate them with a semicolon."""
    return [part for part in (normalize(piece) for piece in str(value or "").split(";")) if part]


def application_number(value) -> str:
    text = str(value if value is not None else "").strip().upper()
    text = re.sub(r"^(?:ANDA|NDA|BLA|N|A)(?=[\s:#-]|\d)[\s:#-]*", "", text)
    if not re.fullmatch(r"\d{1,6}", text):
        raise DrugApprovalError(
            "drug_approval_input_invalid",
            "applNo must be the application's 6-digit number as find gives it, for example 020610 (an NDA 020610 or ANDA 076543 prefix is accepted).",
        )
    return text.zfill(6)


def product_number(value) -> str:
    text = str(value).strip()
    if not re.fullmatch(r"\d{1,3}", text):
        raise DrugApprovalError("drug_approval_input_invalid", "productNo must be the 3-digit product number of the application, for example 001.")
    return text.zfill(3)


def database_path() -> str:
    configured = os.environ.get(DATABASE_ENV, "").strip()
    path = configured or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "fda-approvals.sqlite")
    if not os.path.isabs(path) or "\0" in path:
        raise DrugApprovalError("drug_approval_index_invalid", "%s must be an absolute path." % DATABASE_ENV)
    return path


def _open():
    path = database_path()
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise DrugApprovalError(
            "drug_approval_index_unconfigured",
            "The FDA approval-records snapshot is not installed in this runtime; use the Drugs@FDA or Orange Book pages with web_read.",
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > MAX_DATABASE_BYTES:
        raise DrugApprovalError("drug_approval_index_invalid", "The FDA approval-records snapshot is not a bounded regular file.")
    try:
        connection = sqlite3.connect("file:%s?mode=ro&immutable=1" % urllib.parse.quote(path), uri=True)
        connection.row_factory = sqlite3.Row
        recorded = dict(connection.execute("SELECT key, value FROM metadata").fetchall())
    except sqlite3.Error as error:
        raise DrugApprovalError("drug_approval_index_invalid", "The FDA approval-records snapshot cannot be opened.") from error
    if recorded.get("schema") != SCHEMA:
        connection.close()
        raise DrugApprovalError("drug_approval_index_invalid", "The FDA approval-records snapshot was built for another schema.")
    return connection, recorded


def status():
    """The readiness fact a health check shows: whether the snapshot is installed, and which one."""
    try:
        connection, recorded = _open()
    except DrugApprovalError as error:
        return {"installed": False, "code": error.code}
    try:
        return {"installed": True, "snapshot": snapshot(recorded)}
    finally:
        connection.close()


def snapshot(recorded) -> dict:
    return {
        "orangeBook": recorded["orangeBookLabel"],
        "drugsAtFda": recorded["drugsAtFdaLabel"],
        "fetched": recorded["fetchedOn"],
        "inputs": json.loads(recorded["inputs"]),
        "caveat": (
            "A snapshot, not the live record: what FDA changed after these dates is not here, and the Orange Book drops a "
            "patent or exclusivity once it has expired, so a state earlier than the snapshot may be missing."
        ),
    }


def _query(connection, sql, parameters=()):
    try:
        return connection.execute(sql, parameters).fetchall()
    except sqlite3.Error as error:
        raise DrugApprovalError("drug_approval_index_invalid", "The FDA approval-records snapshot cannot be queried.") from error


def _matching_applications(connection, norm):
    """(mode, rows) -- the most exact reading of the name that finds anything."""
    rows = _query(connection, "SELECT DISTINCT appl_no, kind, norm FROM name WHERE norm = ?", (norm,))
    if rows:
        return "exact", rows
    words = norm.split()
    # Every word of the query inside a name (a salt, a combination); then the same without dose and form words.
    for candidate in (words, [word for word in words if word not in _DOSAGE_WORDS and not word.isdigit()]):
        if not candidate:
            continue
        sql = "SELECT DISTINCT appl_no, kind, norm FROM name WHERE " + " AND ".join("(' ' || norm || ' ') LIKE ?" for _ in candidate)
        rows = _query(connection, sql, tuple("%% %s %%" % word for word in candidate))
        if rows:
            return "contains", rows
    # The name as written holds more than the file does ("metformin hydrochloride extended release"): the most specific
    # name whose every word the query also says.
    query_words = set(words)
    inside = [row["norm"] for row in _query(connection, "SELECT DISTINCT norm FROM name") if len(row["norm"]) >= 4 and set(row["norm"].split()) <= query_words]
    if inside:
        best = max(len(name.split()) for name in inside)
        rows = []
        for name in sorted(name for name in inside if len(name.split()) == best)[:20]:
            rows.extend(_query(connection, "SELECT DISTINCT appl_no, kind, norm FROM name WHERE norm = ?", (name,)))
        if rows:
            return "within", rows
    return None, []


def _trigrams(text):
    padded = "  %s " % text
    return {padded[index:index + 3] for index in range(len(padded) - 2)}


def _close_names(connection, norm):
    wanted = _trigrams(norm)
    scored = []
    for row in _query(connection, "SELECT norm, kind, count(DISTINCT appl_no) AS applications FROM name GROUP BY norm, kind"):
        other = row["norm"]
        if abs(len(other) - len(norm)) > max(6, len(norm)):
            continue
        shared = len(wanted & _trigrams(other))
        if shared:
            scored.append((shared / len(wanted | _trigrams(other)), other, row["kind"], row["applications"]))
    scored.sort(key=lambda item: (-item[0], item[1]))
    pool = scored[:60]
    ranked = sorted(pool, key=lambda item: (-difflib.SequenceMatcher(None, norm, item[1]).ratio(), item[1]))
    result, seen = [], set()
    for jaccard, other, kind, applications in ranked:
        ratio = difflib.SequenceMatcher(None, norm, other).ratio()
        if ratio < 0.6 or other in seen:
            continue
        seen.add(other)
        result.append({"name": other, "as": _KIND_WORDS[kind], "applications": applications})
        if len(result) >= CLOSE_MATCHES:
            break
    return result


_KIND_WORDS = {"n": "product name", "i": "ingredients", "c": "ingredient"}


def _application_row(row, products, classes, lines_max):
    """One application as `find` lists it; `record` gives its header the same way, with more product lines."""
    original = None
    if row["orig_status"] is not None or row["orig_date"] is not None:
        original = {"date": row["orig_date"], "status": row["orig_status"], "source": row["orig_source"]}
        if row["orig_no"] is not None:
            original["submission"] = "ORIG %s" % row["orig_no"]
        if row["orig_class"]:
            original["class"] = classes.get(row["orig_class"], row["orig_class"])
    latest = None
    if row["latest_date"]:
        latest = {"date": row["latest_date"], "submission": "%s %s" % (row["latest_type"], row["latest_no"])}
        if row["latest_class"]:
            latest["class"] = classes.get(row["latest_class"], row["latest_class"])
    lines = []
    for product in products[:lines_max]:
        parts = [product["product_no"], product["form"] or "-", product["strength"] or "-", product["marketing"] or "marketing status not given"]
        if product["approved"]:
            parts.append("approved " + product["approved"])
        if product["te"]:
            parts.append("TE " + product["te"])
        if product["trade"] and product["trade"] != product["drug_name"]:
            parts.append("trade name " + product["trade"])
        lines.append(" | ".join(parts))
    if len(products) > lines_max:
        lines.append("+%d more products%s" % (len(products) - lines_max, " (record lists them)" if lines_max == FIND_PRODUCT_LINES else ""))
    typed = row["appl_type"] if row["appl_type"] in APPLICATION_TYPES else None
    marketing = {}
    for product in products:
        marketing[product["marketing"] or "not given"] = marketing.get(product["marketing"] or "not given", 0) + 1
    result = {
        "application": ("%s %s" % (typed, row["appl_no"])) if typed else "%s (type not given in the files)" % row["appl_no"],
        "applNo": row["appl_no"],
        "type": typed,
        "names": sorted({product["drug_name"] for product in products if product["drug_name"]} | {product["trade"] for product in products if product["trade"]}),
        "ingredients": sorted({product["ingredient"] for product in products if product["ingredient"]}),
        "applicant": row["applicant"] or None,
        "sponsor": row["sponsor"] or None,
        "originalApproval": original,
        "latestApproved": latest,
        "submissions": {"ORIG": row["n_orig"], "SUPPL": row["n_suppl"]},
        "marketing": marketing,
        "products": lines,
        "orangeBook": bool(row["in_ob"]),
        "patentRows": row["n_patent"],
        "exclusivityRows": row["n_excl"],
    }
    if not row["applicant"]:
        result["applicantNote"] = "No full applicant name: the application is not in the Orange Book, and Drugs@FDA gives only the short sponsor name."
    return result


def _classes(connection):
    return {row["code"]: row["description"] for row in _query(connection, "SELECT code, description FROM class")}


def _products_of(connection, appl_nos):
    grouped = {}
    for start in range(0, len(appl_nos), 400):
        chunk = appl_nos[start:start + 400]
        marks = ",".join("?" for _ in chunk)
        for row in _query(connection, "SELECT * FROM product WHERE appl_no IN (%s) ORDER BY appl_no, product_no" % marks, chunk):
            grouped.setdefault(row["appl_no"], []).append(row)
    return grouped


def _base(recorded):
    return {"snapshot": snapshot(recorded)}


def find(arguments):
    raw = arguments.get("name")
    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_NAME_CHARS or any(ord(character) < 32 for character in raw):
        raise DrugApprovalError("drug_approval_input_invalid", "find needs name: a brand or ingredient name of at most %d characters." % MAX_NAME_CHARS)
    wanted_type = arguments.get("applType")
    if wanted_type is not None and wanted_type not in APPLICATION_TYPES:
        raise DrugApprovalError("drug_approval_input_invalid", "applType must be one of NDA, ANDA, BLA.")
    limit = _limit(arguments, FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX)
    norm = normalize(raw)
    if not norm:
        raise DrugApprovalError("drug_approval_input_invalid", "The name has no letters or digits to look up.")
    connection, recorded = _open()
    try:
        mode, matches = _matching_applications(connection, norm)
        if not matches:
            close = _close_names(connection, norm)
            data = {**_base(recorded), "query": raw.strip(), "normalized": norm, "matched": None, "total": 0, "applications": [], "closeNames": close}
            return {
                "status": "warning",
                "summary": "No application in the FDA snapshot carries the name %r (snapshot: %s)." % (raw.strip(), recorded["shortLabel"]),
                "data": data,
                "warnings": [
                    "No row is shown: a name the snapshot does not hold is not guessed. closeNames are spellings it does hold, "
                    "not the drug you named. A product approved after the snapshot, or sold in the US only under a name FDA does not list, is absent."
                ],
                "next_actions": [
                    "Retry with one of closeNames, the other of brand and ingredient name, or confirm the US name with drug_term_normalize or dailymed_label.",
                ],
            }
        appl_nos = sorted({row["appl_no"] for row in matches})
        rows = []
        for start in range(0, len(appl_nos), 400):
            chunk = appl_nos[start:start + 400]
            rows.extend(_query(connection, "SELECT * FROM application WHERE appl_no IN (%s)" % ",".join("?" for _ in chunk), chunk))
        counts = {kind: 0 for kind in APPLICATION_TYPES}
        for row in rows:
            counts[row["appl_type"]] = counts.get(row["appl_type"], 0) + 1
        same_ingredient = _same_ingredient(connection, appl_nos) if mode == "exact" else None
        if wanted_type:
            rows = [row for row in rows if row["appl_type"] == wanted_type]
        rows.sort(key=lambda row: (_TYPE_RANK.get(row["appl_type"], 9), row["orig_date"] is None, row["orig_date"] or "", row["appl_no"]))
        shown = rows[:limit]
        classes = _classes(connection)
        products = _products_of(connection, [row["appl_no"] for row in shown])
        matched_names = sorted({(row["norm"], row["kind"]) for row in matches})
        data = {
            **_base(recorded),
            "query": raw.strip(),
            "normalized": norm,
            "matched": mode,
            "matchedNames": ["%s (%s)" % (name, _KIND_WORDS[kind]) for name, kind in matched_names[:12]] + (["+%d more names" % (len(matched_names) - 12)] if len(matched_names) > 12 else []),
            "countsByType": counts,
            **({"otherApplicationsSameIngredient": same_ingredient} if same_ingredient else {}),
            "total": len(rows),
            "shown": len(shown),
            "applications": [_application_row(row, products.get(row["appl_no"], []), classes, FIND_PRODUCT_LINES) for row in shown],
        }
        warnings = []
        if len(rows) > len(shown):
            warnings.append(
                "%d further applications are not listed (sorted NDA, BLA, then ANDA, oldest original approval first); narrow with applType, a brand name, or raise limit." % (len(rows) - len(shown))
            )
        if mode == "within":
            warnings.append("The name as written is not in the snapshot; these are applications for the most specific name inside it. Check that they are the product meant.")
        if mode == "contains":
            warnings.append("The name matched as words inside longer names (a salt, a combination); read matchedNames before choosing a row.")
        if wanted_type and not rows:
            warnings.append("No %s application carries this name; countsByType shows the other types." % wanted_type)
        summary = "%d application(s) for %r in the FDA snapshot (%s)." % (len(rows), raw.strip(), recorded["shortLabel"])
        result = {"status": "warning" if warnings else "success", "summary": summary, "data": data}
        if warnings:
            result["warnings"] = warnings
            result["next_actions"] = ["Choose the row that is the product asked about; use record with its applNo for submissions, patents and exclusivities."]
        return result
    finally:
        connection.close()


def _same_ingredient(connection, appl_nos):
    """Applications that carry the ingredients of the matched ones but not the name: a brand's generics, a generic's brand."""
    ingredients = set()
    for start in range(0, len(appl_nos), 400):
        chunk = appl_nos[start:start + 400]
        ingredients.update(row["norm"] for row in _query(
            connection, "SELECT DISTINCT norm FROM name WHERE kind = 'i' AND appl_no IN (%s)" % ",".join("?" for _ in chunk), chunk))
    if not ingredients or len(ingredients) > 50:
        return None
    others = {}
    wanted = set(appl_nos)
    for ingredient in sorted(ingredients):
        for row in _query(connection, "SELECT DISTINCT n.appl_no AS appl_no, a.appl_type AS appl_type FROM name n JOIN application a ON a.appl_no = n.appl_no WHERE n.kind = 'i' AND n.norm = ?", (ingredient,)):
            if row["appl_no"] not in wanted:
                others[row["appl_no"]] = row["appl_type"]
    if not others:
        return None
    by_type = {}
    for kind in others.values():
        by_type[kind] = by_type.get(kind, 0) + 1
    return {"total": len(others), "byType": by_type, "how": "find by the ingredient name to list them"}


def _limit(arguments, default, maximum):
    value = arguments.get("limit", default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
        raise DrugApprovalError("drug_approval_input_invalid", "limit must be an integer from 1 to %d for this action." % maximum)
    return value


def _meaning_map(connection, kind, codes):
    if not codes:
        return {}
    marks = ",".join("?" for _ in codes)
    return {row["code"]: row["meaning"] for row in _query(connection, "SELECT code, meaning FROM code_meaning WHERE kind = ? AND code IN (%s)" % marks, [kind, *sorted(codes)])}


def _patent_entries(patent_rows):
    """Patent rows as one entry per patent: the use codes it is listed under, the products it covers.

    A patent listed under several use codes is one entry; a use code that covers only some of the entry's products says
    which, so nothing the file separates is merged.
    """
    grouped = {}
    for item in patent_rows:
        key = (item["patent_no"], item["expire_iso"], item["substance"], item["drug_product"], item["delist"], item["submitted_iso"])
        grouped.setdefault(key, {}).setdefault(item["use_code"], set()).add(item["product_no"])
    entries = []
    for (patent_no, iso, substance, drug_product, delist, submitted), by_use in grouped.items():
        everything = sorted(set().union(*by_use.values()))
        entry = {"patentNo": patent_no, "expires": iso, "products": everything}
        flags = [name for name, on in (("drugSubstance", substance), ("drugProduct", drug_product), ("delistRequested", delist)) if on]
        if flags:
            entry["flags"] = flags
        codes = []
        for code, product_numbers in sorted(by_use.items(), key=lambda pair: (pair[0] is None, pair[0] or "")):
            if code is None:
                continue
            codes.append(code if sorted(product_numbers) == everything else "%s (products %s)" % (code, ",".join(sorted(product_numbers))))
        if codes:
            entry["useCodes"] = codes
        if submitted:
            entry["submittedToFda"] = submitted
        entries.append(entry)
    entries.sort(key=lambda entry: (entry["expires"] is None, entry["expires"] or "", entry["patentNo"]))
    return entries


def record(arguments):
    appl_no = application_number(arguments.get("applNo"))
    product = product_number(arguments["productNo"]) if arguments.get("productNo") not in (None, "") else None
    limit = _limit(arguments, RECORD_LIMIT_DEFAULT, RECORD_LIMIT_MAX)
    connection, recorded = _open()
    try:
        rows = _query(connection, "SELECT * FROM application WHERE appl_no = ?", (appl_no,))
        if not rows:
            raise DrugApprovalError(
                "drug_approval_application_not_found",
                "The FDA snapshot (%s) holds no application %s. Find the number with find, or the application is newer than the snapshot." % (recorded["shortLabel"], appl_no),
            )
        application = rows[0]
        products = _products_of(connection, [appl_no]).get(appl_no, [])
        if product is not None and not any(item["product_no"] == product for item in products):
            raise DrugApprovalError(
                "drug_approval_application_not_found",
                "Application %s has no product %s in the snapshot; its products are %s." % (appl_no, product, ", ".join(item["product_no"] for item in products) or "none"),
            )
        classes = _classes(connection)
        header = _application_row(application, [item for item in products if product in (None, item["product_no"])], classes, RECORD_PRODUCT_LINES)

        submission_rows = _query(connection, "SELECT * FROM submission WHERE appl_no = ? ORDER BY date IS NULL, date, kind DESC, no", (appl_no,))
        listed = submission_rows
        omitted = 0
        if len(listed) > limit:
            # The oldest submission (the original) always stays; the rest are the most recent.
            listed = [submission_rows[0]] + submission_rows[-(limit - 1):] if limit > 1 else submission_rows[-1:]
            omitted = len(submission_rows) - len(listed)
        submissions = []
        for item in listed:
            parts = ["%s %s" % (item["kind"], item["no"]), item["date"] or "date not given", item["status"] or "status not given"]
            if item["class_code"]:
                parts.append(classes.get(item["class_code"], item["class_code"]))
            if item["priority"]:
                parts.append("review " + item["priority"])
            if item["categories"]:
                parts.append("categories: " + item["categories"])
            submissions.append(" | ".join(parts))

        patent_filter = " AND product_no = ?" if product else ""
        patent_args = (appl_no, product) if product else (appl_no,)
        patent_rows = _query(
            connection,
            "SELECT * FROM patent WHERE appl_no = ?%s ORDER BY expire_iso IS NULL, expire_iso, patent_no, use_code, product_no" % patent_filter,
            patent_args,
        )
        use_codes = {item["use_code"] for item in patent_rows if item["use_code"]}
        patents = _patent_entries(patent_rows)
        patent_omitted = max(0, len(patents) - PATENT_ROWS_MAX)

        exclusivity_rows = _query(
            connection,
            "SELECT * FROM exclusivity WHERE appl_no = ?%s ORDER BY expire_iso IS NULL, expire_iso, code, product_no" % patent_filter,
            patent_args,
        )
        exclusivity_codes = {item["code"] for item in exclusivity_rows}
        merged = {}
        for item in exclusivity_rows:
            merged.setdefault((item["code"], item["expire_iso"]), set()).add(item["product_no"])
        exclusivities = [{"code": code, "expires": iso, "products": sorted(product_numbers)} for (code, iso), product_numbers in merged.items()]

        data = {
            **_base(recorded),
            "application": header,
            "productFilter": product,
            "submissions": {"total": len(submission_rows), "shown": len(submissions), "omittedMiddle": omitted, "rows": submissions},
            "patents": {"total": len(patents), "shown": min(len(patents), PATENT_ROWS_MAX), "rows": patents[:PATENT_ROWS_MAX], "useCodeMeanings": _meaning_map(connection, "use", use_codes)},
            "exclusivity": {"total": len(exclusivities), "rows": exclusivities, "codeMeanings": _meaning_map(connection, "exclusivity", exclusivity_codes)},
            "checkCurrent": {"drugsAtFda": DRUGS_AT_FDA_PAGE % appl_no},
        }
        if application["in_ob"] and products:
            data["checkCurrent"]["orangeBookPatents"] = ORANGE_BOOK_PATENT_PAGE % (product or products[0]["product_no"], appl_no, "A" if application["appl_type"] == "ANDA" else "N")
        warnings = []
        if not application["in_ob"]:
            warnings.append("The application is not in the Orange Book (a biologic, a tentative approval, or a product no longer listed), so it has no patent or exclusivity rows here; that is not a finding that none exist.")
        elif not patents and not exclusivities:
            warnings.append("The snapshot lists no patent and no exclusivity for this selection. The Orange Book drops them once expired, so this does not say there never was one.")
        if omitted:
            warnings.append("%d middle submissions are not listed (the original and the newest are); raise limit to see more." % omitted)
        if patent_omitted:
            warnings.append("%d patent rows are not listed; name productNo to narrow." % patent_omitted)
        data["scope"] = (
            "Orange Book patents and exclusivities are per product; Drugs@FDA submissions are per application. Dates are ISO "
            "(the Orange Book writes them as Mmm d, yyyy). Use-code and exclusivity-code meanings are the Orange Book's own definitions."
        )
        result = {
            "status": "warning" if warnings else "success",
            "summary": "Application %s in the FDA snapshot (%s)." % (header["application"], recorded["shortLabel"]),
            "data": data,
        }
        if warnings:
            result["warnings"] = warnings
            result["next_actions"] = ["State the snapshot date with any date taken from this record; check the Drugs@FDA page for the live state when the date matters."]
        return result
    finally:
        connection.close()


def call(arguments):
    action = arguments.get("action")
    if action == "find":
        return find(arguments)
    if action == "record":
        return record(arguments)
    raise DrugApprovalError("drug_approval_input_invalid", "action must be find or record.")
