#!/usr/bin/env python3
"""Deterministic digitization of a published Kaplan-Meier figure.

「虚拟临床研究」's reconstruction of pseudo-patient data needs the curve's points, and
a language model that "reads" a chart is several times less accurate than a
digitizer (0.087 RMSE against 0.014, attachment C1 of the build plan) and cannot
be audited. This module is the digitizer: the same pixels and the same stated
calibration always give the same points, with the algorithm version, the
parameters and quality indicators beside them. It runs in the intake container
(``apps/server/src/vcrIntakeController.mjs``): no network, no model, one read-only
image, an empty output directory.

What the caller states, and what is measured
--------------------------------------------
The caller (a run, reading the figure's axis labels) states the calibration:
the value at the first and last tick of each axis, the unit, and whether the
survival axis is a fraction or a percentage. The digitizer measures everything
else: where the axes are, where their ticks are, which pixels belong to which
curve. A model never supplies a point.

- ``anchor: ticks`` (the default whenever both axes show at least three evenly
  spaced tick marks): the first and last tick of each axis carry the stated
  values. This is how a reader calibrates, and it is robust to the axis line
  running past the outermost tick, which a panel's padding does.
- ``anchor: plot_area``: the caller states the plot area in pixels, or the axes
  have no tick marks to find, and the ends of the axis lines carry the stated
  values. The result says which anchor was used.

Hidden knowledge
----------------
- **A curve is a staircase, and its pixels are a path, not a cloud.** The target
  colour is matched as a blend with the white page (a one-pixel anti-aliased line
  is 40-70% colour, a JPEG's chroma subsampling moves the hue, a light gridline
  is 15-25% grey), the pixels are grouped into connected components, and the
  component that spans the plot is the curve: text, legend swatches and
  censoring ticks that are not touching it are never traced.
- **A level is the centroid of the line, not its edge.** Per column the level
  is the weighted centre of the curve's pixels, so a symmetric censoring tick
  (``+`` or ``|``) leaves it where it was, and a drop is a ramp a line-width
  wide, which the reconstruction takes as its event.
- **Monotonicity is repaired and counted.** A Kaplan-Meier curve never rises; a
  pixel of noise does. The running minimum is taken, and every rise larger than
  three quarters of a pixel is reported, with its size.
- **The start is anchored, and says so.** Survival is 1 until the first event, by
  definition. When the measured start is within 0.02 of 1 the leading plateau is
  set to exactly 1 and the measurement is reported; farther than that is a
  calibration the reader should look at, and nothing is changed.
- **It refuses what it cannot attribute.** Two panels with an axis each, two
  curves of one colour, a colour that is not in the figure, a legend that cannot
  be found, a curve that rises (a cumulative-incidence plot): each is a named
  refusal with what was found, never a guess. Overlapping curves of one colour
  and shaded confidence bands over a curve are outside what pixels alone settle.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import signal
import sys
from pathlib import Path

NAME = "evimed-km-digitizer"
VERSION = "1.0.0"
PROTOCOL = 1

# Every threshold the algorithm uses, recorded in the result so a point is
# reproducible from its parameters.
PARAMETERS = {
    "darkLuma": 140,           # a pixel this dark is part of an axis line
    "tickLuma": 185,           # tick marks are thin and anti-aliased: a more lenient floor
    "axisMinFraction": 0.30,   # a horizontal axis line spans at least this share of the image width
    "axisMinFractionVertical": 0.12,   # a vertical one, this share of the height (a risk table's panel is short)
    "tickMaxPx": 16,
    "tickMinPx": 3,
    "tickSpacingTolerance": 0.20,
    "minTicks": 3,
    "chromaMin": 40,           # a pixel is coloured when its channels differ by this much
    "paletteMergePx": 60,      # RGB distance within which two quantized colours are one curve colour
    "colourSnapDistance": 140, # a stated colour is matched to the nearest curve colour within this
    "blendResidual": 60,       # distance from the colour-to-white blend line a pixel may have
    "coreWeight": 0.45,        # share of the colour a pixel needs to be part of the curve
    "coreWeightDark": 0.75,    # a black or grey curve: stricter, so a grey curve beside a black one is not it
    "paletteMinChroma": 60,    # a curve colour is saturated, not a pale halo
    "paletteMaxLuma": 215,
    "paletteMinShare": 0.12,   # of the largest colour's pixels
    "hueSnapDegrees": 50,      # a stated colour names the curve whose hue is this close
    "closingGapPx": 4,         # dashes closer than twice this are one line
    "minComponentPixels": 12,
    "minSupportColumns": 12,
    "startAnchorTolerance": 0.02,
    "monotoneToleranceFactor": 0.75,   # a rise this many pixels tall is reported as a repair
    "maxPoints": 1000,
    "minSurvival": 0.001,
}

MAX_PIXELS_DEFAULT = 24_000_000


class Deadline(Exception):
    """The container's own deadline arrived (the controller's timer is the second line, this the first)."""


class Refusal(Exception):
    """A figure or a calibration this digitizer will not turn into points, with the reason."""

    def __init__(self, reason: str, message: str, **detail):
        super().__init__(reason)
        self.reason = reason
        self.message = message
        self.detail = detail


def _numpy():
    import numpy as np  # noqa: PLC0415 - imported late so the module imports where numpy is absent

    return np


# ---------------------------------------------------------------------------
# The stated calibration
# ---------------------------------------------------------------------------


def check_calibration(calibration: dict) -> dict:
    """The stated calibration, or the refusal that names what is impossible."""
    if not isinstance(calibration, dict):
        raise Refusal("calibration_invalid", "calibration is an object with x and y.")
    x = calibration.get("x") or {}
    y = calibration.get("y") or {}
    numbers = {}
    for axis, spec, keys in (("x", x, ("min", "max")), ("y", y, ("min", "max"))):
        for key in keys:
            value = spec.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise Refusal("calibration_invalid", "%s.%s is a number." % (axis, key))
            numbers[(axis, key)] = float(value)
    unit = str(x.get("unit") or "").strip()
    if not unit or len(unit) > 20:
        raise Refusal("calibration_invalid", "x.unit names the time unit (months, years, weeks, days), at most 20 characters.")
    scale = str(y.get("scale") or "")
    if scale not in ("fraction", "percent"):
        raise Refusal("calibration_invalid", "y.scale is fraction (0 to 1) or percent (0 to 100).")
    x0, x1 = numbers[("x", "min")], numbers[("x", "max")]
    y0, y1 = numbers[("y", "min")], numbers[("y", "max")]
    if x0 < 0:
        raise Refusal("calibration_invalid", "x.min is not negative: a survival time starts at or after zero.")
    if x1 <= x0:
        raise Refusal("calibration_invalid", "x.max is greater than x.min.")
    top = 1.0 if scale == "fraction" else 100.0
    if y0 < 0 or y0 > top * 0.95:
        raise Refusal("calibration_invalid", "y.min is between 0 and %g: survival is not negative." % (top * 0.95))
    if y1 > top * 1.1:
        raise Refusal("calibration_invalid", "y.max is at most %g on a %s axis." % (top * 1.1, scale))
    if y1 <= y0:
        raise Refusal("calibration_invalid", "y.max is greater than y.min.")
    if (y1 - y0) < top * 0.05:
        raise Refusal("calibration_invalid", "the survival axis spans at least 5%% of 0 to %g." % top)
    return {"x": {"min": x0, "max": x1, "unit": unit}, "y": {"min": y0, "max": y1, "scale": scale}}


def check_plot_area(area, width: int, height: int):
    if area is None:
        return None
    if not isinstance(area, dict):
        raise Refusal("plot_area_invalid", "plotArea is an object with left, top, right, bottom in pixels.")
    try:
        left, top, right, bottom = (float(area[key]) for key in ("left", "top", "right", "bottom"))
    except (KeyError, TypeError, ValueError):
        raise Refusal("plot_area_invalid", "plotArea has left, top, right and bottom, as numbers of pixels.") from None
    if not all(math.isfinite(value) for value in (left, top, right, bottom)):
        raise Refusal("plot_area_invalid", "plotArea has left, top, right and bottom, as numbers of pixels.")
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise Refusal("plot_area_invalid", "plotArea lies inside the %dx%d image, with left < right and top < bottom." % (width, height))
    if (right - left) < 40 or (bottom - top) < 40:
        raise Refusal("plot_area_invalid", "plotArea is at least 40 pixels each way.")
    return {"left": left, "top": top, "right": right, "bottom": bottom}


# ---------------------------------------------------------------------------
# The image
# ---------------------------------------------------------------------------


def load_image(path: Path, max_pixels: int):
    """The figure as an RGB array on white, and its identity."""
    np = _numpy()
    from PIL import Image  # noqa: PLC0415

    Image.MAX_IMAGE_PIXELS = None  # the size is judged here, by this deployment's own limit, before a pixel is decoded
    try:
        image = Image.open(str(path))
        form = image.format
        width, height = image.size
        if form not in ("PNG", "JPEG"):
            raise Refusal("image_unreadable", "the figure is a PNG or a JPEG.")
        if width * height > max_pixels:
            raise Refusal("image_too_large", "the figure has %d pixels; this deployment decodes at most %d." % (width * height, max_pixels), pixels=width * height)
        if width < 120 or height < 120:
            raise Refusal("image_unreadable", "the figure is at least 120 pixels each way.")
        image.load()
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            page = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            image = Image.alpha_composite(page, rgba)
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    except Refusal:
        raise
    except Exception as error:  # noqa: BLE001 - Pillow raises a wide family for damaged files
        raise Refusal("image_unreadable", "the figure could not be decoded (%s)." % type(error).__name__) from error
    return rgb, {"format": form, "width": int(width), "height": int(height)}


def hex_color(rgb) -> str:
    return "#%02x%02x%02x" % tuple(int(round(float(v))) for v in rgb)


def parse_color(value) -> tuple:
    found = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(value or "").strip())
    if not found:
        raise Refusal("colour_invalid", "a curve colour is a six-digit hex such as #d62728.")
    digits = found.group(1)
    return tuple(int(digits[i:i + 2], 16) for i in (0, 2, 4))


# ---------------------------------------------------------------------------
# The axes: lines, corners, ticks
# ---------------------------------------------------------------------------


def _runs(flags):
    np = _numpy()
    padded = np.concatenate(([0], flags.astype(np.int8), [0]))
    delta = np.diff(padded)
    return np.flatnonzero(delta == 1), np.flatnonzero(delta == -1)


def _line_candidates(dark, axis: int, min_length: int, max_thickness: int = 6):
    """Long straight dark lines: rows (axis=1) or columns (axis=0), grouped into lines.

    Every long run of a row counts, not the longest alone: a short panel's axis
    sits in the same column as a taller panel's.
    """
    count = dark.shape[0] if axis == 1 else dark.shape[1]
    lines = []
    for index in range(count):
        line = dark[index, :] if axis == 1 else dark[:, index]
        starts, ends = _runs(line)
        for start, end in zip(starts.tolist(), ends.tolist()):
            if end - start < min_length:
                continue
            for known in lines:
                if index - known["hi"] <= 1 and start <= known["end"] and end >= known["start"]:
                    known["hi"] = index
                    known["start"] = min(known["start"], start)
                    known["end"] = max(known["end"], end)
                    break
            else:
                lines.append({"lo": index, "hi": index, "start": start, "end": end})
    return [line for line in lines if line["hi"] - line["lo"] + 1 <= max_thickness]


def find_axes(gray, params=PARAMETERS, chroma=None):
    """Every L-shaped pair of axis lines (a vertical and a horizontal meeting at the lower left).

    Axes are black or grey: a saturated curve is dark too, and a long plateau
    with a drop beside it is an L, so coloured pixels are not axis candidates and
    a box lying inside another is not a plot area but a corner of the staircase.
    """
    height, width = gray.shape
    dark = gray < params["darkLuma"]
    if chroma is not None:
        dark = dark & (chroma < params["paletteMinChroma"])
    horizontal = _line_candidates(dark, 1, max(40, int(params["axisMinFraction"] * width)))
    vertical = _line_candidates(dark, 0, max(40, int(params["axisMinFractionVertical"] * height)))
    tolerance = max(4.0, 0.012 * max(width, height))
    boxes = []
    for v in vertical:
        vx = (v["lo"] + v["hi"] + 1) / 2.0
        for h in horizontal:
            hy = (h["lo"] + h["hi"] + 1) / 2.0
            slack = tolerance + (v["hi"] - v["lo"] + 1) + (h["hi"] - h["lo"] + 1)
            starts_at_axis = abs(h["start"] - vx) <= slack or h["start"] <= vx <= h["start"] + slack
            ends_at_axis = abs(v["end"] - hy) <= slack or v["end"] >= hy >= v["end"] - slack
            if starts_at_axis and ends_at_axis and h["end"] - vx >= 40 and hy - v["start"] >= 40:
                boxes.append({"left": vx, "top": float(v["start"]), "right": float(h["end"]), "bottom": hy,
                              "vertical": v, "horizontal": h})
    unique = []
    for box in boxes:
        if not any(abs(box["left"] - other["left"]) < tolerance and abs(box["bottom"] - other["bottom"]) < tolerance for other in unique):
            unique.append(box)
    outer = [box for box in unique if not any(
        other is not box and box["left"] >= other["left"] - tolerance and box["right"] <= other["right"] + tolerance
        and box["top"] >= other["top"] - tolerance and box["bottom"] <= other["bottom"] + tolerance
        and (box["right"] - box["left"]) * (box["bottom"] - box["top"]) < (other["right"] - other["left"]) * (other["bottom"] - other["top"])
        for other in unique)]
    return outer


def _clusters(flags, start: int):
    """Runs of True in a 1-D array as (centre, width) in pixel-edge coordinates."""
    starts, ends = _runs(flags)
    return [((start + int(a) + start + int(b)) / 2.0, int(b - a)) for a, b in zip(starts, ends)]


def find_ticks(gray, box, axis: str, params=PARAMETERS):
    """The major tick marks on an axis, as pixel-edge positions along it, or None."""
    np = _numpy()
    height, width = gray.shape
    lenient = gray < params["tickLuma"]
    maximum = params["tickMaxPx"]
    found = []
    if axis == "x":
        line = box["horizontal"]
        first = line["hi"] + 1
        if first + maximum >= height:
            return None
        strip = lenient[first:first + maximum, :]
        for column in range(int(max(0, line["start"] - 2)), int(min(width, line["end"] + 2))):
            values = strip[:, column]
            begin = 0 if values[0] else (1 if values[1] else -1)
            if begin < 0:
                continue
            run = 0
            while begin + run < maximum and values[begin + run]:
                run += 1
            found.append((column, run))
    else:
        line = box["vertical"]
        last = line["lo"] - 1
        if last - maximum < 0:
            return None
        strip = lenient[:, last - maximum + 1:last + 1][:, ::-1]
        for row in range(int(max(0, line["start"] - 2)), int(min(height, line["end"] + 2))):
            values = strip[row, :]
            begin = 0 if values[0] else (1 if values[1] else -1)
            if begin < 0:
                continue
            run = 0
            while begin + run < maximum and values[begin + run]:
                run += 1
            found.append((row, run))
    if not found:
        return None
    runs = np.zeros(max(width, height) + 4, dtype=np.int32)
    for position, run in found:
        runs[position] = run
    flags = runs >= params["tickMinPx"]
    ticks = []
    for centre, thickness in _clusters(flags, 0):
        if thickness > 5:
            continue
        lo = int(centre - thickness / 2.0)
        length = int(runs[lo:lo + max(1, thickness)].max())
        ticks.append((centre, length))
    if len(ticks) < params["minTicks"]:
        return None
    longest = max(length for _, length in ticks)
    major = [position for position, length in ticks if length >= 0.6 * longest]
    if len(major) < params["minTicks"]:
        return None
    major.sort()
    gaps = np.diff(major)
    median = float(np.median(gaps))
    if median < 6 or float(np.max(np.abs(gaps - median))) > params["tickSpacingTolerance"] * median + 1.0:
        return None
    return major


NICE_STEPS = (1.0, 1.2, 1.5, 2.0, 2.4, 2.5, 3.0, 4.0, 5.0, 6.0, 7.5, 8.0, 10.0)


def tick_step_is_round(step: float) -> bool:
    """Whether a tick spacing in data units is one a plot's author would choose."""
    if not step > 0:
        return False
    mantissa = step / (10 ** math.floor(math.log10(step)))
    return any(abs(mantissa - nice) / nice <= 0.015 for nice in NICE_STEPS)


class Mapping:
    """Pixel-edge coordinates to time and survival."""

    def __init__(self, x_a, x_b, t_a, t_b, y_a, y_b, s_a, s_b, fraction: bool):
        self.x_a, self.x_b, self.t_a, self.t_b = x_a, x_b, t_a, t_b
        self.y_a, self.y_b, self.s_a, self.s_b = y_a, y_b, s_a, s_b
        self.scale = 1.0 if fraction else 0.01

    def time(self, x):
        return self.t_a + (x - self.x_a) * (self.t_b - self.t_a) / (self.x_b - self.x_a)

    def survival(self, y):
        return (self.s_a + (y - self.y_a) * (self.s_b - self.s_a) / (self.y_b - self.y_a)) * self.scale

    @property
    def time_per_pixel(self):
        return abs((self.t_b - self.t_a) / (self.x_b - self.x_a))

    @property
    def survival_per_pixel(self):
        return abs((self.s_b - self.s_a) / (self.y_b - self.y_a)) * self.scale


def resolve_geometry(gray, calibration, stated_area, curve_hint_pixels=None, params=PARAMETERS, chroma=None):
    """The region curves are traced in, and the mapping from pixels to values.

    ``curve_hint_pixels(box)`` scores a candidate box by how much of the wanted
    colour lies inside it, so two stacked panels can be told apart by the curve.
    """
    height, width = gray.shape
    cal = calibration
    if stated_area is not None:
        area = stated_area
        mapping = Mapping(area["left"], area["right"], cal["x"]["min"], cal["x"]["max"],
                          area["bottom"], area["top"], cal["y"]["min"], cal["y"]["max"], cal["y"]["scale"] == "fraction")
        return {"region": area, "mapping": mapping, "areaSource": "stated", "anchor": "plot_area", "frame": None, "ticks": None, "warnings": []}
    boxes = find_axes(gray, params, chroma)
    if not boxes:
        raise Refusal("plot_area_not_found", "no pair of axis lines was found; state plotArea (left, top, right, bottom in pixels) and the values at its edges.")
    if len(boxes) > 1 and curve_hint_pixels is not None:
        scored = sorted(((curve_hint_pixels(box), index) for index, box in enumerate(boxes)), reverse=True)
        if scored[0][0] > 0 and (len(scored) == 1 or scored[0][0] >= 3 * max(1, scored[1][0])):
            boxes = [boxes[scored[0][1]]]
    if len(boxes) > 1:
        candidates = [{key: int(round(box[key])) for key in ("left", "top", "right", "bottom")} for box in boxes[:4]]
        raise Refusal("plot_area_ambiguous",
                      "%d plot areas were found (a risk table or another panel has axes of its own); state plotArea for the one with the curve." % len(boxes),
                      candidates=candidates)
    box = boxes[0]
    region = {key: box[key] for key in ("left", "top", "right", "bottom")}
    x_ticks = find_ticks(gray, box, "x", params)
    y_ticks = find_ticks(gray, box, "y", params)
    warnings = []
    if x_ticks and y_ticks:
        mapping = Mapping(x_ticks[0], x_ticks[-1], cal["x"]["min"], cal["x"]["max"],
                          y_ticks[-1], y_ticks[0], cal["y"]["min"], cal["y"]["max"], cal["y"]["scale"] == "fraction")
        ticks = {"x": len(x_ticks), "y": len(y_ticks)}
        step_x = (cal["x"]["max"] - cal["x"]["min"]) / (len(x_ticks) - 1)
        step_y = (cal["y"]["max"] - cal["y"]["min"]) / (len(y_ticks) - 1)
        ticks["xStep"] = round(step_x, 6)
        ticks["yStep"] = round(step_y, 6)
        ticks["xStepRound"] = tick_step_is_round(step_x)
        ticks["yStepRound"] = tick_step_is_round(step_y)
        if not ticks["xStepRound"]:
            warnings.append("x_tick_spacing_unusual: %d ticks over the stated %g to %g is a step of %g %s; check that x.min and x.max are the first and last tick labels." % (
                len(x_ticks), cal["x"]["min"], cal["x"]["max"], step_x, cal["x"]["unit"]))
        if not ticks["yStepRound"]:
            warnings.append("y_tick_spacing_unusual: %d ticks over the stated %g to %g is a step of %g; check that y.min and y.max are the first and last tick labels." % (
                len(y_ticks), cal["y"]["min"], cal["y"]["max"], step_y))
        anchor = "ticks"
    else:
        mapping = Mapping(box["left"], box["right"], cal["x"]["min"], cal["x"]["max"],
                          box["bottom"], box["top"], cal["y"]["min"], cal["y"]["max"], cal["y"]["scale"] == "fraction")
        ticks = None
        anchor = "plot_area"
        warnings.append("no_tick_marks_found: the stated minimum and maximum were applied to the ends of the axis lines.")
    return {"region": region, "mapping": mapping, "areaSource": "detected", "anchor": anchor, "ticks": ticks, "warnings": warnings}


# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------


def blend_weights(rgb, colour):
    """How much of ``colour`` each pixel is, as a blend with white, and the residual of that model."""
    np = _numpy()
    pixels = rgb.astype(np.float32)
    target = np.asarray(colour, dtype=np.float32)
    away = 255.0 - target
    denominator = float((away * away).sum())
    if denominator < 1.0:
        raise Refusal("colour_invalid", "a curve cannot be white.")
    gap = 255.0 - pixels
    share = (gap * away).sum(axis=2) / denominator
    residual = np.sqrt(np.maximum(0.0, ((gap - share[..., None] * away) ** 2).sum(axis=2)))
    return np.clip(share, 0.0, 1.2), residual


def palette(rgb, region, params=PARAMETERS, limit: int = 8):
    """The coloured line colours in a region, most pixels first. Greys and black are not listed."""
    np = _numpy()
    left, top, right, bottom = (int(round(region[key])) for key in ("left", "top", "right", "bottom"))
    patch = rgb[max(0, top - 2):bottom + 2, max(0, left):right + 1].reshape(-1, 3).astype(np.int16)
    chroma = patch.max(axis=1) - patch.min(axis=1)
    coloured = patch[(chroma >= params["chromaMin"]) & (patch.min(axis=1) < 235)]
    if coloured.size == 0:
        return []
    bins = (coloured >> 4)
    keys, counts = np.unique(bins[:, 0] * 256 + bins[:, 1] * 16 + bins[:, 2], return_counts=True)
    order = np.argsort(-counts, kind="stable")
    clusters = []
    for index in order:
        key = int(keys[index])
        centre = np.array([(key // 256) * 16 + 8, ((key // 16) % 16) * 16 + 8, (key % 16) * 16 + 8], dtype=np.float32)
        count = int(counts[index])
        for cluster in clusters:
            if float(np.linalg.norm(cluster["centre"] - centre)) <= params["paletteMergePx"]:
                cluster["pixels"] += count
                break
        else:
            clusters.append({"centre": centre, "pixels": count})
    # A lighter shade of a colour already listed is its anti-aliasing, not a curve.
    kept = []
    for cluster in clusters:
        shade = False
        for other in kept:
            away = 255.0 - other["centre"]
            gap = 255.0 - cluster["centre"]
            share = float((gap * away).sum() / (away * away).sum())
            residual = float(np.linalg.norm(gap - share * away))
            if 0.15 < share < 0.95 and residual <= 40:
                shade = True
                break
        if not shade:
            kept.append(cluster)
    # The cluster centre is a bin centre; the true colour is the most common pixel in it.
    result = []
    for cluster in kept:
        if cluster["pixels"] < 60:
            continue
        near = coloured[np.linalg.norm(coloured.astype(np.float32) - cluster["centre"], axis=1) <= params["paletteMergePx"]]
        values, tally = np.unique(near, axis=0, return_counts=True)
        mode = values[int(tally.argmax())]
        luma = 0.299 * mode[0] + 0.587 * mode[1] + 0.114 * mode[2]
        # A curve colour is saturated and not pale: JPEG chroma halos around a line are neither.
        if int(mode.max() - mode.min()) < params["paletteMinChroma"] or luma > params["paletteMaxLuma"]:
            continue
        result.append({"color": hex_color(mode), "pixels": int(cluster["pixels"]), "rgb": tuple(int(v) for v in mode)})
    if result:
        biggest = max(entry["pixels"] for entry in result)
        result = [entry for entry in result if entry["pixels"] >= params["paletteMinShare"] * biggest]
    return result[:limit]


def _hue(rgb) -> float:
    r, g, b = (float(v) / 255.0 for v in rgb)
    high, low = max(r, g, b), min(r, g, b)
    if high == low:
        return 0.0
    delta = high - low
    if high == r:
        hue = ((g - b) / delta) % 6
    elif high == g:
        hue = (b - r) / delta + 2
    else:
        hue = (r - g) / delta + 4
    return hue * 60.0


def choose_colour(selector: dict, colours, role: str):
    """The curve colour a selector names: a stated colour snapped to the figure's own, or the only one there is."""
    np = _numpy()
    stated = selector.get("color")
    if stated:
        wanted = parse_color(stated)
        if sum(wanted) <= 150 and max(wanted) - min(wanted) < 40:
            return {"rgb": (0, 0, 0), "color": "#000000", "source": "stated", "dark": True}
        if not colours:
            raise Refusal("colour_not_found", "no coloured line was found in the plot area for %s." % role, palette=[])
        wanted_chroma = max(wanted) - min(wanted)
        if wanted_chroma < 40:
            # A stated grey that is not black: a grey curve, matched as itself.
            return {"rgb": wanted, "color": hex_color(wanted), "source": "stated", "dark": True}
        scores = []
        for entry in colours:
            hue_gap = abs(_hue(entry["rgb"]) - _hue(wanted))
            hue_gap = min(hue_gap, 360.0 - hue_gap)
            distance = float(np.linalg.norm(np.array(entry["rgb"], dtype=np.float32) - np.array(wanted, dtype=np.float32)))
            scores.append((hue_gap + 0.05 * distance, hue_gap, distance))
        best = int(np.argmin([score[0] for score in scores]))
        if scores[best][1] > PARAMETERS["hueSnapDegrees"] and scores[best][2] > PARAMETERS["colourSnapDistance"]:
            raise Refusal("colour_not_found", "no coloured line near %s was found for %s; the plot area holds %s." % (
                hex_color(wanted), role, ", ".join(entry["color"] for entry in colours) or "none"), palette=[entry["color"] for entry in colours])
        return {"rgb": colours[best]["rgb"], "color": colours[best]["color"], "source": "stated", "dark": False}
    if len(colours) == 1:
        return {"rgb": colours[0]["rgb"], "color": colours[0]["color"], "source": "only_colour", "dark": False}
    if not colours:
        return {"rgb": (0, 0, 0), "color": "#000000", "source": "only_colour", "dark": True}
    raise Refusal("colour_required", "the plot area holds several curve colours (%s); name the colour or the legend order of %s." % (
        ", ".join(entry["color"] for entry in colours), role), palette=[entry["color"] for entry in colours])


def legend_order(rgb, colours, region):
    """Curve colours in the order of their legend swatches, top to bottom (left to right for a row).

    A swatch is a short, wide, isolated bar of the curve's colour, and a legend
    lines its swatches up: one behind another with the same left edge and length,
    or side by side on one line. A figure with no such arrangement (a dashed
    line's dashes are bars too, and are never aligned with another colour's) has
    no legend to read, and the answer is a refusal, not an order.
    """
    np = _numpy()
    from scipy import ndimage  # noqa: PLC0415
    import itertools  # noqa: PLC0415

    height, width = rgb.shape[:2]
    candidates = []
    for entry in colours:
        share, residual = blend_weights(rgb, entry["rgb"])
        core = (share >= PARAMETERS["coreWeight"]) & (residual <= PARAMETERS["blendResidual"])
        labels, count = ndimage.label(core, structure=np.ones((3, 3)))
        found = []
        for index, box in enumerate(ndimage.find_objects(labels), start=1):
            rows, columns = box
            h, w = rows.stop - rows.start, columns.stop - columns.start
            if 8 <= w <= 0.15 * width and h <= max(8, w / 2.0) and w >= 2.0 * h and int((labels[box] == index).sum()) >= 0.6 * w * h:
                found.append((float(rows.start + rows.stop) / 2.0, float(columns.start), float(w)))
        if not found:
            raise Refusal("legend_not_found", "the legend swatch of %s was not found; name the colour instead." % entry["color"])
        candidates.append(found)
    best = None
    for combo in itertools.islice(itertools.product(*candidates), 20000):
        widths = [item[2] for item in combo]
        if max(widths) > 1.25 * min(widths):
            continue
        ys, xs = [item[0] for item in combo], [item[1] for item in combo]
        stacked = max(xs) - min(xs) <= 4 and min(abs(a - b) for a, b in itertools.combinations(ys, 2) or [(0, 99)]) >= 6
        in_a_row = max(ys) - min(ys) <= 4 and min(abs(a - b) for a, b in itertools.combinations(xs, 2) or [(0, 99)]) >= 12
        if stacked or in_a_row:
            spread = (max(xs) - min(xs)) if stacked else (max(ys) - min(ys))
            if best is None or spread < best[0]:
                best = (spread, combo)
    if best is None:
        raise Refusal("legend_not_found", "no legend (aligned swatches of every curve colour) was found; name the colours instead.")
    order = sorted(range(len(colours)), key=lambda k: (round(best[1][k][0] / 4), best[1][k][1]))
    return [colours[k] for k in order]


# ---------------------------------------------------------------------------
# Tracing one curve
# ---------------------------------------------------------------------------


def _vertical_runs(column):
    np = _numpy()
    padded = np.concatenate(([0], column.astype(np.int8), [0]))
    delta = np.diff(padded)
    return list(zip(np.flatnonzero(delta == 1).tolist(), np.flatnonzero(delta == -1).tolist()))


def trace_curve(rgb, colour, region, mapping, role: str, params=PARAMETERS):
    """Points of one curve: ordered (time, survival) with the quality of the trace."""
    np = _numpy()
    from scipy import ndimage  # noqa: PLC0415

    height, width = rgb.shape[:2]
    pad = 3
    left = int(math.floor(region["left"])) + 2
    right = int(math.ceil(region["right"]))
    top = max(0, int(math.floor(region["top"])) - pad)
    bottom = min(height, int(math.ceil(region["bottom"])) - 1)
    if right - left < 40 or bottom - top < 40:
        raise Refusal("plot_area_invalid", "the plot area is too small to trace a curve in.")
    patch = rgb[top:bottom, left:right]
    share, residual = blend_weights(patch, colour["rgb"])
    weight = np.where(residual <= params["blendResidual"], share, 0.0).astype(np.float32)
    core = weight >= (params["coreWeightDark"] if colour["dark"] else params["coreWeight"])
    if colour["dark"]:
        # A black curve and a black frame are one colour: the frame's top and right
        # lines (long straight runs in the outer band of the plot area) are not it.
        wide, tall = core.shape[1], core.shape[0]
        for row in list(range(0, min(tall, pad + 3))):
            starts, ends = _runs(core[row, :])
            if starts.size and (ends - starts).max() >= 0.85 * wide:
                core[row, :] = False
        for column in range(max(0, wide - 4), wide):
            starts, ends = _runs(core[:, column])
            if starts.size and (ends - starts).max() >= 0.85 * tall:
                core[:, column] = False
    gap = params["closingGapPx"]
    # Dashes closer than twice the gap, along the line or across a steep stretch of it, are one line.
    joined = ndimage.binary_dilation(core, structure=np.ones((2 * gap + 1, 2 * gap + 1), dtype=bool)) if gap else core
    labels, count = ndimage.label(joined, structure=np.ones((3, 3)))
    if count == 0:
        raise Refusal("curve_not_found", "no pixels of %s (%s) were found in the plot area." % (role, colour["color"]))
    spans = []
    for index in range(1, count + 1):
        members = core & (labels == index)
        pixels = int(members.sum())
        if pixels < params["minComponentPixels"]:
            continue
        columns = np.flatnonzero(members.any(axis=0))
        spans.append({"pixels": pixels, "first": int(columns[0]), "last": int(columns[-1]), "members": members})
    if not spans:
        raise Refusal("curve_not_found", "no connected line of %s (%s) was found in the plot area." % (role, colour["color"]))
    spans.sort(key=lambda item: -(item["last"] - item["first"]))
    widest = spans[0]["last"] - spans[0]["first"] + 1
    if widest < 0.25 * (right - left):
        raise Refusal("curve_not_found", "the longest line of %s (%s) spans %.0f%% of the plot; it is not a curve." % (role, colour["color"], 100.0 * widest / (right - left)))
    used = [item for item in spans if (item["last"] - item["first"] + 1) >= 0.05 * (right - left)]
    union_first = min(item["first"] for item in used)
    union_last = max(item["last"] for item in used)
    total_span = sum(item["last"] - item["first"] + 1 for item in used)
    if total_span > 1.35 * (union_last - union_first + 1):
        raise Refusal("curve_ambiguous", "%s (%s) has two lines of that colour side by side; curves of one colour cannot be told apart by pixels." % (role, colour["color"]))
    selected = np.zeros(core.shape, dtype=bool)
    for item in used:
        selected |= item["members"]
    columns = np.flatnonzero(selected.any(axis=0))
    if columns.size < params["minSupportColumns"]:
        raise Refusal("curve_not_found", "%s (%s) is supported by only %d pixel columns." % (role, colour["color"], int(columns.size)))
    first, last = int(columns[0]), int(columns[-1])
    vertical = ndimage.binary_dilation(selected, structure=np.ones((3, 1), dtype=bool))
    weighted = weight * vertical

    # Follow the curve from its start: in every column take the vertical run that
    # continues the path. A legend swatch or a line of text above it cannot be the
    # curve (survival does not rise), and one below it is farther than the curve.
    count_columns = last - first + 1
    centre = np.full(count_columns, np.nan)
    extent = np.zeros(count_columns)
    previous = None
    for offset in range(count_columns):
        runs = _vertical_runs(selected[:, first + offset])
        if not runs:
            continue
        if previous is None:
            chosen = runs[0]
        else:
            lo, hi = previous
            touching = [run for run in runs if run[0] <= hi + 2 and run[1] >= lo - 2]
            if touching:
                # The lowest run that continues the path: a censoring tick's bar left
                # at the old level beside an event is not the curve once it has dropped.
                chosen = max(touching, key=lambda run: run[1])
            else:
                usable = [run for run in runs if run[1] >= lo - 2]
                if not usable:
                    continue
                chosen = min(usable, key=lambda run: min(abs(run[0] - hi), abs(run[1] - lo)))
        a, b = chosen
        rows = np.arange(max(0, a - 1), min(weighted.shape[0], b + 1))
        mass = float(weighted[rows, first + offset].sum())
        if mass <= 0:
            continue
        centre[offset] = float(((rows + 0.5 + top) * weighted[rows, first + offset]).sum() / mass)
        extent[offset] = b - a
        previous = (a, b)
    supported = ~np.isnan(centre)
    if int(supported.sum()) < params["minSupportColumns"]:
        raise Refusal("curve_not_found", "%s (%s) could not be followed along the plot." % (role, colour["color"]))
    # Drops and markers. A column far taller than the line is either an event (the
    # curve's level differs either side of it) or a censoring tick or a stroke of
    # text across the line (it does not): a short run of such columns between two
    # line-thick ones is resolved to the level on its side of the middle.
    line = float(np.median(extent[supported]))
    tall_limit = max(4.0, 2.2 * line)
    short_run = int(2 * line + 3)
    thin = supported & (extent <= tall_limit)
    snapped = markers = 0
    index = 0
    while index < count_columns:
        if not supported[index] or thin[index]:
            index += 1
            continue
        end_index = index
        while end_index + 1 < count_columns and supported[end_index + 1] and not thin[end_index + 1]:
            end_index += 1
        width_run = end_index - index + 1
        before = centre[index - 1] if index > 0 and thin[index - 1] else None
        after = centre[end_index + 1] if end_index + 1 < count_columns and thin[end_index + 1] else None
        if width_run <= short_run and before is not None and after is not None:
            if abs(after - before) <= 1.0 + 0.5 * line:
                centre[index:end_index + 1] = before
                markers += 1
            else:
                # The event is at the middle of the vertical stroke: a column whose
                # centre is left of it is still on the earlier level.
                split = index + width_run // 2
                centre[index:split] = before
                centre[split:end_index + 1] = after
                snapped += 1
        index = end_index + 1
    # Columns between the first and last that nothing supports (a curve hidden
    # behind another, a dash gap) hold the previous level: the curve is a step function.
    bridged = 0
    held = centre.copy()
    last_seen = np.nan
    for offset in range(count_columns):
        if np.isnan(held[offset]):
            held[offset] = last_seen
            bridged += 1
        else:
            last_seen = held[offset]
    if np.isnan(held[0]):
        held[0] = held[~np.isnan(held)][0]
        held = np.where(np.isnan(held), held[0], held)
    columns_x = np.arange(first, last + 1)
    times = np.array([mapping.time(left + column + 0.5) for column in columns_x], dtype=np.float64)
    raw = np.array([mapping.survival(value) for value in held], dtype=np.float64)
    tolerance = params["monotoneToleranceFactor"] * mapping.survival_per_pixel
    running = np.minimum.accumulate(raw)
    rises = raw - running
    repaired = int((rises > tolerance).sum())
    worst = float(rises.max()) if rises.size else 0.0
    survival = running.copy()
    # A rising curve is not survival.
    if raw[-1] - raw[0] > 0.1 * (1.0 if mapping.scale == 1.0 else 1.0):
        raise Refusal("curve_rising", "%s (%s) rises from %.3f to %.3f; a Kaplan-Meier curve falls (is this a cumulative-incidence plot?)." % (role, colour["color"], raw[0], raw[-1]))
    # The start: survival is 1 until the first event.
    measured_start = float(np.median(raw[: max(3, min(len(raw), 5))]))
    falling = np.flatnonzero(survival < survival[0] - tolerance)
    plateau = int(falling[0]) if falling.size else len(survival)
    anchored = abs(measured_start - 1.0) <= params["startAnchorTolerance"]
    if anchored:
        survival[:plateau] = 1.0
    clipped = int((survival > 1.0).sum() + (survival < params["minSurvival"]).sum())
    survival = np.clip(survival, params["minSurvival"], 1.0)
    survival = np.minimum.accumulate(survival)
    step = max(1, int(math.ceil(len(survival) / params["maxPoints"])))
    picks = list(range(0, len(survival), step))
    if picks[-1] != len(survival) - 1:
        picks.append(len(survival) - 1)
    points = [{"time": round(float(times[i]), 5), "surv": round(float(survival[i]), 6)} for i in picks]
    span = float(times[-1] - times[0])
    return {
        "color": colour["color"], "colorSource": colour["source"], "points": points,
        "quality": {
            "points": len(points),
            "firstTime": round(float(times[0]), 5), "lastTime": round(float(times[-1]), 5),
            "xCoverage": round(span / (mapping.t_b - mapping.t_a), 4),
            "observedFraction": round(float((count_columns - bridged) / count_columns), 4),
            "bridgedColumns": int(bridged),
            "monotonicityRepairs": {"count": repaired, "largestRise": round(worst, 5)},
            "clippedToRange": clipped,
            "eventsSnapped": int(snapped), "markersIgnored": int(markers),
            "pixelSupport": {"curvePixels": int(selected.sum()), "supportedColumns": int(supported.sum()), "medianThicknessPx": round(line, 2)},
            "startSurvival": {"measured": round(measured_start, 5), "anchored": bool(anchored), "plateauPoints": int(plateau) if anchored else 0},
        },
    }


# ---------------------------------------------------------------------------
# One request
# ---------------------------------------------------------------------------


def _libraries() -> dict:
    versions = {"python": "%d.%d.%d" % sys.version_info[:3]}
    for name, attribute in (("numpy", "numpy"), ("pillow", "PIL"), ("scipy", "scipy")):
        try:
            module = __import__(attribute)
            versions[name] = str(getattr(module, "__version__", "unknown"))
        except ImportError:
            versions[name] = "missing"
    return versions


def digitize(request: dict, image_path: Path, max_pixels: int = MAX_PIXELS_DEFAULT) -> dict:
    """The digitization of one figure, or the refusal that explains why not. Deterministic."""
    np = _numpy()
    base = {"protocol": PROTOCOL, "algorithm": {"name": NAME, "version": VERSION, "libraries": _libraries()}, "parameters": dict(PARAMETERS)}
    try:
        calibration = check_calibration(request.get("calibration"))
        selectors = request.get("curves")
        if selectors is None:
            selectors = [{}]
        if not isinstance(selectors, list) or not 1 <= len(selectors) <= 2 or any(not isinstance(item, dict) for item in selectors):
            raise Refusal("curves_invalid", "curves lists one or two curves, each named by colour or legend order.")
        rgb, info = load_image(image_path, int(max_pixels))
        height, width = rgb.shape[:2]
        stated_area = check_plot_area(request.get("plotArea"), width, height)
        gray = (rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114).astype(np.float32)
        chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)

        def hint(box):
            colours = palette(rgb, box)
            return sum(entry["pixels"] for entry in colours)

        geometry = resolve_geometry(gray, calibration, stated_area, hint, chroma=chroma)
        region, mapping = geometry["region"], geometry["mapping"]
        colours = palette(rgb, region)
        if any("legendOrder" in item for item in selectors):
            ordered = legend_order(rgb, colours, region)
        else:
            ordered = None
        chosen = []
        for position, selector in enumerate(selectors):
            role = str(selector.get("name") or ("curve %d" % (position + 1)))
            if "legendOrder" in selector:
                order = selector["legendOrder"]
                if not isinstance(order, int) or isinstance(order, bool) or not 1 <= order <= len(ordered):
                    raise Refusal("legend_not_found", "legendOrder %r is outside the %d curve colours found in the legend." % (order, len(ordered)))
                pick = {"rgb": ordered[order - 1]["rgb"], "color": ordered[order - 1]["color"], "source": "legend", "dark": False}
            else:
                pick = choose_colour(selector, colours, role)
            chosen.append((role, pick))
        if len(chosen) == 2 and chosen[0][1]["color"] == chosen[1][1]["color"]:
            raise Refusal("colour_ambiguous", "both curves resolve to the colour %s; name two different colours." % chosen[0][1]["color"])
        curves = []
        for role, pick in chosen:
            traced = trace_curve(rgb, pick, region, mapping, role)
            traced["name"] = role
            curves.append(traced)
        warnings = list(geometry["warnings"])
        for curve in curves:
            start = curve["quality"]["startSurvival"]
            if not start["anchored"]:
                warnings.append("curve_start_not_one: %s is first seen at %.3g %s with survival %.3f, not 1: its start is hidden under another curve, or y.min, y.max and the scale need checking." % (
                    curve["name"], curve["quality"]["firstTime"], calibration["x"]["unit"], start["measured"]))
            if curve["quality"]["xCoverage"] < 0.3:
                warnings.append("curve_covers_little: %s spans %.0f%% of the x range." % (curve["name"], 100 * curve["quality"]["xCoverage"]))
        return {
            **base, "outcome": "digitized",
            "image": {**info},
            "calibration": calibration,
            "plotArea": {**{key: round(float(region[key]), 2) for key in ("left", "top", "right", "bottom")}, "source": geometry["areaSource"]},
            "anchor": geometry["anchor"], "ticks": geometry["ticks"],
            "resolution": {"timePerPixel": round(mapping.time_per_pixel, 6), "survivalPerPixel": round(mapping.survival_per_pixel, 6)},
            "palette": [entry["color"] for entry in colours],
            "curves": curves, "warnings": warnings,
        }
    except Refusal as refusal:
        return {**base, "outcome": "refused", "reason": refusal.reason, "message": refusal.message, **({"detail": refusal.detail} if refusal.detail else {})}


# ---------------------------------------------------------------------------
# The container's entry
# ---------------------------------------------------------------------------


def run(request: dict, input_dir: Path) -> dict:
    spec = request.get("file") or {}
    name = str(spec.get("name") or "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name):
        return {"protocol": PROTOCOL, "outcome": "refused", "reason": "request_invalid", "message": "the request names no usable file."}
    source = input_dir / name
    if source.is_symlink() or not source.is_file():
        return {"protocol": PROTOCOL, "outcome": "refused", "reason": "request_invalid", "message": "the figure is missing."}
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != str(spec.get("sha256") or ""):
        return {"protocol": PROTOCOL, "outcome": "refused", "reason": "request_invalid", "message": "the figure is not the one the request names."}
    limits = request.get("limits") or {}
    result = digitize(request, source, int(limits.get("maxPixels", MAX_PIXELS_DEFAULT)))
    if result.get("outcome") == "digitized":
        result["image"]["sha256"] = digest
        result["image"]["bytes"] = source.stat().st_size
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--request", required=True)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--deadline", type=int, default=0)
    args = parser.parse_args(argv)

    def on_alarm(_signal: int, _frame: object) -> None:
        raise Deadline()

    if args.deadline > 0 and hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, on_alarm)
        signal.alarm(args.deadline)
    try:
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        result = run(request, Path(args.input_dir))
    except Deadline:
        result = {"protocol": PROTOCOL, "outcome": "refused", "reason": "deadline", "message": "the digitization ran past its deadline."}
    except MemoryError:
        result = {"protocol": PROTOCOL, "outcome": "refused", "reason": "memory", "message": "the figure needs more memory than this container has."}
    except Exception as error:  # noqa: BLE001 - the class, never the message, reaches the control plane
        result = {"protocol": PROTOCOL, "outcome": "refused", "reason": "failed", "message": "the digitization failed (%s)." % type(error).__name__}
    finally:
        if args.deadline > 0 and hasattr(signal, "SIGALRM"):
            signal.alarm(0)
    (Path(args.output_dir) / "result.json").write_text(json.dumps(result, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
