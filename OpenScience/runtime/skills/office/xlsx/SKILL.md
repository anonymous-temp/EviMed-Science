---
name: xlsx
description: Read, edit in place, and create Excel workbooks (.xlsx) and spreadsheet data - budgets, sales tables, reports with real formulas, totals rows, charts and formatting. Use whenever a spreadsheet or CSV is an input or the deliverable, and whenever numbers must be calculated by formulas that stay live.
license: MIT
---

# Excel workbooks

Pinned libraries: `openpyxl` (read and edit), `XlsxWriter` (create, charts), `pandas` (analysis). Keep the source data and the workbook in the workspace.

## Read

```bash
python3 scripts/xlsx_tool.py describe sales.xlsx                         # sheets, sizes, first rows, formula / chart counts
python3 scripts/xlsx_tool.py csv sales.xlsx --sheet Data --range A1:E20  # values as CSV
```

For analysis load the sheet with pandas (`pd.read_excel(path, sheet_name="Data")`) and calculate there; write results back as formulas only when the user needs the workbook to stay live.

## Edit a workbook that already exists

```python
import openpyxl
book = openpyxl.load_workbook("sales.xlsx")            # NOT data_only=True: saving that version replaces formulas with their values
sheet = book["Data"]
sheet["F1"] = "Revenue"
for row in range(2, sheet.max_row + 1):
    sheet[f"F{row}"] = f"=D{row}*E{row}"                # a real formula per row
last = sheet.max_row
sheet[f"A{last + 1}"] = "Total"
sheet[f"F{last + 1}"] = f"=SUM(F2:F{last})"             # totals are formulas too, never pasted numbers
book.save("sales.xlsx")
```

- Derived columns, subtotals and totals are formulas; constants and assumptions sit in labelled cells that the formulas point to, not inside the formulas.
- openpyxl keeps the charts and images it can read, but can lose formatting details, slicers, form controls and (without `keep_vba=True`) macros; compare `describe` before and after, and say so if something could not be kept.
- Number formats (`"#,##0.00"`, `"0.0%"`, dates) and `sheet.freeze_panes`, `sheet.auto_filter.ref`, column widths are set on the cells and sheet, not by typing text.

## Create

New workbook with formulas, formats and charts: XlsxWriter (`write_formula`, `add_format`, `add_chart`, `add_table`, `conditional_format`). A CSV to a plain one-sheet workbook: `python3 scripts/create_xlsx.py --input data.csv --output data.xlsx`. Sheet names are at most 31 characters; write whole rows or columns (`write_row`, `write_column`) for large data.

## Make the formulas show their values, then check

A workbook written by openpyxl or XlsxWriter holds formulas without results: previews, pandas and some viewers show empty cells or zeros until something recalculates. Always finish with

```bash
python3 scripts/xlsx_tool.py recalc budget.xlsx --out budget-calculated.xlsx
```

It refreshes every formula with the bundled LibreOffice Kit, keeps them as formulas, and reports formulas without a result and cells in error (`#REF!`, `#DIV/0!`, `#NAME?`, `#VALUE!`). Fix every reported cell, recalculate again, and deliver the calculated file (move it over the working name once it is clean). `python3 scripts/xlsx_tool.py check file.xlsx` repeats the report without writing; `python3 ../shared/office_kit.py check file.xlsx` is the kernel's own structural check of the package.

Say what the workbook contains and where the totals are; if a figure depends on an assumption the user did not give, name the assumption and where to change it.
