"""Uploaded full texts have to appear in the PRISMA identification arm."""
from new_meta.core.project import PRISMAFlow


def test_an_unmatched_upload_is_an_identified_record() -> None:
    flow = PRISMAFlow()
    flow.records_identified = 700
    flow.records_after_dedup = 690
    flow.records_from_database = 700

    # What main.py does once match_user_pdfs reports unmatched uploads.
    extra = 3
    flow.records_from_user_upload = extra
    flow.records_identified += extra
    flow.records_after_dedup += extra

    identification = flow.to_dict()["identification"]
    assert identification["records_from_user_upload"] == 3
    assert identification["records_identified"] == 703
    assert identification["records_after_dedup"] == 693
    # The upload arm must not be mistaken for duplicate removal.
    assert identification["duplicates_removed"] == 10


def test_no_upload_leaves_the_arm_empty() -> None:
    flow = PRISMAFlow()
    flow.records_identified = 120
    flow.records_after_dedup = 118
    assert flow.to_dict()["identification"]["records_from_user_upload"] == 0
