"""Checklist item numbers must be the published ones (R031).

Each rubric's item-number set is compared with the numbers printed in the
guideline it names. A rubric whose numbers do not match tells the author to fix
"CONSORT item 3a" when the published 3a is a different requirement entirely.
"""

import pytest
import yaml

from src.utils.rubric_loader import RubricLoader

# Transcribed from the published checklists cited in each YAML's `source` block.
PUBLISHED_ITEM_NUMBERS = {
    "consort_2025": [
        "1a", "1b", "2", "3", "4", "5a", "5b", "6", "7", "8", "9", "10", "11",
        "12a", "12b", "13", "14", "15", "16a", "16b", "17a", "17b", "18", "19",
        "20a", "20b", "21a", "21b", "21c", "21d", "22a", "22b", "23a", "23b",
        "24a", "24b", "25", "26", "27", "28", "29", "30",
    ],
    "stard": [
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "10a", "10b", "11",
        "12a", "12b", "13a", "13b", "14", "15", "16", "17", "18", "19", "20",
        "21a", "21b", "22", "23", "24", "25", "26", "27", "28", "29", "30",
    ],
    "cheers_2022": [str(n) for n in range(1, 29)],
    "agree_ii": [str(n) for n in range(1, 24)],
}

VERSIONED = {
    "consort_2025": ("CONSORT 2025", "10.1136/bmj-2024-081123"),
    "stard": ("STARD 2015", "10.1136/bmj.h5527"),
    "cheers_2022": ("CHEERS 2022", "10.1136/bmj-2021-067975"),
    "agree_ii": ("AGREE II", "10.1503/cmaj.090449"),
}


@pytest.fixture
def loader():
    return RubricLoader()


@pytest.mark.parametrize("rubric_name", sorted(PUBLISHED_ITEM_NUMBERS))
def test_item_numbers_match_the_published_checklist(loader, rubric_name):
    items = loader.load_rubric(rubric_name)
    assert [item.item_number for item in items] == PUBLISHED_ITEM_NUMBERS[rubric_name]


@pytest.mark.parametrize("rubric_name", sorted(VERSIONED))
def test_every_updated_rubric_names_its_source(loader, rubric_name):
    path = loader.rubrics_dir / f"{rubric_name}.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    expected_name, expected_doi = VERSIONED[rubric_name]
    assert data["name"] == expected_name
    assert data["source"]["doi"] == expected_doi
    assert data["source"]["citation"]


def test_the_guideline_appraisal_rubric_is_named_agree_ii_not_grade(loader):
    """The file used to be grade.yaml titled "GRADE for Clinical Guidelines",
    but its items are AGREE II's, in AGREE II's six domains."""
    assert "grade" not in loader.list_available_rubrics()
    items = loader.load_rubric("agree_ii")
    assert all(item.checklist_name == "AGREE II" for item in items)
    domains = {item.category.split(" - ", 1)[1] for item in items}
    assert domains == {
        "Scope and Purpose", "Stakeholder Involvement", "Rigour of Development",
        "Clarity of Presentation", "Applicability", "Editorial Independence",
    }


def test_consort_2010_is_gone_and_rct_maps_to_consort_2025(loader):
    assert "consort_2010" not in loader.list_available_rubrics()
    items = loader.load_rubrics_for_study_types(["RCT"])
    assert {item.checklist_name for item in items} == {"CONSORT 2025"}


def test_consort_2025_has_the_trial_design_and_open_science_items(loader):
    """consort_2010.yaml had no trial-design item and no open-science section."""
    by_number = {item.item_number: item for item in loader.load_rubric("consort_2025")}
    assert "trial design" in by_number["9"].question.casefold()
    for number in ("2", "3", "4", "5a", "5b"):
        assert by_number[number].category.startswith("Open science")


def test_stard_has_the_sample_size_and_adverse_event_items(loader):
    """The 27-item file omitted both, so its numbers named other items."""
    by_number = {item.item_number: item for item in loader.load_rubric("stard")}
    assert "sample size" in by_number["18"].question.casefold()
    assert "adverse event" in by_number["25"].question.casefold()


def test_cheers_2022_carries_the_three_items_2022_added(loader):
    by_number = {item.item_number: item for item in loader.load_rubric("cheers_2022")}
    assert "distributional effects" in by_number["19"].question.casefold()
    assert "engage" in by_number["21"].question.casefold()
    assert "engagement" in by_number["25"].question.casefold()


@pytest.mark.parametrize("rubric_name", sorted(PUBLISHED_ITEM_NUMBERS))
def test_item_ids_are_unique_within_a_rubric(loader, rubric_name):
    ids = [item.item_id for item in loader.load_rubric(rubric_name)]
    assert len(ids) == len(set(ids))
