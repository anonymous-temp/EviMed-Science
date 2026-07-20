"""Shared visual style and page skeleton for HTML review reports.

Artifact-package review renderers emit standalone HTML pages that share one
"light paper" design. This module keeps that design in a single place:

- ``BASE_CSS`` — the shared stylesheet. The palette lives in CSS custom
  properties (with the original hex values unchanged), so a
  ``prefers-color-scheme: dark`` variant and a print variant can restyle
  every report without touching markup.
- ``render_page`` / ``page_header`` / ``stat_chip`` / ``panel`` /
  ``data_table`` — the shared page skeleton (doctype, charset + viewport
  meta, header with stat chips, panel sections, data tables).

Renderers with a few unique rules pass them as ``extra_css``; the rules are
appended after ``BASE_CSS`` so they win the cascade where they overlap.
"""
from __future__ import annotations

from html import escape
from typing import Iterable

BASE_CSS = """    :root {
      color-scheme: light dark;
      --bg: #f7f8fb;
      --surface: #ffffff;
      --text: #152033;
      --muted: #5d6b82;
      --line: #d9e0ea;
      --accent: #175cd3;
      --stat-bg: #eef4ff;
      --stat-line: #c7d7fe;
      --ok: #067647;
      --warn: #b54708;
      --bad: #b42318;
      --ok-bg: #ecfdf3;
      --ok-line: #abefc6;
      --warn-bg: #fffaeb;
      --warn-line: #fedf89;
      --bad-bg: #fef3f2;
      --bad-line: #fecdca;
      --badge-bg: #f8fafc;
    }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 28px 32px 18px; background: var(--surface); border-bottom: 1px solid var(--line); }
    main { max-width: 1180px; margin: 0 auto; padding: 24px 18px 42px; }
    h1 { margin: 0 0 10px; font-size: 26px; }
    h2 { margin: 24px 0 8px; font-size: 18px; }
    .subtitle { margin: 0; color: var(--muted); }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .stat { background: var(--stat-bg); border: 1px solid var(--stat-line); border-radius: 8px; padding: 8px 12px; font-size: 14px; }
    .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 14px 0; }
    table { width: 100%; border-collapse: collapse; background: var(--surface); font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 7px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .fail { color: var(--bad); font-weight: 650; }
    .warn { color: var(--warn); font-weight: 650; }
    .pass { color: var(--ok); font-weight: 650; }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0e1524;
        --surface: #161f30;
        --text: #e2e8f2;
        --muted: #92a1ba;
        --line: #2c3a54;
        --accent: #84adff;
        --stat-bg: #1a2a47;
        --stat-line: #314f80;
        --ok: #32d583;
        --warn: #fdb022;
        --bad: #f97066;
        --ok-bg: #122e20;
        --ok-line: #1c6a45;
        --warn-bg: #34270e;
        --warn-line: #935f0e;
        --bad-bg: #381712;
        --bad-line: #912018;
        --badge-bg: #1a2436;
      }
    }
    @media print {
      body { background: #ffffff; }
      details.card[open] { box-shadow: none; }
      h1, h2 { break-after: avoid; }
      .panel, details.card, tr, blockquote { break-inside: avoid; }
      thead { display: table-header-group; }
    }"""


def style_block(extra_css: str = "", *, include_base: bool = True) -> str:
    """Return the full ``<style>`` element for a report page."""
    parts = []
    if include_base:
        parts.append(BASE_CSS)
    if extra_css.strip():
        parts.append(extra_css.strip())
    return "  <style>\n" + "\n".join(parts) + "\n  </style>"


def render_page(
    *,
    title: str,
    body: str,
    lang: str = "en",
    extra_css: str = "",
    include_base_css: bool = True,
) -> str:
    """Wrap ``body`` in the shared standalone-page skeleton."""
    return f"""<!doctype html>
<html lang="{escape(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)}</title>
{style_block(extra_css, include_base=include_base_css)}
</head>
<body>
{body}
</body>
</html>"""


def page_header(title: str, subtitle: str, stat_chips: Iterable[str]) -> str:
    """Render the shared page header with stat chips (raw-HTML strings)."""
    chips = "\n".join(f'      <span class="stat">{chip}</span>' for chip in stat_chips)
    return f"""  <header>
    <h1>{escape(title)}</h1>
    <p class="subtitle">{escape(subtitle)}</p>
    <div class="stats">
{chips}
    </div>
  </header>"""


def stat_chip(label: object, value: object) -> str:
    """Render one escaped ``Label: value`` stat chip body."""
    return f"{escape(str(label))}: {escape(str(value))}"


def panel(heading: str, content_html: str) -> str:
    """Render a shared ``.panel`` section with an ``h2`` heading."""
    return f"""    <section class="panel">
      <h2>{escape(heading)}</h2>
{content_html}
    </section>"""


def data_table(headers: Iterable[object], rows_html: str) -> str:
    """Render a shared data table from header labels and row HTML."""
    head = "".join(f"<th>{escape(str(label))}</th>" for label in headers)
    return f"""      <table>
        <thead><tr>{head}</tr></thead>
        <tbody>{rows_html}</tbody>
      </table>"""
