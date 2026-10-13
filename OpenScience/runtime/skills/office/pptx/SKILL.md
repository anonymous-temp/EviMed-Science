---
name: pptx
description: Read, edit in place, restructure, and create PowerPoint decks (.pptx) - business plans, reports, lectures, with charts, tables, notes and a chosen palette. Use whenever a .pptx is an input or the deliverable, including follow-ups such as splitting a crowded slide, reordering, or switching the whole deck to a dark or light palette.
license: MIT
---

# PowerPoint decks

Pinned library: `python-pptx`. For a designed deck from one sentence or a document, the `dsh-ppt` skill also exists; use this skill when the deck must be edited afterwards, contains native charts and tables, or already exists.

## Read

```bash
python3 scripts/pptx_tool.py outline deck.pptx    # slides, layouts, every shape with id, position, text; notes; shapes outside the slide
```

## Create

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt
deck = Presentation(); deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
slide = deck.slides.add_slide(deck.slide_layouts[5])         # "Title Only"
slide.shapes.title.text = "Market size"                        # a real title per slide: the outline and navigation use it
data = CategoryChartData(); data.categories = ["2024", "2025", "2026"]; data.add_series("Revenue", [12, 18, 25])
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.8), Inches(1.6), Inches(11.5), Inches(4.8), data)
slide.notes_slide.notes_text_frame.text = "Speaker notes"
deck.save("deck.pptx")
```

- The default template is 4:3: after setting 16:9 place the title placeholder yourself (`title.left/top/width/height`) or use shapes you position.
- One idea per slide: a title that states the point, at most six short lines, body text 18 pt or larger, a chart or table instead of a paragraph of numbers. Set font sizes explicitly; python-pptx does not shrink text to fit, so estimate the lines a box can hold.
- Charts are native (`add_chart`), so the user can edit their data; images are local files only.

## Edit and restructure what exists

Edit, do not rebuild. Each command edits the deck itself (add `--out new.pptx` to keep the original); slides and shape ids are the ones `outline` prints.

```bash
python3 scripts/pptx_tool.py duplicate deck.pptx --slide 3                    # copy of slide 3 right after it, charts and pictures included
python3 scripts/pptx_tool.py delete-shapes deck.pptx --slide 3 --ids 5,6      # what moves to the other slide goes from this one
python3 scripts/pptx_tool.py set-text deck.pptx --slide 4 --shape 2 --text "Market size (2)\nSecond line"
python3 scripts/pptx_tool.py move deck.pptx --slide 4 --to 2
python3 scripts/pptx_tool.py delete deck.pptx --slide 9
python3 scripts/pptx_tool.py theme deck.pptx --mode dark                      # or --mode light; --recolor also fixes colours set explicitly on shapes
```

To split a crowded slide: `outline`, `duplicate` it, `delete-shapes` the second half on the first slide and the first half on the copy, `set-text` both titles. `theme` swaps the scheme roles of the master and the palette, so text, backgrounds and charts follow; colours typed as RGB on a shape are listed for review (or fixed with `--recolor`). Other slides' content never changes in these operations - check with `outline` afterwards.

## Check and deliver

Render the slides you changed and look at them if you can read images: `python3 ../shared/office_kit.py render --input deck.pptx --output-dir preview-1 --pages 3,4 --dpi 110` (a new directory each time). Check clipping, overlaps, contrast, chart labels against the data. `outline` flags shapes outside the slide. Leave the deck in the workspace under its name; a follow-up edit keeps the same file.
