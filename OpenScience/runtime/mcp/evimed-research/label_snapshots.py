"""DailyMed labels, by version: the actual SPL documents, normalised, preserved and compared, and always said to be the US label.

Hidden knowledge, from the live wire (2026-10-04) and not from the documentation:

- **The v2 services list SPL metadata, return the current document, and serve an
  older version only as a zip.** `/spls.json` gives `setid`, `spl_version`, `title`,
  `published_date`; `/spls/{setid}.xml` is the current document and ignores a
  `?version=` (asked for 36, it returned 37); `/spls/{setid}/history.json` lists the
  published versions; and an older version is `getFile.cfm?setid=&type=zip&version=`,
  a zip of the SPL XML and its images. That zip is served through the gateway's
  named download so a slow answer is a timeout that says so.
- **Version numbers are not contiguous** (the Tagrisso history has no 34): a version
  that was never published is not an error in a request but a named outcome here
  (`version_not_published`, with the versions that exist).
- **`published_date` is not the label's date.** It is when DailyMed published that
  version (v36 on Apr 22, 2026); the document's own `effectiveTime` is 2024-09-25.
  Both are kept and never merged.
- **An unknown setid is HTTP 200 with an empty history** on `history.json` and 404
  with no body on the document endpoint; a search with no match is HTTP 200 with
  `data: []`. Each is `no_results`, never evidence that the product does not exist.
- **The document states its own jurisdiction.** An SPL's `approval` carries the
  `territorialAuthority` that approved it (`USA`), and DailyMed is the FDA's
  repository. Every result of this tool says it is the United States label, and a
  request that names another jurisdiction is answered `no_results` with where to look
  (`jurisdiction_not_covered`): a US label is never offered in place of China's,
  Europe's or Japan's, whose indications, products and wording differ.

What is preserved for a version is the SPL XML exactly as DailyMed serves it
(`spl.xml`), a Markdown reading of its sections (`label.md`, one heading per section
with its LOINC code), and the normalised facts (`label.json`: ingredients with UNII
codes, products with NDC product codes, forms, routes, strengths, marketing category,
labeler, and a digest per section). The bytes carry no retrieval time, so the same
version is the same capture, and each version is a capture of its own beside the
others. A comparison between two versions lists, per section and per product, what
was added, removed or changed, by closed kind; it does not read the prose.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import open_access_supplements as zips
import public_sources
import source_intake
import source_outcome
import source_transport as transport
import source_types
from immutable_capture import ImmutableCaptureError, managed_workspace, preserve

API_BASE = "https://dailymed.nlm.nih.gov/dailymed/services/v2"
PAGE_URL = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=%s"
DEADLINE_SECONDS = 90.0
# One read of a label document (the current XML, or a version's zip) may wait this long. Not the transport's 20 s:
# DailyMed builds the document on request, half a megabyte for a long label, and from the serving host it answered in
# 4.5 s, then 31 s, for the same Tagrisso label within a minute (2026-10-05); the release-5 tool probe was cut at 20 s.
# The tool's whole budget (`DEADLINE_SECONDS`) still bounds the call.
DOCUMENT_PER_ATTEMPT_SECONDS = 60.0
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_PRODUCTS_LISTED = 20
MAX_VERSIONS_LISTED = 50
MAX_CHANGES = 200
SEARCH_LIMIT = 100
CAPTURE_ROOT = Path(".evimed-sources") / "dailymed"
HL7 = "{urn:hl7-org:v3}"
SETID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
UNII_SYSTEM = "2.16.840.1.113883.4.9"
NDC_SYSTEM = "2.16.840.1.113883.6.69"
US_JURISDICTION_NAMES = frozenset({"us", "usa", "unitedstates", "unitedstatesfda", "fda", "美国", "美國"})
LABEL_CHANGE_KINDS = (
    "title_changed", "labeler_changed", "marketing_changed", "product_added", "product_removed", "product_changed",
    "ingredient_added", "ingredient_removed", "strength_changed", "section_added", "section_removed", "section_changed",
)
# LOINC section codes DailyMed labels use, by the name a reader and a run say. A closed table of
# codes the labels carry; a section whose code is not here keeps the code as its name.
SECTION_NAMES = {
    "34066-1": "boxed_warning", "34067-9": "indications_and_usage", "34068-7": "dosage_and_administration",
    "34069-5": "how_supplied", "34070-3": "contraindications", "34071-1": "warnings", "34072-9": "general_precautions",
    "34073-7": "drug_interactions", "34074-5": "drug_and_or_laboratory_test_interactions", "34076-0": "information_for_patients",
    "34077-8": "teratogenic_effects", "34078-6": "abuse", "34079-4": "labor_and_delivery", "34080-2": "nursing_mothers",
    "34081-0": "pediatric_use", "34082-8": "geriatric_use", "34083-6": "carcinogenesis_and_mutagenesis",
    "34084-4": "adverse_reactions", "34085-1": "controlled_substance", "34086-9": "abuse", "34087-7": "dependence",
    "34088-5": "overdosage", "34089-3": "description", "34090-1": "clinical_pharmacology", "34091-9": "animal_pharmacology",
    "34092-7": "clinical_studies", "34093-5": "references", "42228-7": "pregnancy", "42229-5": "spl_unclassified",
    "43678-2": "dosage_forms_and_strengths", "43679-0": "mechanism_of_action", "43680-8": "pharmacodynamics",
    "43681-6": "pharmacokinetics", "43682-4": "pharmacogenomics", "43683-2": "nonclinical_toxicology",
    "43684-0": "use_in_specific_populations", "43685-7": "warnings_and_precautions", "43686-5": "microbiology",
    "49489-8": "microbiology", "42232-9": "precautions", "44425-7": "storage_and_handling", "48780-1": "spl_product_data_elements",
    "51945-4": "package_label_principal_display_panel", "53413-1": "otc_questions", "50565-1": "otc_keep_out_of_reach_of_children",
    "55105-1": "otc_purpose", "55106-9": "otc_active_ingredient", "51727-6": "inactive_ingredient", "60561-8": "other_safety_information",
    "34391-3": "human_prescription_drug_label", "34390-5": "human_otc_drug_label", "38056-8": "supplemental_patient_material",
    "42231-1": "medguide", "68498-5": "patient_medication_information", "59845-8": "instructions_for_use", "69719-3": "pregnancy_lactation_females_and_males",
    "77290-5": "recent_major_changes", "90374-0": "recent_major_changes", "71744-9": "carcinogenesis_mutagenesis_fertility",
    "88829-7": "pediatric_use_geriatric_use",
}


def _text(node):
    if node is None:
        return ""
    return re.sub(r"\s+", " ", " ".join(node.itertext())).strip()


def _iso(compact):
    value = str(compact or "").strip()
    if re.fullmatch(r"\d{8}", value):
        return "%s-%s-%s" % (value[:4], value[4:6], value[6:])
    return value or None


def _published(value):
    """DailyMed's `Sep 25, 2026` as an ISO date; the text unchanged when it is not that shape."""
    try:
        return datetime.strptime(str(value).strip(), "%b %d, %Y").date().isoformat()
    except ValueError:
        return str(value).strip() or None


def is_us(jurisdiction):
    key = re.sub(r"[^a-z0-9一-鿿]+", "", str(jurisdiction or "").casefold())
    return not key or key in US_JURISDICTION_NAMES


# ----------------------------------------------------------------------------
# The document
# ----------------------------------------------------------------------------
def _child(node, name):
    return next((child for child in node if child.tag == HL7 + name), None)


def _children(node, name):
    return [child for child in node if child.tag == HL7 + name]


def _code(node):
    code = _child(node, "code") if node is not None else None
    if code is None:
        return {}
    return {key: code.attrib.get(key) for key in ("code", "codeSystem", "displayName") if code.attrib.get(key)}


def _quantity(node):
    quantity = _child(node, "quantity")
    if quantity is None:
        return None
    result = {}
    for side in ("numerator", "denominator"):
        part = _child(quantity, side)
        if part is not None and part.attrib.get("value") is not None:
            result[side] = {"value": part.attrib["value"], **({"unit": part.attrib["unit"]} if part.attrib.get("unit") else {})}
    return result or None


def _ingredient(node):
    substance = _child(node, "ingredientSubstance")
    if substance is None:
        return None
    code = _code(substance)
    entry = {"name": _text(_child(substance, "name")).casefold(), "unii": code.get("code") if code.get("codeSystem") == UNII_SYSTEM else None}
    moiety = _child(substance, "activeMoiety")
    inner = _child(moiety, "activeMoiety") if moiety is not None else None
    if inner is not None:
        moiety_code = _code(inner)
        entry["activeMoiety"] = _text(_child(inner, "name")).casefold() or None
        entry["activeMoietyUnii"] = moiety_code.get("code") if moiety_code.get("codeSystem") == UNII_SYSTEM else None
    strength = _quantity(node)
    if strength:
        entry["strength"] = strength
    return {key: value for key, value in entry.items() if value not in (None, "")}


def _product(node, route_nodes):
    code = _code(node)
    generic = _child(_child(node, "asEntityWithGeneric"), "genericMedicine") if _child(node, "asEntityWithGeneric") is not None else None
    name_node = _child(node, "name")
    name = _text(name_node)
    active, inactive = [], []
    for ingredient in _children(node, "ingredient"):
        parsed = _ingredient(ingredient)
        if parsed is None:
            continue
        (inactive if ingredient.attrib.get("classCode") == "IACT" else active).append(parsed)
    packages = []
    for content in node.iter(HL7 + "containerPackagedProduct"):
        package = _code(content)
        if package.get("code") and package.get("codeSystem") == NDC_SYSTEM and package["code"] not in packages:
            packages.append(package["code"])
    form_code = _child(node, "formCode")
    entry = {
        "name": name, "ndcProduct": code.get("code") if code.get("codeSystem") == NDC_SYSTEM else None,
        "form": form_code.attrib.get("displayName") if form_code is not None else None,
        "genericName": _text(_child(generic, "name")).casefold() if generic is not None else None,
        "routes": sorted({node.attrib.get("displayName") for node in route_nodes if node.attrib.get("displayName")}),
        "activeIngredients": active, "inactiveIngredients": [item for item in inactive],
        "ndcPackages": packages[:20], **({"ndcPackagesTruncated": True} if len(packages) > 20 else {}),
    }
    return {key: value for key, value in entry.items() if value not in (None, "", [])}


def parse_spl(xml_payload):
    """The normalised label and its sections from SPL XML bytes. Raises `ValueError` for what is not an SPL document."""
    try:
        root = ET.fromstring(xml_payload)
    except ET.ParseError as error:
        raise ValueError("not XML: %s" % error) from error
    if root.tag != HL7 + "document" or _child(root, "setId") is None:
        raise ValueError("not an SPL document")
    parents = {child: parent for parent in root.iter() for child in parent}
    set_id = _child(root, "setId").attrib.get("root", "").casefold()
    version = _child(root, "versionNumber")
    doc_type = _code(root)
    author = _child(root, "author")
    labeler = None
    if author is not None:
        organization = next(author.iter(HL7 + "representedOrganization"), None)
        labeler = _text(_child(organization, "name")) if organization is not None else None
    products, marketing = [], []
    for outer in root.iter(HL7 + "manufacturedProduct"):
        inner = [child for child in outer if child.tag == HL7 + "manufacturedProduct"]
        for product in inner:
            routes = list(outer.iter(HL7 + "routeCode")) if outer is not product else []
            products.append(_product(product, routes))
        for subject in _children(outer, "subjectOf"):
            for approval in _children(subject, "approval"):
                ident = _child(approval, "id")
                territory = next(approval.iter(HL7 + "territory"), None)
                territory_code = _code(territory) if territory is not None else {}
                row = {
                    "category": _code(approval).get("displayName"),
                    "number": ident.attrib.get("extension") if ident is not None else None,
                    "territory": territory_code.get("code"),
                }
                row = {key: value for key, value in row.items() if value}
                if row and row not in marketing:
                    marketing.append(row)
    seen, sections = {}, []
    body = next(root.iter(HL7 + "structuredBody"), None)
    if body is not None:
        def walk(node, depth):
            for component in _children(node, "component"):
                section = _child(component, "section")
                if section is None:
                    continue
                code = _code(section)
                title = _text(_child(section, "title"))
                text_node = _child(section, "text")
                own = _text(text_node)
                key = code.get("code") or ""
                seen[key] = seen.get(key, 0) + 1
                sections.append({
                    "code": key or None, "name": SECTION_NAMES.get(key, key or "unclassified"), "title": title or None, "depth": depth,
                    "occurrence": seen[key], "chars": len(own), "sha256": hashlib.sha256(own.encode("utf-8")).hexdigest(), "text": own,
                })
                walk(section, depth + 1)
        walk(body, 0)
    active = []
    for product in products:
        for ingredient in product.get("activeIngredients", []):
            row = {key: ingredient.get(key) for key in ("name", "unii", "activeMoiety", "activeMoietyUnii") if ingredient.get(key)}
            if row and row not in active:
                active.append(row)
    territories = {row["territory"] for row in marketing if row.get("territory")}
    label = {
        "schemaVersion": 1, "setId": set_id, "documentId": (_child(root, "id").attrib.get("root") if _child(root, "id") is not None else None),
        "version": int(version.attrib["value"]) if version is not None and str(version.attrib.get("value", "")).isdigit() else None,
        "effectiveDate": _iso(_child(root, "effectiveTime").attrib.get("value") if _child(root, "effectiveTime") is not None else None),
        "documentType": {"code": doc_type.get("code"), "name": doc_type.get("displayName")}, "title": _text(_child(root, "title")),
        "labeler": labeler, "jurisdiction": jurisdiction_of(territories), "products": products, "activeIngredients": active, "marketing": marketing,
    }
    return {key: value for key, value in label.items() if value not in (None, "", [])}, sections


def jurisdiction_of(territories):
    """The label's jurisdiction, stated by the document where it states one and by the source where it does not."""
    stated = sorted(territories)
    if stated and stated != ["USA"]:
        # A document naming another territory would be a surprise in DailyMed; say what it says, not what is expected.
        return {"country": "/".join(stated), "authority": None, "basis": "the approval in the document names this territory", "note": "DailyMed is the US FDA's repository; this territory is not the United States."}
    return {
        "country": "US", "authority": "FDA",
        "basis": "the approval in the document names the territory USA" if stated else "DailyMed is the US FDA's labeling repository; the document names no territory",
        "note": "This is the United States label. It is not the label of China (NMPA), the EU (EMA), Japan (PMDA) or any other jurisdiction, whose products, indications and wording differ.",
    }


def render_markdown(label, sections):
    """One heading per section with its LOINC code; the labeler's own text, not rewritten."""
    lines = ["# %s" % (label.get("title") or label.get("setId")), "", "- Set ID: %s" % label.get("setId"), "- SPL version: %s" % label.get("version")]
    if label.get("effectiveDate"):
        lines.append("- Effective date: %s" % label["effectiveDate"])
    if label.get("labeler"):
        lines.append("- Labeler: %s" % label["labeler"])
    jurisdiction = label.get("jurisdiction") or {}
    lines.append("- Jurisdiction: %s%s" % (jurisdiction.get("country"), (" (%s)" % jurisdiction["authority"]) if jurisdiction.get("authority") else ""))
    lines.append("- Source: %s" % (PAGE_URL % label.get("setId")))
    for row in label.get("marketing", []):
        lines.append("- Marketing: %s" % ", ".join("%s" % value for value in (row.get("category"), row.get("number"), row.get("territory")) if value))
    for product in label.get("products", []):
        lines.append("- Product: %s%s%s%s" % (
            product.get("name"), (" (NDC %s)" % product["ndcProduct"]) if product.get("ndcProduct") else "", (", %s" % product["form"]) if product.get("form") else "",
            ("; active: %s" % ", ".join(
                "%s%s" % (item.get("name"), (" %s %s" % (item["strength"]["numerator"]["value"], item["strength"]["numerator"].get("unit", ""))) if item.get("strength", {}).get("numerator") else "")
                for item in product.get("activeIngredients", []))) if product.get("activeIngredients") else ""))
    for section in sections:
        heading = "#" * min(2 + section["depth"], 6)
        lines.extend(["", "%s %s" % (heading, section["title"] or section["name"].replace("_", " ").title()), "", "<!-- LOINC %s -->" % (section["code"] or "none"), "", section["text"] or "_No text._"])
    return "\n".join(lines).rstrip() + "\n"


# ----------------------------------------------------------------------------
# Two versions
# ----------------------------------------------------------------------------
def diff_labels(before, before_sections, after, after_sections):
    """What changed from one version of a label to the next, by closed kind. Compares digests, not prose."""
    changes = []

    def add(kind, **fields):
        changes.append({"kind": kind, **fields})

    for field, kind in (("title", "title_changed"), ("labeler", "labeler_changed")):
        if before.get(field) != after.get(field):
            add(kind, before=before.get(field), after=after.get(field))
    if before.get("marketing") != after.get("marketing"):
        add("marketing_changed", before=before.get("marketing"), after=after.get("marketing"))
    old_products = {product.get("ndcProduct") or product.get("name"): product for product in before.get("products", [])}
    new_products = {product.get("ndcProduct") or product.get("name"): product for product in after.get("products", [])}
    for key in old_products:
        if key not in new_products:
            add("product_removed", product=key)
    for key in new_products:
        if key not in old_products:
            add("product_added", product=key)
    for key in old_products:
        if key in new_products and old_products[key] != new_products[key]:
            old, new = old_products[key], new_products[key]
            old_active = {item.get("unii") or item.get("name"): item for item in old.get("activeIngredients", [])}
            new_active = {item.get("unii") or item.get("name"): item for item in new.get("activeIngredients", [])}
            for ingredient in old_active:
                if ingredient not in new_active:
                    add("ingredient_removed", product=key, ingredient=old_active[ingredient].get("name"))
                elif old_active[ingredient].get("strength") != new_active[ingredient].get("strength"):
                    add("strength_changed", product=key, ingredient=old_active[ingredient].get("name"), before=old_active[ingredient].get("strength"), after=new_active[ingredient].get("strength"))
            for ingredient in new_active:
                if ingredient not in old_active:
                    add("ingredient_added", product=key, ingredient=new_active[ingredient].get("name"))
            if {k: v for k, v in old.items() if k != "activeIngredients"} != {k: v for k, v in new.items() if k != "activeIngredients"}:
                add("product_changed", product=key, before={k: v for k, v in old.items() if k != "activeIngredients"}, after={k: v for k, v in new.items() if k != "activeIngredients"})
    old_sections = {(section["code"], section["occurrence"]): section for section in before_sections}
    new_sections = {(section["code"], section["occurrence"]): section for section in after_sections}
    for key, section in old_sections.items():
        if key not in new_sections:
            add("section_removed", code=section["code"], name=section["name"], title=section["title"])
        elif section["sha256"] != new_sections[key]["sha256"]:
            add("section_changed", code=section["code"], name=section["name"], title=section["title"], beforeChars=section["chars"], afterChars=new_sections[key]["chars"], beforeSha256=section["sha256"], afterSha256=new_sections[key]["sha256"])
    for key, section in new_sections.items():
        if key not in old_sections:
            add("section_added", code=section["code"], name=section["name"], title=section["title"])
    return changes


def held_versions(workspace, set_id):
    """The versions of this label already preserved, by version number."""
    root = workspace / CAPTURE_ROOT / set_id
    held = {}
    try:
        names = sorted(entry.name for entry in root.iterdir() if entry.is_dir() and not entry.is_symlink() and re.fullmatch(r"[0-9a-f]{64}", entry.name))
    except OSError:
        return {}
    for name in names[:200]:
        path = root / name / "label.json"
        try:
            if path.is_symlink() or not path.is_file():
                continue
            label = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(label.get("version"), int):
            held.setdefault(label["version"], {"directory": name, "label": label})
    return held


# ----------------------------------------------------------------------------
# The retrievals
# ----------------------------------------------------------------------------
SCOPE = "DailyMed"


def _search(arguments, deadline):
    drug = str(arguments["drug"]).strip()
    limit = min(max(int(arguments.get("limit") or 10), 1), SEARCH_LIMIT)
    page = max(int(arguments.get("page") or 1), 1)
    url = "%s/spls.json?%s" % (API_BASE, urllib.parse.urlencode({"drug_name": drug, "pagesize": limit, "page": page}))
    body, _ = transport.fetch_json(url, deadline=deadline, scope=SCOPE)
    rows = body.get("data") if isinstance(body, dict) else None
    meta = body.get("metadata") if isinstance(body, dict) else None
    if not isinstance(rows, list) or not isinstance(meta, dict):
        raise source_outcome.unavailable("DailyMed answered with something that is not a label list.", scope=SCOPE, reason="invalid_response", retryable=False)
    jurisdiction = jurisdiction_of(set())
    items = [{
        "setId": row.get("setid"), "version": row.get("spl_version"), "title": _text_value(row.get("title")), "publishedDate": _published(row.get("published_date")),
        "url": PAGE_URL % row.get("setid"), "jurisdiction": jurisdiction["country"], "authority": jurisdiction["authority"],
    } for row in rows if isinstance(row, dict) and row.get("setid")]
    total = meta.get("total_elements") if isinstance(meta.get("total_elements"), int) else None
    pages = meta.get("total_pages") if isinstance(meta.get("total_pages"), int) else None
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    data = {"items": items, "query": {"drug": drug, "limit": limit, "page": page}, "jurisdiction": jurisdiction, "contentLevel": "label_metadata"}
    if not items:
        data["outcome"] = source_outcome.no_results(
            reason="no_match", how="DailyMed has no US label under this name; try the brand or the generic name alone, or drug_label_search for a label in another jurisdiction.")
        return {
            "status": "warning", "summary": "DailyMed holds no label matching %r." % drug, "data": data,
            "warnings": ["No match is not evidence that the drug has no label: it means this name matched nothing in the US labeling repository."],
            "next_actions": ["Retry with the brand or generic name alone."],
        }
    more = page < pages if pages is not None else bool(meta.get("next_page") not in (None, "null"))
    if more:
        data["outcome"] = source_outcome.more_available(
            returned=len(items) + (page - 1) * limit, total=total, next_arguments={"drug": drug, "limit": limit, "page": page + 1},
            how="Call again with page=%d for the next %d labels." % (page + 1, limit), page=page, pages=pages,
        )
    else:
        data["outcome"] = source_outcome.complete(returned=len(items), total=total)
    return {
        "status": "warning", "summary": "Found %d of %s US label(s) for %r (page %d)." % (len(items), total if total is not None else "an unknown number of", drug, page), "data": data,
        "sources": [{"id": item["setId"], "title": item["title"], "url": item["url"], "source": "dailymed", "retrievedAt": now, "evidenceAccess": "bibliographic_only"} for item in items],
        "warnings": ["These are label listings (metadata). They are United States labels only; read one by setid for its sections."],
        "next_actions": ["Read the label you need with dailymed_label setid=...; pick the exact product and version, not the first hit."] + (["Ask for page %d for more." % (page + 1)] if more else []),
    }


def _text_value(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _history(set_id, deadline):
    """The published versions of a setid, newest first, or None when DailyMed has no such label."""
    body, _ = transport.fetch_json("%s/spls/%s/history.json" % (API_BASE, set_id), deadline=deadline, scope=SCOPE)
    data = body.get("data") if isinstance(body, dict) else None
    history = data.get("history") if isinstance(data, dict) else None
    if not isinstance(history, list):
        raise source_outcome.unavailable("DailyMed answered with something that is not a version history.", scope=SCOPE, reason="invalid_response", retryable=False)
    versions = sorted(({"version": row["spl_version"], "publishedDate": _published(row.get("published_date"))} for row in history if isinstance(row, dict) and isinstance(row.get("spl_version"), int)), key=lambda row: -row["version"])
    return versions or None


# What the document endpoint is asked for. DailyMed answers 406 ("Could not satisfy the request Accept header.") to an
# Accept of application/xml alone and serves the same XML with 200 to one that also names application/json (or to
# */*, which the gateway does not admit): recorded 2026-10-05, `wire/dailymed__spl_current_xml_accept_406.json`. The
# list is also what the gateway holds the answer's type to, so it names both and the answer is still checked to be XML.
CURRENT_XML_ACCEPT = ("application/xml", "application/json")


def _current_xml(set_id, deadline):
    response = transport.fetch("%s/spls/%s.xml" % (API_BASE, set_id), CURRENT_XML_ACCEPT, deadline=deadline, scope=SCOPE, max_bytes=MAX_XML_BYTES, accept_statuses=(404,),
                               per_attempt=DOCUMENT_PER_ATTEMPT_SECONDS)
    if response.status != 404 and response.content_type != "application/xml":
        raise source_outcome.unavailable("DailyMed answered the label document with %s, not XML." % (response.content_type or "no content type"),
            scope=SCOPE, reason="unexpected_content_type", retryable=False)
    return None if response.status == 404 else response.body


def _version_xml(set_id, version, deadline):
    """An older version's SPL XML out of the zip DailyMed serves it in; raises when the archive did not arrive whole."""
    download = transport.download("dailymed-spl-zip", {"setid": set_id, "version": version}, deadline=deadline, scope=SCOPE, max_bytes=MAX_XML_BYTES,
                                  per_attempt=DOCUMENT_PER_ATTEMPT_SECONDS)
    if not download.complete:
        state = "timeout" if download.reason in ("deadline", "read_stalled") else "unavailable"
        raise source_outcome.SourceError(
            state, "DailyMed's archive of version %d stopped arriving after %d bytes (%s)." % (version, download.received, (download.reason or "").replace("_", " ")),
            scope=SCOPE, reason=download.reason or "incomplete", retryable=True, partial={"bytesReceived": download.received},
        )
    entries, _skipped, ended = zips.read_zip(download.body)
    documents = [entry for entry in entries if entry["name"].casefold().endswith(".xml")]
    if not documents or ended != "end_of_archive":
        raise source_outcome.unavailable("DailyMed's archive of version %d holds no SPL document." % version, scope=SCOPE, reason="no_document_in_archive", retryable=False)
    if any(entry["crcOk"] is False for entry in documents):
        raise source_outcome.unavailable("The SPL document in DailyMed's archive of version %d is corrupt." % version, scope=SCOPE, reason="corrupt_entry", retryable=True)
    imageless = len(entries) - len(documents)
    return documents[0]["payload"], imageless


def _capture(workspace, set_id, label, sections, xml_payload):
    payloads = {
        "spl.xml": xml_payload, "label.md": render_markdown(label, sections).encode("utf-8"),
        "label.json": (json.dumps({**label, "sections": [{k: v for k, v in section.items() if k != "text"} for section in sections]}, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8"),
    }
    sidecar = source_types.sidecar({"id": set_id, "title": label.get("title"), "url": PAGE_URL % set_id, "tool": "drug_label_search", "source": "dailymed"})
    if sidecar:
        payloads[sidecar[0]] = sidecar[1]
    paths = preserve(workspace, CAPTURE_ROOT / set_id, payloads)
    return paths, payloads


def _read(arguments, deadline):
    set_id = str(arguments["setid"]).strip().casefold()
    requested = arguments.get("version")
    versions = _history(set_id, deadline)
    if versions is None:
        return {
            "status": "warning", "summary": "DailyMed holds no label with set id %s." % set_id,
            "data": {"items": [], "setId": set_id, "jurisdiction": jurisdiction_of(set()), "outcome": source_outcome.no_results(
                reason="setid_not_found", how="Check the set id (the setid a search returned); DailyMed holds US labels only, so a label of another jurisdiction is not here.")},
            "warnings": ["No such set id in the US labeling repository; that is not evidence that the label does not exist elsewhere."],
            "next_actions": ["Search by drug name with dailymed_label drug=..., or use drug_label_search for another jurisdiction."],
        }
    current_version = versions[0]["version"]
    published = {row["version"]: row["publishedDate"] for row in versions}
    target = requested if requested is not None else current_version
    if target not in published:
        return {
            "status": "warning", "summary": "Version %s of %s was never published; the published versions are %s." % (target, set_id, ", ".join(str(row["version"]) for row in versions[:MAX_VERSIONS_LISTED])),
            "data": {"items": [], "setId": set_id, "currentVersion": current_version, "versions": versions[:MAX_VERSIONS_LISTED], "jurisdiction": jurisdiction_of(set()), "outcome": source_outcome.no_results(
                reason="version_not_published", how="Version numbers are not contiguous. Ask for one of data.versions, or omit version for the current label.")},
            "warnings": ["That version number is not among the published versions of this label."],
            "next_actions": ["Choose a version from data.versions."],
        }
    extra = {}
    if target == current_version:
        xml_payload = _current_xml(set_id, deadline)
        if xml_payload is None:
            raise source_outcome.unavailable("DailyMed lists this label but did not serve its document.", scope=SCOPE, reason="document_missing", retryable=True)
        images = 0
    else:
        xml_payload, images = _version_xml(set_id, target, deadline)
    try:
        label, sections = parse_spl(xml_payload)
    except ValueError as error:
        raise source_outcome.unavailable("DailyMed's document is not an SPL label (%s)." % error, scope=SCOPE, reason="invalid_response", retryable=False) from error
    if label.get("setId") != set_id or label.get("version") != target:
        raise source_outcome.unavailable("DailyMed served set id %s version %s where %s version %s was asked for." % (label.get("setId"), label.get("version"), set_id, target),
            scope=SCOPE, reason="identity_mismatch", retryable=False,
        )
    label = {**label, "publishedDate": published.get(target)}
    workspace = managed_workspace()
    try:
        before_held = held_versions(workspace, set_id)
        paths, payloads = _capture(workspace, set_id, label, sections, xml_payload)
    except ImmutableCaptureError as error:
        raise public_sources.PublicSourceError("public_source_label_snapshot_failed", str(error)) from error
    held = held_versions(workspace, set_id)
    # What to compare with: the version asked for in compareVersion (fetched and preserved if not held), else the nearest earlier held one.
    compare = arguments.get("compareVersion")
    warnings = []
    against = None
    if compare is not None and compare != target:
        if compare not in published:
            warnings.append("compareVersion %s was never published, so no comparison was made." % compare)
        else:
            if compare not in held:
                other_xml, _images = _version_xml(set_id, compare, deadline) if compare != current_version else (_current_xml(set_id, deadline), 0)
                other_label, other_sections = parse_spl(other_xml)
                _capture(workspace, set_id, {**other_label, "publishedDate": published.get(compare)}, other_sections, other_xml)
                held = held_versions(workspace, set_id)
            against = held.get(compare)
    elif compare is None:
        earlier = [number for number in held if number < target]
        against = held[max(earlier)] if earlier else None
    comparison = None
    if against is not None:
        stored = against["label"]
        old_sections = [{**section, "text": ""} for section in stored.get("sections", [])]
        changes = diff_labels({k: v for k, v in stored.items() if k != "sections"}, old_sections, label, sections)
        counts = {}
        for change in changes:
            counts[change["kind"]] = counts.get(change["kind"], 0) + 1
        comparison = {
            "againstVersion": stored.get("version"), "againstEffectiveDate": stored.get("effectiveDate"), "againstPublishedDate": stored.get("publishedDate"),
            "againstPath": "%s/label.md" % (CAPTURE_ROOT / set_id / against["directory"]).as_posix(), "unchanged": not changes, "counts": counts, "changes": changes[:MAX_CHANGES],
        }
        if len(changes) > MAX_CHANGES:
            comparison["outcome"] = source_outcome.truncated(kept=MAX_CHANGES, limit=MAX_CHANGES, unit="changes listed", how="%d changes in all; label.json of the two captures holds both versions' section digests." % len(changes))
    markdown_path, xml_path, label_path = paths["label.md"], paths["spl.xml"], paths["label.json"]
    new = target not in before_held or before_held[target]["directory"] != Path(markdown_path).parent.name
    products = label.get("products", [])
    data = {
        "setId": set_id, "version": target, "currentVersion": current_version, "isCurrent": target == current_version,
        "publishedDate": published.get(target), "effectiveDate": label.get("effectiveDate"),
        "contentLevel": "regulatory_label_full_text", "jurisdiction": label["jurisdiction"],
        "title": label.get("title"), "labeler": label.get("labeler"), "documentType": label.get("documentType"), "marketing": label.get("marketing"),
        "activeIngredients": label.get("activeIngredients"), "products": products[:MAX_PRODUCTS_LISTED],
        "sections": [{k: v for k, v in section.items() if k not in ("text", "sha256")} for section in sections],
        "versions": versions[:MAX_VERSIONS_LISTED], "heldVersions": sorted(held), "thisVersionIsNew": new,
        "markdownPath": markdown_path, "xmlPath": xml_path, "labelPath": label_path,
        "artifactSha256s": {path: hashlib.sha256(payloads[name]).hexdigest() for name, path in paths.items() if name in payloads},
        "outcome": source_outcome.complete(),
    }
    if images:
        data["imagesOmitted"] = images
    if len(products) > MAX_PRODUCTS_LISTED:
        data["productsOutcome"] = source_outcome.truncated(kept=MAX_PRODUCTS_LISTED, limit=MAX_PRODUCTS_LISTED, unit="products listed", how="%d products in all; label.json holds every one." % len(products))
    if len(versions) > MAX_VERSIONS_LISTED:
        data["versionsOutcome"] = source_outcome.truncated(kept=MAX_VERSIONS_LISTED, limit=MAX_VERSIONS_LISTED, unit="versions listed", how="%d versions in all; ask for any by version." % len(versions))
    if comparison is not None:
        data["comparison"] = comparison
    if arguments.get("intake") is True:
        data["intake"] = source_intake.hand_off("dailymed-%s-v%d" % (set_id, target), [markdown_path], deadline=deadline)
        if not data["intake"].get("available"):
            warnings.append(data["intake"].get("how") or "Source intake was not available.")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    summary = "Preserved the %s of %s (SPL version %d of %d%s), a United States (FDA) label%s." % (
        "current label" if target == current_version else "older label", label.get("title") or set_id, target, current_version, "" if target == current_version else ", not the current one",
        (" and compared it with version %s: %s" % (comparison["againstVersion"], "nothing changed" if comparison["unchanged"] else "%d change(s)" % len(comparison["changes"]))) if comparison else "",
    )
    if target != current_version:
        warnings.append("Version %d is not the current label (current is version %d); do not state it as what is in force." % (target, current_version))
    result = {
        "status": "warning" if warnings else "success",
        "summary": summary,
        "data": data,
        "sources": [{"id": set_id, "title": label.get("title"), "url": PAGE_URL % set_id, "source": "dailymed", "retrievedAt": now, "evidenceAccess": "regulatory_record", "artifactPath": markdown_path}],
        "artifacts": [markdown_path, xml_path, label_path],
    }
    if warnings:
        result["warnings"] = warnings
    result["next_actions"] = [
        "Quote the label through its markdownPath; cite the SPL version and effective date, and say it is the United States (FDA) label: it states nothing about approval or wording in any other jurisdiction.",
    ]
    return result


def snapshot(arguments):
    """`dailymed_label`: search US labels by name, or read one setid at one version, preserved and compared."""
    has_drug, has_setid = bool(str(arguments.get("drug") or "").strip()), bool(str(arguments.get("setid") or "").strip())
    if has_drug == has_setid:
        raise public_sources.PublicSourceError("public_source_label_invalid", "Pass drug to search the labels, or setid to read one (not both).")
    if has_setid and not SETID.match(str(arguments["setid"]).strip()):
        raise public_sources.PublicSourceError("public_source_label_invalid", "setid is a DailyMed set id: a UUID such as 5e81b4a7-b971-45e1-9c31-29cea8c87ce7.")
    if has_drug and (arguments.get("version") is not None or arguments.get("compareVersion") is not None):
        raise public_sources.PublicSourceError("public_source_label_invalid", "version and compareVersion belong to reading one label by setid.")
    if not is_us(arguments.get("jurisdiction")):
        requested = str(arguments["jurisdiction"]).strip()
        return {
            "status": "warning", "summary": "DailyMed holds United States labels only; it cannot answer for %s." % requested,
            "data": {"items": [], "requestedJurisdiction": requested, "availableJurisdiction": "United States (FDA)", "outcome": source_outcome.no_results(
                reason="jurisdiction_not_covered", how="Use drug_label_search for a Chinese label (the EviMed label index) or provide the current official label; do not use the US label in its place.")},
            "warnings": ["The US label was not substituted for the requested jurisdiction.", "A missing label here is not evidence of approval, non-approval or off-label status in %s." % requested],
            "next_actions": ["Use drug_label_search for China, or provide the official label of the jurisdiction in question."],
        }
    deadline = transport.Deadline(DEADLINE_SECONDS)
    if has_drug:
        return _search(arguments, deadline)
    return _read(arguments, deadline)
