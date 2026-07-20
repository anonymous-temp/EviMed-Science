"""Bundled pharmacological-class registry contracts."""

from safety_agent.drug_classes import DrugClassRegistry


def test_bundled_registry_contains_the_four_publication_classes():
    registry = DrugClassRegistry.bundled()

    assert set(registry.ids()) >= {"sglt2i", "glp1ra-products", "parpi", "jaki"}
    assert {member.id for member in registry.get("sglt2i").members} >= {
        "dapagliflozin",
        "canagliflozin",
        "empagliflozin",
        "ertugliflozin",
        "tofogliflozin",
        "remogliflozin",
    }
    assert {member.id for member in registry.get("parpi").members} >= {
        "olaparib",
        "niraparib",
        "rucaparib",
        "talazoparib",
    }
    assert {member.id for member in registry.get("jaki").members} >= {
        "ruxolitinib",
        "tofacitinib",
        "baricitinib",
        "upadacitinib",
    }


def test_registry_distinguishes_product_members_and_fixed_combination_exclusions():
    definition = DrugClassRegistry.bundled().get("glp1ra-products")

    assert definition.member("victoza").canonical_name == "liraglutide"
    assert definition.member("saxenda").canonical_name == "liraglutide"
    assert definition.member("victoza").match_names != definition.member("saxenda").match_names
    assert {name.casefold() for name in definition.excluded_products} >= {
        "xultophy",
        "soliqua",
        "adlyxin",
    }


def test_registry_records_local_atc_and_primary_publication_provenance():
    definition = DrugClassRegistry.bundled().get("sglt2i")

    assert "A10BK" in definition.atc_codes
    assert any("ATC_DDD_Index_merged.xlsx" in source for source in definition.sources)
    assert any(source.startswith("https://") for source in definition.sources)
    assert definition.therapeutic_comparator_names


def test_registry_alias_resolution_is_unambiguous_within_a_class():
    registry = DrugClassRegistry.bundled()

    assert registry.get("sglt2i").resolve_member("Jardiance").id == "empagliflozin"
    assert registry.get("parpi").resolve_member("Lynparza").id == "olaparib"
    assert registry.get("jaki").resolve_member("Xeljanz XR").id == "tofacitinib-xr"
