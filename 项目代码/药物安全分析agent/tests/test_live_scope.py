"""Scope controls reach openFDA in a form it can search (2026-09-27 incident).

Production run adr-001 (osimertinib, cardiac events) failed twice:

- with the alias "泰瑞沙", openFDA answered HTTP 400 "Search not supported"
  to the whole query, because a non-Latin name went into it;
- without it, the job said FAERS had no osimertinib report at all. FAERS has
  31,866. ``administrationRoutes: ["ORAL"]`` became
  ``drugadministrationroute:"oral"``, and openFDA stores ICH E2B route codes
  ("048"), so that one filter emptied the report set.

The openFDA behaviour these tests stand on is recorded in
``tests/data/openfda_scope_2026_09_27.json`` (live responses, the route-code
table from openFDA's field specification, and the osimertinib counts with
each filter applied alone). The fake below answers the way openFDA answered.
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import httpx
import pytest
import respx

from safety_agent.analysis.pipeline import AnalysisPipeline
from safety_agent.core.exceptions import NoDataError, NormalizationError
from safety_agent.faers import (
    DrugEntry,
    DrugScope,
    FrozenFAERSSnapshot,
    ReportRecord,
    SnapshotProvenance,
    SQLiteFAERSSnapshot,
    write_sqlite_snapshot,
)
from safety_agent.normalize.routes import ROUTE_LABELS, resolve_route, resolve_routes
from safety_agent.openfda.client import EVENT_ENDPOINT, LABEL_ENDPOINT, OpenFDAClient
from safety_agent.openfda.queries import LiveDrugScope, openfda_search_name

DATA = Path(__file__).parent / "data"
BASE = "https://api.fda.gov"
RECORDED = json.loads((DATA / "openfda_scope_2026_09_27.json").read_text(encoding="utf-8"))

#: The adr-001 brief (OpenScience/evals/adr-analysis/briefs.json), exactly.
ADR_001 = {
    "drug": "osimertinib",
    "reactions": ["心力衰竭", "左室射血分数下降", "QT 间期延长"],
    "drugAliases": ["Osimertinib", "AZD9291", "泰瑞沙", "TAGRISSO"],
    "suspectRoles": ["PS"],
    "administrationRoutes": ["ORAL"],
    "studyDateFrom": "2023-01-01",
    "studyDateTo": "2025-12-31",
    "backgroundDateFrom": "2016-01-01",
    "backgroundDateTo": "2025-12-31",
}


class RecordedOpenFDA:
    """drug/event.json as openFDA answered on 2026-09-27.

    Non-ASCII search -> the recorded 400; a route value that is not a
    three-digit code -> the recorded 404 (openFDA holds codes, so a name
    matches nothing); ``empty_routes`` names codes that hold no report of the
    target drug, to exercise the empty-scope diagnosis.
    """

    def __init__(self, *, empty_routes: frozenset[str] = frozenset()):
        self.searches: list[str | None] = []
        self.empty_routes = empty_routes

    def __call__(self, request: httpx.Request) -> httpx.Response:
        search = request.url.params.get("search")
        self.searches.append(search)
        if search is not None and not search.isascii():
            rejection = RECORDED["rejections"]["non_latin_alias"]
            return httpx.Response(rejection["status"], json=rejection["body"])
        routes = re.findall(r'drugadministrationroute:"([^"]*)"', search or "")
        if any(not re.fullmatch(r"\d{3}", route) for route in routes) or (
            set(routes) & self.empty_routes and "osimertinib" in (search or "")
        ):
            miss = RECORDED["rejections"]["route_name_instead_of_code"]
            return httpx.Response(miss["status"], json=miss["body"])
        count_field = request.url.params.get("count")
        if count_field is not None:
            if count_field == "patient.reaction.reactionmeddrapt.exact":
                terms = [("Interstitial lung disease", 900), ("Cardiac failure", 300)]
            else:
                terms = [("1", 500), ("2", 400)]
            return httpx.Response(
                200,
                json={"results": [{"term": term, "count": count} for term, count in terms]},
            )
        return httpx.Response(
            200, json={"meta": {"results": {"total": self._total(search)}}, "results": []}
        )

    @staticmethod
    def _total(search: str | None) -> int:
        counts = RECORDED["osimertinib_counts"]
        if search is None or "osimertinib" not in search.casefold():
            if search and "reactionmeddrapt" in search:
                return 4_000
            return counts["background_window"]["total"]
        if "reactionmeddrapt" in search:
            return 25
        return counts["name+target_window"]["total"]


def _client() -> OpenFDAClient:
    return OpenFDAClient(BASE, backoff_initial=0.001, backoff_cap=0.002)


def _pipeline(
    client: OpenFDAClient, aliases: tuple[str, ...] = tuple(ADR_001["drugAliases"]), **overrides
) -> AnalysisPipeline:
    scope = DrugScope(
        names=("scope-validation", *aliases),
        role_codes=frozenset(ADR_001["suspectRoles"]),
        routes=tuple(ADR_001["administrationRoutes"]),
        date_from=ADR_001["studyDateFrom"],
        date_to=ADR_001["studyDateTo"],
        background_date_from=ADR_001["backgroundDateFrom"],
        background_date_to=ADR_001["backgroundDateTo"],
    )
    kwargs = {
        "openfda": client,
        "top_pt_count": 2,
        # What ServiceContext hands the pipeline: the validated scope.
        "drug_aliases": tuple(name for name in scope.names if name != "scope-validation"),
        "suspect_roles": scope.role_codes,
        "drug_routes": scope.routes,
        "study_date_from": scope.date_from,
        "study_date_to": scope.date_to,
        "background_date_from": scope.background_date_from,
        "background_date_to": scope.background_date_to,
    }
    kwargs.update(overrides)
    return AnalysisPipeline(**kwargs)


# -- the adr-001 incident, through the real client ---------------------------


@pytest.mark.parametrize(
    "aliases",
    [
        # production job 2: HTTP 400 on the non-Latin alias
        tuple(ADR_001["drugAliases"]),
        # production job 3: the same without it, "no osimertinib report in FAERS"
        tuple(alias for alias in ADR_001["drugAliases"] if alias.isascii()),
    ],
    ids=["job-2-with-cjk-alias", "job-3-latin-aliases-only"],
)
@respx.mock
async def test_adr_001_scope_reaches_openfda_as_searchable_codes_and_names(aliases):
    fake = RecordedOpenFDA()
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=fake)
    async with _client() as client:
        result = await _pipeline(client, aliases).run(ADR_001["drug"], ADR_001["reactions"])

    assert result.overview.total_reports == RECORDED["osimertinib_counts"]["name+target_window"]["total"]
    user_rows = [row for row in result.signals if row.source == "user-specified"]
    assert {row.reaction for row in user_rows} == {
        "cardiac failure",
        "ejection fraction decreased",
        "electrocardiogram qt prolonged",
    }
    assert all(row.a == 25 for row in user_rows)
    searches = [search for search in fake.searches if search]
    assert all(search.isascii() for search in searches)
    # The scoped drug-side queries (normalization's bare name probe aside).
    drug_side = [
        search
        for search in searches
        if "osimertinib" in search.casefold() and "drugcharacterization" in search
    ]
    assert drug_side
    assert all('drugadministrationroute:"048"' in search for search in drug_side)
    assert not any('drugadministrationroute:"oral"' in search for search in searches)
    assert all("patient.drug.drugcharacterization:1" in search for search in drug_side)
    assert all("receivedate:[20230101 TO 20251231]" in search for search in drug_side)
    # The alias that cannot be searched is named, not silently dropped.
    assert any("泰瑞沙" in note for note in result.degradation_notes) == ("泰瑞沙" in aliases)
    assert any("oral -> 048" in note for note in result.degradation_notes)
    assert result.administration_routes == ["oral"]
    assert result.suspect_roles == ["PS", "SS"]
    assert result.suspect_binding == "report_contains_suspect_approximation"


@respx.mock
async def test_medicinalproduct_fallback_searches_latin_aliases_only():
    fake = RecordedOpenFDA()
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=fake)
    async with _client() as client:
        result = await _pipeline(client, drug_field="medicinalproduct").run(
            ADR_001["drug"], ADR_001["reactions"]
        )

    drug_side = [
        s for s in fake.searches if s and "medicinalproduct" in s and "drugcharacterization" in s
    ]
    assert drug_side
    for alias in ("osimertinib", "azd9291", "tagrisso"):
        assert any(f'medicinalproduct:"{alias}"' in search for search in drug_side)
    assert all(search.isascii() for search in drug_side)
    assert result.overview.total_reports > 0


@respx.mock
async def test_a_filter_that_empties_the_scope_is_named_not_reported_as_no_reports():
    # Osimertinib is an oral tablet: a nasal route filter leaves no report.
    fake = RecordedOpenFDA(empty_routes=frozenset({"045"}))
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=fake)
    async with _client() as client:
        pipeline = _pipeline(client, drug_routes=("NASAL",))
        with pytest.raises(NoDataError) as raised:
            await pipeline.run(ADR_001["drug"], ADR_001["reactions"])

    message = raised.value.message
    assert "给药途径" in message and "nasal -> 045" in message
    assert "不是 FAERS 没有该药的报告" in message
    # Every step's count is shown, so the reader sees where the set emptied.
    assert "药名 13,541" in message and "+药品角色" in message
    assert "任何报告" not in message


@respx.mock
async def test_no_reports_is_said_only_when_the_name_itself_matches_nothing():
    def nothing(request: httpx.Request) -> httpx.Response:
        search = request.url.params.get("search") or ""
        if "notadrugname" in search:
            return httpx.Response(404, json=RECORDED["rejections"]["route_name_instead_of_code"]["body"])
        return httpx.Response(200, json={"meta": {"results": {"total": 100}}, "results": []})

    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=nothing)
    respx.get(f"{BASE}/{LABEL_ENDPOINT}").mock(
        return_value=httpx.Response(404, json=RECORDED["rejections"]["route_name_instead_of_code"]["body"])
    )
    async with _client() as client:
        pipeline = AnalysisPipeline(openfda=client, top_pt_count=0)
        with pytest.raises(NoDataError, match="任何报告"):
            await pipeline.run("notadrugname", ["myalgia"])


async def test_an_untranslated_cjk_drug_name_is_a_normalization_error_not_a_query():
    class NeverQueried:
        async def count_total(self, search=None):
            if search and not search.isascii():
                raise AssertionError(f"non-ASCII search sent to openFDA: {search}")
            from safety_agent.core.exceptions import NoResults

            raise NoResults(search=search or "")

        async def count_terms(self, *args, **kwargs):
            return []

        async def search_labels(self, *args, **kwargs):
            return []

    pipeline = AnalysisPipeline(openfda=NeverQueried(), top_pt_count=0)
    with pytest.raises(NormalizationError, match="拉丁字符"):
        await pipeline.run("泰瑞沙", ["myalgia"])


# -- role codes ---------------------------------------------------------------


def test_roles_map_to_drugcharacterization_codes():
    def scope(roles):
        return LiveDrugScope(drug_name="osimertinib", role_codes=frozenset(roles))

    assert "drugcharacterization:1" in scope({"PS"}).search("openfda_generic")
    assert "drugcharacterization:2" in scope({"C"}).search("openfda_generic")
    assert "drugcharacterization:3" in scope({"I"}).search("openfda_generic")
    both = scope({"PS", "C"}).search("openfda_generic")
    assert "(patient.drug.drugcharacterization:1 OR patient.drug.drugcharacterization:2)" in both
    # All four roles are every drug entry: no role filter at all.
    assert "drugcharacterization" not in scope({"PS", "SS", "C", "I"}).search("openfda_generic")


@respx.mock
async def test_live_result_reports_the_roles_the_filter_selected():
    fake = RecordedOpenFDA()
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=fake)
    async with _client() as client:
        concomitant = await _pipeline(client, suspect_roles=frozenset({"C"})).run(
            ADR_001["drug"], ADR_001["reactions"]
        )
        every_role = await _pipeline(
            client, suspect_roles=frozenset({"PS", "SS", "C", "I"})
        ).run(ADR_001["drug"], ADR_001["reactions"])

    assert concomitant.suspect_roles == ["C"]
    assert any("drugcharacterization:2" in (s or "") for s in fake.searches)
    assert every_role.suspect_roles == ["PS", "SS", "C", "I"]
    assert every_role.suspect_binding == "target_name_only"


# -- route vocabulary ---------------------------------------------------------


def test_route_table_is_openfdas_own_specification():
    assert ROUTE_LABELS == RECORDED["route_codes"]["values"]


@pytest.mark.parametrize(
    ("requested", "codes"),
    [
        ("ORAL", ("048",)),
        ("oral", ("048",)),
        ("048", ("048",)),
        ("48", ("048",)),
        ("NASAL", ("045",)),
        ("Respiratory (inhalation)", ("055",)),
        ("respiratory", ("055",)),
        ("inhalation", ("055",)),
        ("Subcutaneous", ("058",)),
        ("INTRAVENOUS", ("040", "041", "042")),
        ("Intravenous drip", ("041",)),
        ("口服", ("048",)),
    ],
)
def test_route_names_and_codes_resolve_deterministically(requested, codes):
    assert resolve_route(requested) == codes


def test_an_unknown_route_is_refused_with_the_accepted_forms():
    with pytest.raises(ValueError, match="ICH E2B route code"):
        resolve_route("by mouth with food")
    with pytest.raises(ValueError, match="unknown administration route"):
        resolve_route("999")
    with pytest.raises(ValueError, match="unknown administration route"):
        DrugScope(names=("osimertinib",), routes=("tablet",))


def test_several_routes_resolve_once_each_in_request_order():
    assert resolve_routes(["NASAL", "oral", "048"]) == ("045", "048")


def test_frozen_snapshot_matches_a_route_stored_as_label_or_as_code(tmp_path):
    provenance = SnapshotProvenance(
        snapshot_id="route-forms-v1", source="synthetic", extracted_at="2026-09-27"
    )

    def report(report_id: str, route: str) -> ReportRecord:
        return ReportRecord(
            primary_id=report_id,
            case_id=report_id,
            case_version=1,
            received_date=date(2024, 1, 1),
            reactions=("Cardiac failure",),
            drugs=(
                DrugEntry(
                    medicinal_product="TAGRISSO",
                    normalized_names=("osimertinib",),
                    role_code="PS",
                    route=route,
                ),
            ),
        )

    reports = (report("1", "Oral"), report("2", "048"), report("3", "Nasal"))
    snapshot = FrozenFAERSSnapshot(reports, provenance)
    scope = DrugScope(names=("tagrisso",), routes=("ORAL",))
    assert snapshot.contingency(scope, "cardiac failure").drug_total == 2
    indexed = SQLiteFAERSSnapshot.from_path(
        write_sqlite_snapshot(reports, provenance, tmp_path / "routes.sqlite")
    )
    assert indexed.contingency(scope, "cardiac failure").drug_total == 2


# -- names --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "searchable"),
    [
        ("osimertinib", "osimertinib"),
        ("AZD9291", "AZD9291"),
        ("TAGRISSO", "TAGRISSO"),
        ("tagrissö", "tagrisso"),
        ("泰瑞沙", None),
        ("泰瑞沙 tablets", None),
        ("осимертиниб", None),
        ("   ", None),
    ],
)
def test_only_latin_script_names_have_a_searchable_form(name, searchable):
    assert openfda_search_name(name) == searchable


# -- the other entry points share the scope ------------------------------------


@respx.mock
async def test_signal_endpoint_uses_the_same_searchable_scope(tmp_path):
    from pydantic import SecretStr

    from safety_agent.api.service import ServiceContext
    from safety_agent.core.config import Settings
    from safety_agent.evidence.evimed import EviMedEvidenceClient

    fake = RecordedOpenFDA()
    respx.get(f"{BASE}/{EVENT_ENDPOINT}").mock(side_effect=fake)
    service = ServiceContext(
        Settings(deepseek_api_key=SecretStr("")),
        openfda=_client(),
        llm=None,
        evidence=EviMedEvidenceClient("", ""),
        jobs_dir=tmp_path,
        drug_aliases=tuple(ADR_001["drugAliases"]),
        suspect_roles=frozenset(ADR_001["suspectRoles"]),
        drug_routes=tuple(ADR_001["administrationRoutes"]),
        study_date_from=ADR_001["studyDateFrom"],
        study_date_to=ADR_001["studyDateTo"],
        background_date_from=ADR_001["backgroundDateFrom"],
        background_date_to=ADR_001["backgroundDateTo"],
    )
    try:
        result = await service.compute_signals("osimertinib", ["cardiac failure"])
    finally:
        await service.aclose()

    assert result.rows[0]["a"] == 25
    assert result.suspect_roles == ["PS", "SS"]
    assert all(search.isascii() for search in fake.searches if search)
    scoped = [s for s in fake.searches if s and "drugcharacterization" in s]
    assert scoped and all('drugadministrationroute:"048"' in s for s in scoped)


def test_runner_refuses_an_unknown_route_by_name(tmp_path):
    import evimed_runner

    request = tmp_path / "request.json"
    request.write_text(
        json.dumps({"drug": "osimertinib", "administrationRoutes": ["by mouth with food"]}),
        encoding="utf-8",
    )
    out = tmp_path / "out"
    assert evimed_runner.run(request, out) == 1
    result = json.loads((out / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert "unknown administration route 'by mouth with food'" in result["error"]
    assert "048" in result["error"]
