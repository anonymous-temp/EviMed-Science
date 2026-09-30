"""Exercise real BIFF continued strings and Boolean cells using a neutral fixture."""
from pathlib import Path

import xlrd


def verify(path: Path) -> None:
    book = xlrd.open_workbook(path)
    assert book.sheet_names() == ["Measurements", "Metadata"]
    sheet = book.sheet_by_name("Measurements")
    assert (sheet.nrows, sheet.ncols) == (3, 4)
    assert sheet.row_values(0) == ["sample_id", "measurement", "included", "notes"]
    assert sheet.cell_value(1, 0) == "sample-a"
    assert sheet.cell_value(1, 1) == 1.25
    assert sheet.cell_type(1, 2) == xlrd.XL_CELL_BOOLEAN
    assert sheet.cell_value(1, 2) == 1
    assert sheet.cell_value(2, 2) == 0
    assert sheet.cell_value(1, 3) == "neutral continued text " * 600
    assert book.sheet_by_name("Metadata").cell_value(0, 0) == "Synthetic software parser regression fixture"


if __name__ == "__main__":
    verify(Path(__file__).with_name("fixtures") / "legacy-spreadsheet.xls")
    print("Legacy spreadsheet parsing verified: continued strings, Boolean cells, and multiple sheets.")
