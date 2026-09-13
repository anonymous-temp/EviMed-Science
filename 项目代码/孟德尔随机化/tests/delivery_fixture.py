"""Real, small figure files for tests of delivery and metadata boundaries."""
import json

from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas


def ready_delivery(result, root):
    root.mkdir(parents=True, exist_ok=True)
    result.raw_data_path = root
    result.interpretation = "The estimate requires the stated instrumental-variable assumptions."
    result.interpretation_status = "succeeded"
    result.interpretation_error_code = ""
    ledger = {}
    for name in ("scatter_plot", "forest_plot", "funnel_plot", "loo_plot"):
        pdf = root / f"{name}.pdf"
        page = canvas.Canvas(str(pdf))
        page.drawString(30, 700, name)
        page.line(30, 30, 200, 200)
        page.showPage()
        page.save()
        png = root / f"{name}.png"
        image = Image.new("RGB", (200, 200), "white")
        ImageDraw.Draw(image).line([(10, 190), (90, 130), (190, 10)], fill="black", width=3)
        image.save(png)
        result.plots[f"{name}_pdf"] = pdf
        result.plots[f"{name}_png"] = png
        ledger[name] = {"status": "ready", "reason_code": "", "pages": 1}
    (root / "diagnostic-plots.json").write_text(json.dumps(ledger))
    return result
