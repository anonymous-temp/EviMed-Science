"""The survival-curve digitizer, measured against figures drawn from known curves.

``fixtures/vcr_curves/`` holds Kaplan-Meier figures drawn by ``make_fixtures.py``
from a known step function, each with a ``.truth.json``. The digitizer's error
is measured against that truth, never against another digitizer, and the targets
are the build brief's: at most 0.02 in survival and at most 1% of the x range in
time, for one curve, two curves of different colours, gridlines, censoring marks
and JPEG artefacts.

How the error is measured. A step function has no value *at* an event, and a
curve a line wide cannot say which of two events a pixel belongs to, so a point
is judged against the curve's graph, vertical strokes included: it is covered
when some point of the true graph lies within the time tolerance and the
survival tolerance of it together (``covering``, scaled so 1.0 is exactly on
the tolerance). Three more numbers say what that hides: ``flat`` is the survival
error of points that sit on a plateau (pure calibration error, no timing in it),
``drops`` is the time error at events far from any other (how late the digitized
curve falls), and the monotonicity repairs the digitizer made are counted.
"""

import hashlib
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vcr_curve_digitize as digitizer  # noqa: E402

try:
    import numpy  # noqa: F401
    import PIL  # noqa: F401
    import scipy  # noqa: F401

    HAVE_LIBRARIES = True
except ImportError:  # pragma: no cover - the image and CI ship all three
    HAVE_LIBRARIES = False

FIXTURES = ROOT / "test" / "fixtures" / "vcr_curves"
TIME_TOLERANCE = 0.01   # of the x range
SURVIVAL_TOLERANCE = 0.02


def load_truth(name):
    return json.loads((FIXTURES / (name + ".truth.json")).read_text(encoding="utf-8"))


def level(curve, t):
    value = 1.0
    for time, survival in zip(curve["times"], curve["surv"]):
        if time <= t:
            value = survival
        else:
            break
    return value


def covering(points, curve, x_range):
    """Largest scaled distance from a digitized point to the true graph (<= 1.0 meets both targets)."""
    time_tol = TIME_TOLERANCE * x_range
    times, surv = curve["times"], curve["surv"]
    worst = 0.0
    for point in points:
        t, s = point["time"], point["surv"]
        best = float("inf")
        for k in range(len(times)):
            end = times[k + 1] if k + 1 < len(times) else max(times[-1], t)
            dt = max(0.0, times[k] - t, t - end) / time_tol
            best = min(best, max(dt, abs(s - surv[k]) / SURVIVAL_TOLERANCE))
            if k > 0:
                dt = abs(t - times[k]) / time_tol
                low, high = min(surv[k], surv[k - 1]), max(surv[k], surv[k - 1])
                best = min(best, max(dt, max(0.0, low - s, s - high) / SURVIVAL_TOLERANCE))
        worst = max(worst, best)
    return worst


def flat_error(points, curve, per_pixel):
    """Survival error of points whose neighbourhood (three pixels either way) holds a single level."""
    worst = 0.0
    reach = 3 * per_pixel
    for point in points:
        window = {level(curve, point["time"] - reach), level(curve, point["time"] + reach)}
        window.update(s for k, s in zip(curve["times"], curve["surv"]) if point["time"] - reach <= k <= point["time"] + reach)
        if len(window) == 1:
            worst = max(worst, abs(point["surv"] - next(iter(window))))
    return worst


def drop_error(points, curve, per_pixel):
    """Largest time error at events at least twelve pixels from the neighbouring ones, in pixels."""
    worst = 0.0
    times = curve["times"]
    for k in range(1, len(times)):
        before, after = curve["surv"][k - 1], curve["surv"][k]
        left = times[k] - times[k - 1]
        right = (times[k + 1] - times[k]) if k + 1 < len(times) else 1e9
        if before - after < 0.02 or left < 12 * per_pixel or right < 12 * per_pixel:
            continue
        if times[k] > points[-1]["time"] or times[k] < points[0]["time"]:
            continue
        middle = (before + after) / 2
        found = next((p["time"] for p in points if p["surv"] <= middle + 1e-9), None)
        if found is not None:
            worst = max(worst, abs(found - times[k]) / per_pixel)
    return worst


def nearest_truth(truth, color):
    def distance(curve):
        return sum(abs(int(curve["color"][i:i + 2], 16) - int(color[i:i + 2], 16)) for i in (1, 3, 5))

    return min(truth["curves"], key=distance)


@unittest.skipUnless(HAVE_LIBRARIES, "numpy, Pillow and scipy are the runtime image's")
class Measured(unittest.TestCase):
    """Numbers are printed (``-v``) so the report can state what was measured."""

    measured = {}

    def digitize(self, name, curves, extension="png", **extra):
        truth = load_truth(name.split(".")[0])
        request = {"calibration": truth["calibration"], "curves": curves, **extra}
        result = digitizer.digitize(request, FIXTURES / ("%s.%s" % (name, extension)))
        return truth, result

    def assert_within_targets(self, name, truth, result, *, flat_limit, expect=None):
        self.assertEqual(result["outcome"], "digitized", result.get("message"))
        x_range = truth["calibration"]["x"]["max"] - truth["calibration"]["x"]["min"]
        per_pixel = result["resolution"]["timePerPixel"]
        for curve in result["curves"]:
            expected = nearest_truth(truth, curve["color"]) if expect is None else expect[curve["name"]]
            cover = covering(curve["points"], expected, x_range)
            flat = flat_error(curve["points"], expected, per_pixel)
            drops = drop_error(curve["points"], expected, per_pixel)
            self.measured[(name, curve["name"])] = (cover, flat, drops, drops * per_pixel / x_range)
            print("  %-22s %-12s covering %.2f   flat %.4f   drops %.1f px (%.2f%% of range)   repairs %d" % (
                name, curve["name"], cover, flat, drops, 100 * drops * per_pixel / x_range, curve["quality"]["monotonicityRepairs"]["count"]))
            self.assertLessEqual(cover, 1.0, "%s %s is outside 0.02 survival / 1%% of the range" % (name, curve["name"]))
            self.assertLessEqual(flat, flat_limit)
            self.assertLessEqual(drops * per_pixel / x_range, TIME_TOLERANCE)
            self.assertEqual([p["time"] for p in curve["points"]], sorted(p["time"] for p in curve["points"]))
            survival = [p["surv"] for p in curve["points"]]
            self.assertTrue(all(a >= b for a, b in zip(survival, survival[1:])), "survival never rises")
            self.assertTrue(all(0 < v <= 1 for v in survival))
        return result

    def test_one_curve_with_censoring_crosses(self):
        truth, result = self.digitize("km_single", [{}])
        self.assert_within_targets("km_single", truth, result, flat_limit=0.02)
        curve = result["curves"][0]
        self.assertEqual(result["anchor"], "ticks")
        self.assertEqual((result["ticks"]["x"], result["ticks"]["y"]), (7, 6))
        self.assertTrue(result["ticks"]["xStepRound"] and result["ticks"]["yStepRound"])
        self.assertEqual(curve["colorSource"], "only_colour")
        self.assertGreater(curve["quality"]["markersIgnored"], 5, "the censoring crosses were seen and not followed")
        self.assertGreater(curve["quality"]["xCoverage"], 0.98)
        self.assertEqual(curve["quality"]["bridgedColumns"], 0)
        self.assertTrue(curve["quality"]["startSurvival"]["anchored"])
        self.assertEqual(curve["points"][0]["surv"], 1.0)
        self.assertAlmostEqual(result["resolution"]["timePerPixel"], 60 / (result["plotArea"]["right"] - result["plotArea"]["left"]), delta=0.02)

    def test_two_curves_of_different_colours_with_gridlines_and_a_legend(self):
        truth, result = self.digitize("km_two_colors", [{"name": "control", "color": "#d62728"}, {"name": "experimental", "color": "#1f77b4"}])
        self.assert_within_targets("km_two_colors", truth, result, flat_limit=0.02,
                                   expect={"control": truth["curves"][0], "experimental": truth["curves"][1]})
        self.assertEqual(result["palette"], ["#d62728", "#1f77b4"])
        self.assertNotEqual(result["curves"][0]["points"], result["curves"][1]["points"])

    def test_a_stated_colour_is_matched_to_the_curve_nearest_in_hue(self):
        truth, result = self.digitize("km_two_colors", [{"name": "control", "color": "#ff0000"}, {"name": "experimental", "color": "#0000ff"}])
        self.assertEqual(result["outcome"], "digitized")
        self.assertEqual([curve["color"] for curve in result["curves"]], ["#d62728", "#1f77b4"])
        self.assertEqual([curve["colorSource"] for curve in result["curves"]], ["stated", "stated"])

    def test_legend_order_names_the_curves_by_their_swatches(self):
        truth, result = self.digitize("km_two_colors", [{"name": "first", "legendOrder": 1}, {"name": "second", "legendOrder": 2}])
        self.assertEqual([curve["color"] for curve in result["curves"]], ["#d62728", "#1f77b4"])
        self.assertEqual([curve["colorSource"] for curve in result["curves"]], ["legend", "legend"])
        _, reversed_ = self.digitize("km_two_colors", [{"name": "first", "legendOrder": 2}, {"name": "second", "legendOrder": 1}])
        self.assertEqual([curve["color"] for curve in reversed_["curves"]], ["#1f77b4", "#d62728"])
        # A figure with no legend has nothing to order by: refused, never guessed from a dashed line's dashes.
        _, absent = self.digitize("km_dashed", [{"name": "a", "legendOrder": 1}, {"name": "b", "legendOrder": 2}])
        self.assertEqual((absent["outcome"], absent["reason"]), ("refused", "legend_not_found"))
        _, beyond = self.digitize("km_two_colors", [{"name": "a", "legendOrder": 3}])
        self.assertEqual((beyond["outcome"], beyond["reason"]), ("refused", "legend_not_found"))

    def test_jpeg_artefacts(self):
        truth, result = self.digitize("km_two_colors", [{"name": "control", "color": "#d62728"}, {"name": "experimental", "color": "#1f77b4"}], extension="jpg")
        self.assertEqual(result["image"]["format"], "JPEG")
        self.assert_within_targets("km_two_colors.jpg (q60)", truth, result, flat_limit=0.02,
                                   expect={"control": truth["curves"][0], "experimental": truth["curves"][1]})

    def test_a_black_curve_on_a_percent_axis_with_text_across_it(self):
        truth, result = self.digitize("km_black_percent", [{"color": "#000000"}])
        self.assert_within_targets("km_black_percent", truth, result, flat_limit=0.02)
        self.assertEqual(result["calibration"]["y"]["scale"], "percent")
        self.assertEqual(result["palette"], [], "black is not a listed colour")
        self.assertGreater(result["curves"][0]["quality"]["markersIgnored"], 3, "the vertical censoring ticks")

    def test_a_dashed_curve(self):
        truth, result = self.digitize("km_dashed", [{"name": "placebo", "color": "#ff7f0e"}, {"name": "active", "color": "#9467bd"}])
        self.assert_within_targets("km_dashed", truth, result, flat_limit=0.02,
                                   expect={"placebo": truth["curves"][0], "active": truth["curves"][1]})

    def test_two_curves_that_overlap_report_what_they_hid(self):
        truth, result = self.digitize("km_two_panels", [{"name": "placebo", "color": "#d62728"}, {"name": "active", "color": "#1f77b4"}])
        self.assert_within_targets("km_two_panels", truth, result, flat_limit=0.02,
                                   expect={"placebo": truth["curves"][0], "active": truth["curves"][1]})
        # The red curve is drawn first and the blue one over it: where they coincide the red is not there to read.
        self.assertGreater(result["curves"][0]["quality"]["bridgedColumns"], 0)
        self.assertEqual(result["curves"][1]["quality"]["bridgedColumns"], 0)
        # The risk table under the plot has axes of its own; the curve's colour says which panel.
        self.assertLess(result["plotArea"]["bottom"], 380)

    def test_without_tick_marks_the_axis_ends_carry_the_stated_values_and_the_result_says_so(self):
        truth, result = self.digitize("km_no_ticks", [{}])
        self.assert_within_targets("km_no_ticks", truth, result, flat_limit=0.02)
        self.assertEqual(result["anchor"], "plot_area")
        self.assertIsNone(result["ticks"])
        self.assertTrue(any(w.startswith("no_tick_marks_found") for w in result["warnings"]))

    def test_a_stated_plot_area_is_used_as_it_is(self):
        truth = load_truth("km_single")
        area = truth["plotArea"]
        # The caller's box is the axes rectangle, whose edges are the axis limits: 0 to 60 and 0 to 1.05.
        calibration = {"x": {"min": 0, "max": 60, "unit": "months"}, "y": {"min": 0, "max": 1.05, "scale": "fraction"}}
        result = digitizer.digitize({"calibration": calibration, "curves": [{}], "plotArea": area}, FIXTURES / "km_single.png")
        self.assertEqual(result["outcome"], "digitized", result.get("message"))
        self.assertEqual((result["anchor"], result["plotArea"]["source"]), ("plot_area", "stated"))
        self.assert_within_targets("km_single (plotArea)", truth, result, flat_limit=0.02)

    def test_the_same_pixels_give_the_same_points(self):
        first = self.digitize("km_two_colors", [{"color": "#d62728"}, {"color": "#1f77b4"}])[1]
        second = self.digitize("km_two_colors", [{"color": "#d62728"}, {"color": "#1f77b4"}])[1]
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        self.assertEqual(first["algorithm"]["name"], digitizer.NAME)
        self.assertEqual(first["algorithm"]["version"], digitizer.VERSION)
        self.assertEqual(first["parameters"], digitizer.PARAMETERS)
        self.assertIn("numpy", first["algorithm"]["libraries"])

    def test_quality_indicators_are_all_there(self):
        _, result = self.digitize("km_single", [{}])
        quality = result["curves"][0]["quality"]
        for key in ("points", "firstTime", "lastTime", "xCoverage", "observedFraction", "bridgedColumns", "monotonicityRepairs",
                    "clippedToRange", "eventsSnapped", "markersIgnored", "pixelSupport", "startSurvival"):
            self.assertIn(key, quality)
        self.assertEqual(set(quality["monotonicityRepairs"]), {"count", "largestRise"})
        self.assertEqual(set(quality["pixelSupport"]), {"curvePixels", "supportedColumns", "medianThicknessPx"})
        self.assertEqual(set(result["resolution"]), {"timePerPixel", "survivalPerPixel"})
        self.assertLessEqual(len(result["curves"][0]["points"]), digitizer.PARAMETERS["maxPoints"])


@unittest.skipUnless(HAVE_LIBRARIES, "numpy, Pillow and scipy are the runtime image's")
class Refusals(unittest.TestCase):
    def digitize(self, name, curves, calibration=None, **extra):
        truth = load_truth(name)
        return digitizer.digitize({"calibration": truth["calibration"] if calibration is None else calibration, "curves": curves, **extra}, FIXTURES / (name + ".png"))

    def test_impossible_calibrations_are_refused_with_what_is_impossible(self):
        good = {"x": {"min": 0, "max": 60, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}

        def with_(**patch):
            body = json.loads(json.dumps(good))
            for path, value in patch.items():
                axis, key = path.split("__")
                body[axis][key] = value
            return body

        cases = [
            (with_(x__max=0), "x.max"), (with_(x__max=-5), "x.max"), (with_(x__min=-1), "x.min"), (with_(x__unit=""), "x.unit"),
            (with_(x__min="zero"), "x.min"), (with_(y__max=5), "y.max"), (with_(y__max=0), "y.max"), (with_(y__min=-0.2), "y.min"),
            (with_(y__min=0.99), "y.min"), (with_(y__scale="pct"), "y.scale"), (with_(y__max=1.02, y__min=0.99), "y.min"),
            ({"x": good["x"]}, "y.min"), ({}, "x.min"), ("axis", "calibration"),
        ]
        for calibration, mentions in cases:
            result = self.digitize("km_single", [{}], calibration=calibration)
            self.assertEqual((result["outcome"], result["reason"]), ("refused", "calibration_invalid"), calibration)
            self.assertIn(mentions, result["message"], calibration)
        percent = {"x": good["x"], "y": {"min": 0, "max": 100, "scale": "fraction"}}
        self.assertEqual(self.digitize("km_single", [{}], calibration=percent)["reason"], "calibration_invalid")

    def test_a_wrong_tick_range_is_reported_not_silently_used(self):
        # Seven ticks stated as 0 to 66 is a step of 11: not a spacing a plot's author chooses.
        result = self.digitize("km_single", [{}], calibration={"x": {"min": 0, "max": 66, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}})
        self.assertEqual(result["outcome"], "digitized")
        self.assertFalse(result["ticks"]["xStepRound"])
        self.assertTrue(any(w.startswith("x_tick_spacing_unusual") for w in result["warnings"]))

    def test_a_stated_plot_area_must_lie_inside_the_image(self):
        for area in ({"left": -5, "top": 10, "right": 300, "bottom": 300}, {"left": 100, "top": 10, "right": 90, "bottom": 300},
                     {"left": 10, "top": 10, "right": 9000, "bottom": 300}, {"left": 10, "top": 10, "right": 30, "bottom": 300}, {"left": 10}, "box"):
            result = self.digitize("km_single", [{}], plotArea=area)
            self.assertEqual((result["outcome"], result["reason"]), ("refused", "plot_area_invalid"), area)

    def test_curves_that_cannot_be_attributed_are_refused_with_what_was_found(self):
        two = self.digitize("km_two_colors", [{}])
        self.assertEqual((two["outcome"], two["reason"]), ("refused", "colour_required"))
        self.assertIn("#d62728", two["message"])
        green = self.digitize("km_two_colors", [{"color": "#2ca02c"}])
        self.assertEqual(green["reason"], "colour_not_found")
        self.assertEqual(green["detail"]["palette"], ["#d62728", "#1f77b4"])
        same = self.digitize("km_two_colors", [{"color": "#ff0000"}, {"color": "#d62728"}])
        self.assertEqual(same["reason"], "colour_ambiguous")
        for bad in ([], [{}, {}, {}], "red", [5]):
            self.assertEqual(self.digitize("km_single", bad)["reason"], "curves_invalid", bad)
        self.assertEqual(self.digitize("km_single", [{"color": "red"}])["reason"], "colour_invalid")
        self.assertEqual(self.digitize("km_single", [{"color": "#ff0000"}])["reason"], "colour_not_found")

    def test_two_panels_with_a_black_curve_is_ambiguous_and_names_the_candidates(self):
        result = self.digitize("km_two_panels_black", [{"color": "#000000"}])
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "plot_area_ambiguous"))
        candidates = result["detail"]["candidates"]
        self.assertEqual(len(candidates), 2)
        self.assertTrue(all(set(box) == {"left", "top", "right", "bottom"} for box in candidates))
        # Stating the box the curve is in settles it.
        truth = load_truth("km_two_panels_black")
        settled = self.digitize("km_two_panels_black", [{"color": "#000000"}], plotArea=truth["plotArea"],
                                calibration={"x": {"min": 0, "max": 36, "unit": "months"}, "y": {"min": 0, "max": 1.05, "scale": "fraction"}})
        self.assertEqual(settled["outcome"], "digitized", settled.get("message"))

    def test_an_image_that_is_not_a_png_or_a_jpeg_or_is_too_large_is_refused(self):
        from PIL import Image

        directory = pathlib.Path(tempfile.mkdtemp(prefix="vcr-dig-"))
        self.addCleanup(shutil.rmtree, directory, True)
        gif = directory / "figure.gif"
        Image.new("RGB", (300, 300), "white").save(gif)
        text = directory / "figure.png"
        text.write_bytes(b"not an image at all")
        tiny = directory / "tiny.png"
        Image.new("RGB", (50, 50), "white").save(tiny)
        request = {"calibration": load_truth("km_single")["calibration"], "curves": [{}]}
        self.assertEqual(digitizer.digitize(request, gif)["reason"], "image_unreadable")
        self.assertEqual(digitizer.digitize(request, text)["reason"], "image_unreadable")
        self.assertEqual(digitizer.digitize(request, tiny)["reason"], "image_unreadable")
        large = digitizer.digitize(request, FIXTURES / "km_single.png", max_pixels=1000)
        self.assertEqual((large["outcome"], large["reason"]), ("refused", "image_too_large"))
        blank = directory / "blank.png"
        Image.new("RGB", (400, 300), "white").save(blank)
        self.assertEqual(digitizer.digitize(request, blank)["reason"], "plot_area_not_found")

    def test_a_curve_that_rises_is_not_survival(self):
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (600, 420), "white")
        draw = ImageDraw.Draw(image)
        draw.line([(60, 30), (60, 370)], fill="black", width=2)
        draw.line([(60, 370), (570, 370)], fill="black", width=2)
        for i in range(6):
            draw.line([(60 + i * 102, 371), (60 + i * 102, 378)], fill="black", width=1)
            draw.line([(52, 370 - i * 68), (59, 370 - i * 68)], fill="black", width=1)
        points = [(62, 360), (160, 300), (260, 200), (360, 120), (460, 80), (560, 60)]
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            draw.line([(x0, y0), (x1, y0)], fill="#d62728", width=3)
            draw.line([(x1, y0), (x1, y1)], fill="#d62728", width=3)
        directory = pathlib.Path(tempfile.mkdtemp(prefix="vcr-dig-"))
        self.addCleanup(shutil.rmtree, directory, True)
        path = directory / "incidence.png"
        image.save(path)
        result = digitizer.digitize({"calibration": {"x": {"min": 0, "max": 50, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}, "curves": [{}]}, path)
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "curve_rising"))
        self.assertIn("cumulative-incidence", result["message"])


@unittest.skipUnless(HAVE_LIBRARIES, "numpy, Pillow and scipy are the runtime image's")
class Synthetic(unittest.TestCase):
    """A figure drawn with exact pixel geometry: the calibration is checked without matplotlib."""

    def test_the_mapping_is_exact_to_a_pixel(self):
        from PIL import Image, ImageDraw

        image = Image.new("RGB", (640, 460), "white")
        draw = ImageDraw.Draw(image)
        left, bottom, right, top = 70, 400, 610, 40
        draw.line([(left, top), (left, bottom)], fill="black", width=2)
        draw.line([(left, bottom), (right, bottom)], fill="black", width=2)
        for i in range(10):
            x = left + 60 * i
            draw.line([(x, bottom + 1), (x, bottom + 8)], fill="black", width=2)
        for i in range(5):
            y = bottom - 90 * i
            draw.line([(left - 8, y), (left - 1, y)], fill="black", width=2)
        # The true curve: 1.0 until month 6, 0.8 until 18, 0.5 until 30, 0.3 to the end (x: 60 px = 6 months, y: 360 px = 1.0)
        knots = [(0, 1.0), (6, 0.8), (18, 0.5), (30, 0.3)]
        colour = "#1f77b4"
        for (t0, s0), (t1, s1) in zip(knots, knots[1:] + [(54, 0.3)]):
            draw.line([(left + t0 * 10, bottom - s0 * 360), (left + t1 * 10, bottom - s0 * 360)], fill=colour, width=3)
            if s1 != s0:
                draw.line([(left + t1 * 10, bottom - s0 * 360), (left + t1 * 10, bottom - s1 * 360)], fill=colour, width=3)
        directory = pathlib.Path(tempfile.mkdtemp(prefix="vcr-dig-"))
        self.addCleanup(shutil.rmtree, directory, True)
        path = directory / "exact.png"
        image.save(path)
        calibration = {"x": {"min": 0, "max": 54, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}
        result = digitizer.digitize({"calibration": calibration, "curves": [{}]}, path)
        self.assertEqual(result["outcome"], "digitized", result.get("message"))
        self.assertEqual(result["anchor"], "ticks")
        points = result["curves"][0]["points"]
        truth = {"times": [0, 6, 18, 30], "surv": [1.0, 0.8, 0.5, 0.3]}
        per_pixel = result["resolution"]["timePerPixel"]
        self.assertAlmostEqual(per_pixel, 0.1, places=2)
        # Plateau levels to within a pixel of survival; drops within a pixel of time.
        self.assertLessEqual(flat_error(points, truth, per_pixel), 1.5 * result["resolution"]["survivalPerPixel"])
        for time, survival in ((3, 1.0), (12, 0.8), (24, 0.5), (45, 0.3)):
            near = min(points, key=lambda p: abs(p["time"] - time))
            self.assertAlmostEqual(near["surv"], survival, delta=0.006)
        self.assertLessEqual(drop_error(points, truth, per_pixel), 1.5)


@unittest.skipUnless(HAVE_LIBRARIES, "numpy, Pillow and scipy are the runtime image's")
class Entry(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="vcr-dig-entry-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "input").mkdir()
        (self.root / "output").mkdir()

    def stage(self, source, request, name="figure.png"):
        data = pathlib.Path(source).read_bytes()
        (self.root / "input" / name).write_bytes(data)
        body = {**request, "file": {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}}
        (self.root / "input" / "request.json").write_text(json.dumps(body), encoding="utf-8")

    def run_main(self):
        code = digitizer.main(["--request", str(self.root / "input" / "request.json"), "--input-dir", str(self.root / "input"), "--output-dir", str(self.root / "output")])
        self.assertEqual(code, 0)
        return json.loads((self.root / "output" / "result.json").read_text(encoding="utf-8"))

    def test_the_result_names_the_image_it_read(self):
        truth = load_truth("km_single")
        self.stage(FIXTURES / "km_single.png", {"calibration": truth["calibration"], "curves": [{}]})
        result = self.run_main()
        data = (FIXTURES / "km_single.png").read_bytes()
        self.assertEqual(result["outcome"], "digitized")
        self.assertEqual(result["image"]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual((result["image"]["width"], result["image"]["height"]), (640, 480))
        self.assertEqual(result["image"]["bytes"], len(data))

    def test_a_figure_that_is_not_the_one_named_is_not_read(self):
        truth = load_truth("km_single")
        self.stage(FIXTURES / "km_single.png", {"calibration": truth["calibration"], "curves": [{}]})
        (self.root / "input" / "figure.png").write_bytes((FIXTURES / "km_dashed.png").read_bytes())
        result = self.run_main()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "request_invalid"))

    def test_a_file_name_cannot_leave_the_input_directory(self):
        (self.root / "input" / "request.json").write_text(json.dumps({"file": {"name": "../x.png", "sha256": "0" * 64}}), encoding="utf-8")
        self.assertEqual(self.run_main()["reason"], "request_invalid")

    def test_a_damaged_request_still_ends_in_a_result_file(self):
        (self.root / "input" / "request.json").write_text("{nope", encoding="utf-8")
        result = self.run_main()
        self.assertEqual((result["outcome"], result["reason"]), ("refused", "failed"))

    def test_the_module_imports_without_the_image_libraries(self):
        self.assertTrue(callable(digitizer.digitize))
        self.assertEqual(digitizer.PROTOCOL, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
