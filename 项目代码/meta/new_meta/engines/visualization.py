"""Visualization engine — forest plots, funnel plots, PRISMA 2020, RoB summary,
cumulative forest, contour funnel, NMA network plot.

All deterministic matplotlib generation.
"""
from __future__ import annotations

import base64
import io
import logging

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch
from pathlib import Path

logger = logging.getLogger("metaagent.visualization")

# 中文字体支持：自动检测可用字体，避免缺失字体导致方块字
def _detect_chinese_font() -> str:
    """Return the first available Chinese-capable font name."""
    import matplotlib.font_manager as fm
    candidates = ["SimHei", "Microsoft YaHei", "WenQuanYi Micro Hei",
                   "Noto Sans CJK SC", "PingFang SC", "Heiti SC",
                   "Source Han Sans SC", "Arial Unicode MS"]
    available = {f.name for f in fm.fontManager.ttflist}
    for c in candidates:
        if c in available:
            return c
    logger.warning("No Chinese-capable font found; Chinese labels may not render correctly")
    return ""

_chosen_font = _detect_chinese_font()
if _chosen_font:
    plt.rcParams["font.sans-serif"] = [_chosen_font] + plt.rcParams.get("font.sans-serif", [])
plt.rcParams["axes.unicode_minus"] = False

from new_meta.schemas.meta_result import PooledEffect, LeaveOneOutResult, StudyEffect, CumulativeResult

_LOG_MEASURES = {"OR", "RR", "HR", "IRR"}


def _fig_to_base64(fig, dpi: int = 100) -> str:
    """Render matplotlib figure to base64 data URI. Closes the figure."""
    try:
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except Exception as e:
        logger.warning(f"Figure rendering failed: {e}")
        return ""
    finally:
        plt.close(fig)


# =============================================================================
# Forest Plot
# =============================================================================

def forest_plot(
    pooled: PooledEffect,
    save_path: str = None,
    title: str = None,
    figsize: tuple = None,
    lang: str = "en",
) -> str:
    """Generate a standard forest plot.

    Each study shown as a square (size ∝ weight) + CI line.
    Pooled effect shown as a diamond.

    Returns base64 data URI of the PNG image.
    """
    studies = pooled.studies
    k = len(studies)
    if k == 0:
        return ""
    if figsize is None:
        figsize = (14, max(4, k * 0.5 + 2))

    fig, ax = plt.subplots(1, 1, figsize=figsize)

    is_log = pooled.effect_measure in _LOG_MEASURES
    zh = lang == "zh"
    labels = []
    y_positions = list(range(k, 0, -1))

    for i, (study, ypos) in enumerate(zip(studies, y_positions)):
        se = study.se
        yi = study.yi
        ci_lo = yi - 1.96 * se
        ci_hi = yi + 1.96 * se

        # Convert to original scale for display
        if is_log:
            disp_yi = np.exp(yi)
            disp_lo = np.exp(ci_lo)
            disp_hi = np.exp(ci_hi)
        else:
            disp_yi, disp_lo, disp_hi = yi, ci_lo, ci_hi

        # Square size proportional to weight
        size = max(4, study.weight * 0.8) if study.weight > 0 else 6

        # CI line
        ax.plot([disp_lo, disp_hi], [ypos, ypos], color="black", linewidth=1, zorder=1)
        # Square
        ax.scatter([disp_yi], [ypos], s=size**2, marker="s", color="#2196F3", edgecolor="black", linewidth=0.5, zorder=2)

        labels.append(f"{study.study_label}  {disp_yi:.2f} [{disp_lo:.2f}, {disp_hi:.2f}]  ({study.weight:.1f}%)")

    # Pooled diamond
    p_y = 0
    p_effect = pooled.pooled_effect
    p_lo = pooled.ci_lower
    p_hi = pooled.ci_upper

    diamond_x = [p_lo, p_effect, p_hi, p_effect]
    diamond_y = [p_y, p_y + 0.3, p_y, p_y - 0.3]
    ax.fill(diamond_x, diamond_y, color="#E53935", edgecolor="black", linewidth=1, zorder=3)
    pooled_label = "\u5408\u5e76\u6548\u5e94" if zh else "Pooled"
    labels.append(f"{pooled_label}  {p_effect:.2f} [{p_lo:.2f}, {p_hi:.2f}]")

    # Reference line
    ref = 1.0 if is_log else 0.0
    ax.axvline(x=ref, color="gray", linestyle="--", linewidth=0.8, zorder=0)

    # Labels
    all_y = y_positions + [p_y]
    ax.set_yticks(all_y)
    ax.set_yticklabels(labels, fontsize=7, fontfamily="monospace")
    model_label = "\u968f\u673a\u6548\u5e94\u6a21\u578b" if (zh and pooled.model == "random") else ("\u56fa\u5b9a\u6548\u5e94\u6a21\u578b" if zh else f"{pooled.model}-effect model")
    ax.set_xlabel(f"{pooled.effect_measure} ({model_label})", fontsize=10)

    if is_log:
        ax.set_xscale("log")

    # Heterogeneity annotation
    if zh:
        het_text = (
            f"\u5f02\u8d28\u6027: I\u00b2 = {pooled.i_squared:.1f}%, "
            f"\u03c4\u00b2 = {pooled.tau_squared:.4f}, "
            f"Q = {pooled.q_statistic:.2f} (p = {pooled.q_p_value:.4f})"
        )
    else:
        het_text = (
            f"Heterogeneity: I\u00b2 = {pooled.i_squared:.1f}%, "
            f"\u03c4\u00b2 = {pooled.tau_squared:.4f}, "
            f"Q = {pooled.q_statistic:.2f} (p = {pooled.q_p_value:.4f})"
        )

    if title:
        ax.set_title(title, fontsize=12, fontweight="bold")

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    # Place heterogeneity text after tight_layout to avoid overlap with x-axis
    fig.text(0.02, 0.01, het_text, fontsize=7, color="gray")
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# Funnel Plot
# =============================================================================

def funnel_plot(
    pooled: PooledEffect,
    save_path: str = None,
    filled_studies: list[StudyEffect] = None,
    title: str = None,
    lang: str = "en",
) -> str:
    """Generate a funnel plot with pseudo-confidence regions.

    Returns base64 data URI of the PNG image.
    """
    studies = pooled.studies
    if not studies:
        return ""
    zh = lang == "zh"
    if title is None:
        title = "漏斗图" if zh else "Funnel Plot"
    fig, ax = plt.subplots(1, 1, figsize=(8, 6))

    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    is_log = pooled.effect_measure in _LOG_MEASURES

    if is_log:
        disp_yi = np.exp(yi)
        center = pooled.pooled_effect
    else:
        disp_yi = yi
        center = pooled.pooled_effect

    # Pseudo-confidence region
    se_range = np.linspace(0.001, max(se) * 1.2, 100)
    if is_log:
        if center <= 0:
            center = 1.0
        center_log = np.log(center)
        lo = np.exp(center_log - 1.96 * se_range)
        hi = np.exp(center_log + 1.96 * se_range)
    else:
        lo = center - 1.96 * se_range
        hi = center + 1.96 * se_range

    ax.fill_betweenx(se_range, lo, hi, color="#E3F2FD", alpha=0.5, label="95% CI" if not zh else "95% CI 区域")
    ax.axvline(x=center, color="gray", linestyle="--", linewidth=0.8)

    # Study points
    ax.scatter(disp_yi, se, s=30, color="#1565C0", edgecolor="black", linewidth=0.3, zorder=3, label="研究" if zh else "Studies")

    # Filled studies from trim-and-fill
    if filled_studies:
        f_yi = np.array([s.yi for s in filled_studies])
        f_se = np.array([s.se for s in filled_studies])
        f_disp = np.exp(f_yi) if is_log else f_yi
        ax.scatter(f_disp, f_se, s=30, color="red", marker="D", edgecolor="black", linewidth=0.3, zorder=3, label="填补研究 (剪补法)" if zh else "Imputed (trim-fill)")

    ax.set_xlabel(f"{pooled.effect_measure}", fontsize=10)
    ax.set_ylabel("标准误" if zh else "Standard Error", fontsize=10)
    ax.invert_yaxis()
    ax.set_title(title, fontsize=12, fontweight="bold")
    ax.legend(fontsize=8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# Contour-Enhanced Funnel Plot
# =============================================================================

def contour_funnel_plot(
    pooled: PooledEffect,
    save_path: str = None,
    title: str = None,
    lang: str = "en",
) -> str:
    """Generate a contour-enhanced funnel plot with significance regions.

    Regions: p < 0.01, p < 0.05, p < 0.10, p >= 0.10.
    Reference: Peters et al. (2008).

    Returns base64 data URI of the PNG image.
    """
    studies = pooled.studies
    zh = lang == "zh"
    if title is None:
        title = "轮廓增强漏斗图" if zh else "Contour-Enhanced Funnel Plot"
    fig, ax = plt.subplots(1, 1, figsize=(8, 6))

    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    is_log = pooled.effect_measure in _LOG_MEASURES

    se_max = max(se) * 1.2
    se_range = np.linspace(0.001, se_max, 200)

    # Contour regions based on z-scores for different significance levels
    z_01 = 2.576   # p < 0.01
    z_05 = 1.96    # p < 0.05
    z_10 = 1.645   # p < 0.10

    # Plot contour regions (from outermost to innermost)
    for z_val, color, label in [
        (z_10, "#E8F5E9", "p < 0.10"),
        (z_05, "#FFF9C4", "p < 0.05"),
        (z_01, "#FFCDD2", "p < 0.01"),
    ]:
        left = -z_val * se_range
        right = z_val * se_range
        if is_log:
            ax.fill_betweenx(se_range, np.exp(left), np.exp(right), color=color, alpha=0.6, label=label)
        else:
            ax.fill_betweenx(se_range, left, right, color=color, alpha=0.6, label=label)

    # Null line
    ref = 1.0 if is_log else 0.0
    ax.axvline(x=ref, color="gray", linestyle="--", linewidth=0.8)

    # Study points
    disp_yi = np.exp(yi) if is_log else yi
    ax.scatter(disp_yi, se, s=30, color="#1565C0", edgecolor="black", linewidth=0.3, zorder=3, label="研究" if zh else "Studies")

    ax.set_xlabel(f"{pooled.effect_measure}", fontsize=10)
    ax.set_ylabel("标准误" if zh else "Standard Error", fontsize=10)
    ax.invert_yaxis()
    ax.set_title(title, fontsize=12, fontweight="bold")
    ax.legend(fontsize=7, loc="lower right")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# PRISMA 2020 Flow Diagram (Page et al., 2021)
# =============================================================================

def prisma_flow_diagram(prisma_data: dict, save_path: str = None, lang: str = "en") -> str:
    """Generate a PRISMA 2020 flow diagram per Page et al. (2021).

    Three-column layout:
    - Left: Databases/Registers identification
    - Center: Screening flow
    - Right: Other methods (websites, citation searching)
    Includes "Previous studies" row and automation exclusion row.

    Args:
        lang: "en" for English labels, "zh" for Chinese labels.

    Returns base64 data URI of the PNG image.
    """
    import textwrap as _textwrap

    zh = lang == "zh"

    # --- Localized text ---
    T = {
        "title":       "PRISMA 2020 文献筛选流程图" if zh else "PRISMA 2020 Flow Diagram",
        "identification": "识别" if zh else "Identification",
        "screening":     "筛选" if zh else "Screening",
        "included":      "纳入" if zh else "Included",
        "previous":      f"既往研究\n（n = %d）" if zh else "Previous studies\n(n = %d)",
        "identified":    f"数据库检索记录\n（n = %d）" if zh else "Records identified from\nDatabases (n = %d)",
        "other":         f"其他来源记录\n（n = %d）" if zh else "Records identified from\nother methods (n = %d)",
        "dedup":         f"去重后记录\n（n = %d）" if zh else "Records after duplicates removed\n(n = %d)",
        "auto_excl":     f"自动化工具排除\n（n = %d）" if zh else "Records removed by\nautomation tools\n(n = %d)",
        "ta_screened":   f"标题/摘要筛选\n（n = %d）" if zh else "Records screened\n(title/abstract)\n(n = %d)",
        "ta_excluded":   f"标题/摘要排除\n（n = %d）" if zh else "Records excluded\n(n = %d)",
        "ft_sought":     f"全文获取\n（n = %d）" if zh else "Reports sought for\nretrieval (n = %d)",
        "not_retrieved": f"全文未获取\n（n = %d）" if zh else "Reports not retrieved\n(n = %d)",
        "ft_assessed":   f"全文评估\n（n = %d）" if zh else "Reports assessed for\neligibility (n = %d)",
        "ft_excluded":   f"全文排除\n（n = %d）" if zh else "Reports excluded\n(n = %d)",
        "studies_inc":   f"纳入研究\n（n = %d）" if zh else "Studies included in review\n(n = %d)",
        "in_ma":         f"Meta分析纳入\n（n = %d）" if zh else "Reports included in meta-analysis\n(n = %d)",
        "other_sought":  f"其他来源全文获取\n（n = %d）" if zh else "Reports sought for\nretrieval (other)\n(n = %d)",
        "other_assessed":f"其他来源评估\n（n = %d）" if zh else "Reports assessed\n(other methods)\n(n = %d)",
    }

    ident = prisma_data.get("identification", {})
    screen = prisma_data.get("screening", {})
    elig = prisma_data.get("eligibility", {})
    incl = prisma_data.get("included", {})
    prev = prisma_data.get("previous_studies", {})
    other = prisma_data.get("other_methods", {})

    n_identified = ident.get("records_identified", 0)
    n_other = other.get("records_identified", 0)
    n_previous = prev.get("previous_studies", 0)
    n_dedup = ident.get("records_after_dedup", 0)
    n_auto_excluded = ident.get("automation_excluded", 0)
    n_screened = screen.get("title_abstract_screened", 0)
    n_ta_excluded = screen.get("title_abstract_excluded", 0)
    n_sought = elig.get("full_text_sought", elig.get("full_text_assessed", 0))
    n_not_retrieved = elig.get("not_retrieved", 0)
    n_ft_assessed = elig.get("full_text_assessed", 0)
    n_ft_excluded = elig.get("full_text_excluded", 0)
    n_included = incl.get("studies_included", 0)
    n_in_ma = incl.get("in_meta_analysis", n_included)

    # --- Format exclusion reasons: truncate each reason to avoid overflow ---
    def _fmt_reasons(reasons_dict, max_n: int = 4, key_max: int = 32) -> str:
        if not reasons_dict:
            return ""
        lines = []
        for k, v in list(reasons_dict.items())[:max_n]:
            k_str = str(k)
            if len(k_str) > key_max:
                k_str = k_str[:key_max - 1] + "…"
            lines.append(f"• {k_str}: {v}")
        return "\n".join(lines)

    ta_reasons_str = _fmt_reasons(screen.get("exclusion_reasons", {}), max_n=4)
    ft_reasons_str = _fmt_reasons(elig.get("exclusion_reasons", {}), max_n=5)

    ta_reason_lines = len(ta_reasons_str.split("\n")) if ta_reasons_str else 0
    ft_reason_lines = len(ft_reasons_str.split("\n")) if ft_reasons_str else 0

    # Dynamic exclusion box heights: header line + per-reason lines
    LINE_H = 0.20          # height per text line in axis units
    EXCL_BASE_H = 0.50     # minimum height for "Records excluded (n=X)" header
    ta_excl_h = EXCL_BASE_H + ta_reason_lines * LINE_H
    ft_excl_h = EXCL_BASE_H + ft_reason_lines * LINE_H

    # Compute overall figure height: base 11 + extra for long exclusion lists
    extra_h = max(0, ta_reason_lines - 2) * 0.25 + max(0, ft_reason_lines - 2) * 0.25
    fig_height = 11 + extra_h

    # Layout constants — three-column positions in x-axis [0, 12] space
    X_LEFT = 2.5      # database / main column
    X_EXCL = 6.5      # exclusion boxes (middle)
    X_RIGHT = 9.8     # other methods column
    W_MAIN = 2.8
    W_EXCL = 2.5
    W_RIGHT = 2.8

    fig, ax = plt.subplots(1, 1, figsize=(17, fig_height))
    Y_MAX = 11 + extra_h
    ax.set_xlim(0, 12)
    ax.set_ylim(0, Y_MAX)
    ax.axis("off")

    S = Y_MAX / 10.0

    def sy(y: float) -> float:
        return y * S

    def draw_box(x, y, w, h, text, color="#E3F2FD", fontsize=7):
        box = FancyBboxPatch(
            (x - w / 2, y - h / 2), w, h,
            boxstyle="round,pad=0.08", facecolor=color, edgecolor="black", linewidth=0.8
        )
        ax.add_patch(box)
        ax.text(x, y, text, ha="center", va="center", fontsize=fontsize,
                fontweight="bold", wrap=False, linespacing=1.3)

    def draw_box_top_aligned(x, y_top, w, h, text, color="#FFCDD2", fontsize=6.5):
        box = FancyBboxPatch(
            (x - w / 2, y_top - h), w, h,
            boxstyle="round,pad=0.08", facecolor=color, edgecolor="black", linewidth=0.8
        )
        ax.add_patch(box)
        ax.text(x, y_top - 0.08, text, ha="center", va="top", fontsize=fontsize,
                linespacing=1.3)

    def draw_arrow(x1, y1, x2, y2):
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="-|>", color="black", lw=0.8))

    def draw_section_label(x, y, text):
        ax.text(x, y, text, ha="center", va="center", fontsize=8,
                fontweight="bold", fontstyle="italic", color="#37474F")

    # === Section labels ===
    draw_section_label(0.7, sy(9.5), T["identification"])
    draw_section_label(0.7, sy(6.25), T["screening"])
    draw_section_label(0.7, sy(2.8), T["included"])

    # === Previous studies ===
    draw_box(X_LEFT, sy(9.4), W_MAIN, 0.6 * S,
             T["previous"] % n_previous,
             color="#E8EAF6")

    # === Databases ===
    draw_box(X_LEFT, sy(8.4), W_MAIN, 0.65 * S,
             T["identified"] % n_identified,
             color="#BBDEFB")

    # === Other methods ===
    draw_box(X_RIGHT, sy(8.4), W_RIGHT, 0.65 * S,
             T["other"] % n_other,
             color="#B2DFDB")

    draw_arrow(X_LEFT, sy(9.12), X_LEFT, sy(8.72))

    # === Deduplication ===
    draw_box(X_LEFT, sy(7.5), W_MAIN, 0.60 * S,
             T["dedup"] % n_dedup,
             color="#E3F2FD")
    draw_arrow(X_LEFT, sy(8.07), X_LEFT, sy(7.80))

    # === Automation exclusion ===
    if n_auto_excluded > 0:
        draw_box(X_EXCL, sy(7.5), W_EXCL, 0.52 * S,
                 T["auto_excl"] % n_auto_excluded,
                 color="#FFCDD2", fontsize=6.5)
        draw_arrow(X_LEFT + W_MAIN / 2, sy(7.5), X_EXCL - W_EXCL / 2, sy(7.5))

    # === T/A Screening box ===
    draw_box(X_LEFT, sy(6.56), W_MAIN, 0.60 * S,
             T["ta_screened"] % n_screened,
             color="#C8E6C9")
    draw_arrow(X_LEFT, sy(7.20), X_LEFT, sy(6.86))

    # === T/A Exclusion box ===
    ta_excl_text = T["ta_excluded"] % n_ta_excluded
    if ta_reasons_str:
        ta_excl_text += f"\n{ta_reasons_str}"
    draw_box_top_aligned(
        X_EXCL, sy(6.56) + ta_excl_h / 2,
        W_EXCL, ta_excl_h,
        ta_excl_text, color="#FFCDD2"
    )
    draw_arrow(X_LEFT + W_MAIN / 2, sy(6.56), X_EXCL - W_EXCL / 2, sy(6.56))

    # === Full text retrieval ===
    draw_box(X_LEFT, sy(5.5), W_MAIN, 0.60 * S,
             T["ft_sought"] % n_sought,
             color="#C8E6C9")
    draw_arrow(X_LEFT, sy(6.26), X_LEFT, sy(5.80))

    if n_not_retrieved > 0:
        draw_box(X_EXCL, sy(5.5), W_EXCL, 0.50 * S,
                 T["not_retrieved"] % n_not_retrieved,
                 color="#FFCDD2", fontsize=6.5)
        draw_arrow(X_LEFT + W_MAIN / 2, sy(5.5), X_EXCL - W_EXCL / 2, sy(5.5))

    # === Full text assessed ===
    draw_box(X_LEFT, sy(4.44), W_MAIN, 0.60 * S,
             T["ft_assessed"] % n_ft_assessed,
             color="#C8E6C9")
    draw_arrow(X_LEFT, sy(5.20), X_LEFT, sy(4.74))

    # === FT Exclusion box ===
    ft_excl_text = T["ft_excluded"] % n_ft_excluded
    if ft_reasons_str:
        ft_excl_text += f"\n{ft_reasons_str}"
    draw_box_top_aligned(
        X_EXCL, sy(4.44) + ft_excl_h / 2,
        W_EXCL, ft_excl_h,
        ft_excl_text, color="#FFCDD2"
    )
    draw_arrow(X_LEFT + W_MAIN / 2, sy(4.44), X_EXCL - W_EXCL / 2, sy(4.44))

    # === Other methods screening column ===
    draw_box(X_RIGHT, sy(6.56), W_RIGHT, 0.60 * S,
             T["other_sought"] % n_other,
             color="#B2DFDB", fontsize=6.5)
    draw_arrow(X_RIGHT, sy(8.07), X_RIGHT, sy(6.86))

    draw_box(X_RIGHT, sy(5.5), W_RIGHT, 0.60 * S,
             T["other_assessed"] % other.get('assessed', n_other),
             color="#B2DFDB", fontsize=6.5)
    draw_arrow(X_RIGHT, sy(6.26), X_RIGHT, sy(5.80))

    # Merge arrow from other methods to included
    draw_arrow(X_RIGHT, sy(5.20), X_LEFT + 1, sy(3.6))

    # === Included ===
    draw_arrow(X_LEFT, sy(4.14), X_LEFT, sy(3.44))
    draw_box(X_LEFT + 2, sy(3.1), 6.0, 0.80 * S,
             T["studies_inc"] % n_included + "\n" + T["in_ma"] % n_in_ma,
             color="#FFF9C4")

    fig.suptitle(T["title"], fontsize=12, fontweight="bold", y=0.99)
    plt.tight_layout(rect=[0, 0, 1, 0.97])
    if save_path:
        fig.savefig(save_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig, dpi=150)


# =============================================================================
# Risk of Bias Summary Plot
# =============================================================================

def rob_summary_plot(rob_data: list[dict], save_path: str = None, tool: str = "RoB 2", lang: str = "en") -> str:
    """Generate a risk-of-bias traffic light plot.

    rob_data: list of {"study_label": str, "domains": {"domain_name": "Low risk"|"Some concerns"|"High risk"}}

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    if not rob_data:
        return ""

    zh = lang == "zh"

    color_map = {
        "Low risk": "#4CAF50",
        "Some concerns": "#FFC107",
        "High risk": "#F44336",
    }
    symbol_map = {
        "Low risk": "+",
        "Some concerns": "?",
        "High risk": "\u2212",
    }
    label_map_zh = {
        "Low risk": "\u4f4e\u98ce\u9669",
        "Some concerns": "\u5b58\u5728\u62c5\u5fe7",
        "High risk": "\u9ad8\u98ce\u9669",
    }

    # Collect all domains
    all_domains = []
    for entry in rob_data:
        for d in entry.get("domains", {}):
            if d not in all_domains:
                all_domains.append(d)

    studies = [e.get("study_label", "") for e in rob_data]
    k = len(studies)
    n_domains = len(all_domains)

    fig, ax = plt.subplots(1, 1, figsize=(max(6, n_domains * 1.2), max(4, k * 0.4 + 2)))

    for i, study_entry in enumerate(rob_data):
        domains = study_entry.get("domains", {})
        for j, domain in enumerate(all_domains):
            judgment = domains.get(domain, "")
            color = color_map.get(judgment, "#BDBDBD")
            symbol = symbol_map.get(judgment, "")
            circle = plt.Circle((j + 0.5, k - i - 0.5), 0.35, color=color, ec="black", lw=0.5)
            ax.add_patch(circle)
            ax.text(j + 0.5, k - i - 0.5, symbol, ha="center", va="center", fontsize=10, fontweight="bold", color="white")

    ax.set_xlim(0, n_domains)
    ax.set_ylim(0, k)
    ax.set_xticks([j + 0.5 for j in range(n_domains)])
    ax.set_xticklabels(all_domains, fontsize=7, rotation=45, ha="right")
    ax.set_yticks([k - i - 0.5 for i in range(k)])
    ax.set_yticklabels(studies, fontsize=8)
    rob_title = f"偏倚风险汇总 ({tool})" if zh else f"Risk of Bias Summary ({tool})"
    ax.set_title(rob_title, fontsize=12, fontweight="bold")

    # Legend
    if zh:
        patches = [mpatches.Patch(color=c, label=label_map_zh.get(l, l)) for l, c in color_map.items()]
    else:
        patches = [mpatches.Patch(color=c, label=l) for l, c in color_map.items()]
    ax.legend(handles=patches, loc="upper right", fontsize=7)

    ax.set_aspect("equal")
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# Sensitivity (Leave-one-out) Forest Plot
# =============================================================================

def sensitivity_plot(
    results: list[LeaveOneOutResult],
    overall_effect: float,
    overall_ci: tuple[float, float],
    effect_measure: str,
    save_path: str = None,
    lang: str = "en",
) -> str:
    """Generate a leave-one-out sensitivity analysis forest plot.

    Returns base64 data URI of the PNG image.
    """
    k = len(results)
    zh = lang == "zh"
    fig, ax = plt.subplots(1, 1, figsize=(10, max(4, k * 0.4 + 2)))

    y_positions = list(range(k, 0, -1))

    for i, (r, ypos) in enumerate(zip(results, y_positions)):
        ax.plot([r.ci_lower, r.ci_upper], [ypos, ypos], color="black", linewidth=1)
        ax.scatter([r.pooled_effect], [ypos], s=40, marker="s", color="#FF7043", edgecolor="black", linewidth=0.5, zorder=2)

    # Overall effect band
    ax.axvspan(overall_ci[0], overall_ci[1], alpha=0.1, color="blue")
    ax.axvline(x=overall_effect, color="blue", linestyle="--", linewidth=0.8)

    is_log = effect_measure in _LOG_MEASURES
    ref = 1.0 if is_log else 0.0
    ax.axvline(x=ref, color="gray", linestyle=":", linewidth=0.8)

    excl_prefix = "\u5254\u9664" if zh else "Excl."
    labels = [f"{excl_prefix} {r.excluded_study_label}  \u2192  {r.pooled_effect:.2f} [{r.ci_lower:.2f}, {r.ci_upper:.2f}]  I\u00b2={r.i_squared:.1f}%"
              for r in results]
    ax.set_yticks(y_positions)
    ax.set_yticklabels(labels, fontsize=7, fontfamily="monospace")
    ax.set_xlabel(f"{effect_measure}", fontsize=10)
    ax.set_title("\u9010\u4e00\u5254\u9664\u654f\u611f\u6027\u5206\u6790" if zh else "Leave-one-out Sensitivity Analysis", fontsize=12, fontweight="bold")

    if is_log:
        ax.set_xscale("log")

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# Cumulative Forest Plot
# =============================================================================

def cumulative_forest_plot(
    results: list[CumulativeResult],
    effect_measure: str,
    save_path: str = None,
    title: str = None,
    lang: str = "en",
) -> str:
    """Generate a cumulative meta-analysis forest plot.

    Shows how the pooled effect evolves as studies are added.

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    if not results:
        return ""

    zh = lang == "zh"
    if title is None:
        title = "累积Meta分析" if zh else "Cumulative Meta-Analysis"
    k = len(results)
    fig, ax = plt.subplots(1, 1, figsize=(10, max(4, k * 0.4 + 2)))

    is_log = effect_measure in _LOG_MEASURES
    y_positions = list(range(k, 0, -1))

    for i, (r, ypos) in enumerate(zip(results, y_positions)):
        ax.plot([r.ci_lower, r.ci_upper], [ypos, ypos], color="black", linewidth=1)
        ax.scatter([r.pooled_effect], [ypos], s=40, marker="s", color="#4CAF50", edgecolor="black", linewidth=0.5, zorder=2)

    # Reference line
    ref = 1.0 if is_log else 0.0
    ax.axvline(x=ref, color="gray", linestyle="--", linewidth=0.8, zorder=0)

    # Final pooled effect
    if results:
        final = results[-1]
        ax.axvline(x=final.pooled_effect, color="blue", linestyle=":", linewidth=0.8, alpha=0.5)

    labels = [f"+{r.study_label} (k={r.n_studies})  {r.pooled_effect:.2f} [{r.ci_lower:.2f}, {r.ci_upper:.2f}]"
              for r in results]
    ax.set_yticks(y_positions)
    ax.set_yticklabels(labels, fontsize=7, fontfamily="monospace")
    ax.set_xlabel(f"{effect_measure}", fontsize=10)
    ax.set_title(title, fontsize=12, fontweight="bold")

    if is_log:
        ax.set_xscale("log")

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# NMA Network Plot
# =============================================================================

def network_plot(
    geometry: dict,
    save_path: str = None,
    title: str = "Network Meta-Analysis",
) -> str:
    """Generate a network plot for NMA.

    Nodes sized proportional to number of studies; edges weighted by number of direct comparisons.
    geometry: dict with "nodes" (list of {treatment, n_studies}) and "edges" (list of {treatment_a, treatment_b, n_comparisons})

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    nodes = geometry.get("nodes", [])
    edges = geometry.get("edges", [])

    if not nodes:
        return ""

    fig, ax = plt.subplots(1, 1, figsize=(8, 8))

    n_nodes = len(nodes)
    # Circular layout
    angles = np.linspace(0, 2 * np.pi, n_nodes, endpoint=False)
    radius = 3.0
    positions = {}
    for i, node in enumerate(nodes):
        name = node.get("treatment", f"T{i}")
        x = radius * np.cos(angles[i])
        y = radius * np.sin(angles[i])
        positions[name] = (x, y)

    # Draw edges
    max_comp = max((e.get("n_studies", e.get("n_comparisons", 1)) for e in edges), default=1)
    for edge in edges:
        ta = edge.get("treatment", edge.get("treatment_a", ""))
        tb = edge.get("comparator", edge.get("treatment_b", ""))
        n_comp = edge.get("n_studies", edge.get("n_comparisons", 1))
        if ta in positions and tb in positions:
            x1, y1 = positions[ta]
            x2, y2 = positions[tb]
            lw = max(1, 6 * n_comp / max_comp)
            ax.plot([x1, x2], [y1, y2], color="#78909C", linewidth=lw, zorder=1, alpha=0.7)
            # Label on edge
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            ax.text(mx, my, str(n_comp), fontsize=6, ha="center", va="center",
                    color="#546E7A", fontweight="bold")

    # Draw nodes
    max_studies = max((n.get("n_studies", 1) for n in nodes), default=1)
    for node in nodes:
        name = node.get("treatment", "")
        n_studies = node.get("n_studies", 1)
        x, y = positions.get(name, (0, 0))
        size = max(300, 1500 * n_studies / max_studies)
        ax.scatter([x], [y], s=size, color="#1565C0", edgecolor="black", linewidth=1.5, zorder=3)
        ax.text(x, y - 0.5, f"{name}\n(k={n_studies})", ha="center", va="top",
                fontsize=8, fontweight="bold")

    ax.set_xlim(-radius - 2, radius + 2)
    ax.set_ylim(-radius - 2, radius + 2)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(title, fontsize=14, fontweight="bold")
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# NMA League Table Heatmap
# =============================================================================

def league_table_heatmap(
    league_table: list,
    treatments: list[str],
    save_path: str = None,
    title: str = "NMA League Table",
) -> str:
    """Generate a league table heatmap for NMA results.

    Cells show effect (95% CI) with color coding by significance.

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    if not league_table or not treatments:
        return ""

    k = len(treatments)
    trt_idx = {t: i for i, t in enumerate(treatments)}

    # Build matrix
    effects = np.full((k, k), np.nan)
    ci_texts = [[""]*k for _ in range(k)]

    for contrast in league_table:
        trt = contrast.treatment if hasattr(contrast, 'treatment') else contrast.get("treatment", "")
        comp = contrast.comparator if hasattr(contrast, 'comparator') else contrast.get("comparator", "")
        eff = contrast.effect if hasattr(contrast, 'effect') else contrast.get("effect", 0)
        ci_lo = contrast.ci_lower if hasattr(contrast, 'ci_lower') else contrast.get("ci_lower", 0)
        ci_hi = contrast.ci_upper if hasattr(contrast, 'ci_upper') else contrast.get("ci_upper", 0)
        p_val = contrast.p_value if hasattr(contrast, 'p_value') else contrast.get("p_value", 1)

        if trt in trt_idx and comp in trt_idx:
            i, j = trt_idx[trt], trt_idx[comp]
            effects[i, j] = eff
            effects[j, i] = -eff
            sig = "*" if p_val < 0.05 else ""
            ci_texts[i][j] = f"{eff:.2f}\n({ci_lo:.2f}, {ci_hi:.2f}){sig}"
            ci_texts[j][i] = f"{-eff:.2f}\n({-ci_hi:.2f}, {-ci_lo:.2f}){sig}"

    fig, ax = plt.subplots(1, 1, figsize=(max(8, k * 1.5), max(6, k * 1.2)))

    # Color map: significant negative=green, significant positive=red, NS=white
    cmap = plt.cm.RdYlGn_r
    im = ax.imshow(effects, cmap=cmap, aspect="equal", vmin=-2, vmax=2)

    # Text annotations
    for i in range(k):
        for j in range(k):
            if i == j:
                ax.text(j, i, treatments[i], ha="center", va="center",
                        fontsize=7, fontweight="bold", color="black")
            elif ci_texts[i][j]:
                ax.text(j, i, ci_texts[i][j], ha="center", va="center",
                        fontsize=5, color="black")

    ax.set_xticks(range(k))
    ax.set_xticklabels(treatments, fontsize=7, rotation=45, ha="right")
    ax.set_yticks(range(k))
    ax.set_yticklabels(treatments, fontsize=7)
    ax.set_title(title, fontsize=12, fontweight="bold")

    plt.colorbar(im, ax=ax, shrink=0.8, label="Effect size")
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# SUCRA Ranking Bar Plot
# =============================================================================

def sucra_barplot(
    sucra_rankings: dict[str, float],
    save_path: str = None,
    title: str = "SUCRA Rankings",
) -> str:
    """Generate a horizontal bar plot of SUCRA rankings.

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    if not sucra_rankings:
        return ""

    treatments = sorted(sucra_rankings.keys(), key=lambda t: sucra_rankings[t], reverse=True)
    scores = [sucra_rankings[t] for t in treatments]

    fig, ax = plt.subplots(1, 1, figsize=(8, max(3, len(treatments) * 0.4 + 1)))

    colors = plt.cm.RdYlGn(np.array(scores))
    y_pos = range(len(treatments))
    ax.barh(y_pos, scores, color=colors, edgecolor="black", linewidth=0.5)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(treatments, fontsize=9)
    ax.set_xlabel("SUCRA Score", fontsize=10)
    ax.set_xlim(0, 1)
    ax.set_title(title, fontsize=12, fontweight="bold")

    for i, (score, trt) in enumerate(zip(scores, treatments)):
        ax.text(score + 0.02, i, f"{score:.1%}", va="center", fontsize=8)

    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.invert_yaxis()
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# Baujat Plot
# =============================================================================

def baujat_plot(
    diagnostics: list[dict],
    save_path: str = None,
    title: str = None,
    lang: str = "en",
) -> str:
    """Generate a Baujat plot (contribution to Q vs. influence on pooled).

    diagnostics: list of dicts from influence_diagnostics() with
    'contribution_to_q', 'loo_influence', 'study_label'.

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    if not diagnostics:
        return ""

    zh = lang == "zh"
    if title is None:
        title = "Baujat图" if zh else "Baujat Plot"
    fig, ax = plt.subplots(1, 1, figsize=(8, 6))

    x = [d["contribution_to_q"] for d in diagnostics]
    y = [d["loo_influence"] for d in diagnostics]
    labels = [d["study_label"] for d in diagnostics]

    ax.scatter(x, y, s=50, color="#1565C0", edgecolor="black", linewidth=0.5, zorder=3)

    # Label points
    for i, label in enumerate(labels):
        ax.annotate(label, (x[i], y[i]), fontsize=6, ha="left", va="bottom",
                    xytext=(3, 3), textcoords="offset points")

    ax.set_xlabel("对总体异质性的贡献 (Q)" if zh else "Contribution to overall heterogeneity (Q)", fontsize=10)
    ax.set_ylabel("对合并效应的影响" if zh else "Influence on pooled result", fontsize=10)
    ax.set_title(title, fontsize=12, fontweight="bold")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)


# =============================================================================
# Galbraith (Radial) Plot
# =============================================================================

def galbraith_plot(
    pooled: PooledEffect,
    save_path: str = None,
    title: str = None,
    lang: str = "en",
) -> str:
    """Generate a Galbraith radial plot.

    X-axis: precision (1/SE), Y-axis: standardized effect (yi/SE).
    Studies on the regression line have no heterogeneity.

    Returns base64 data URI of the PNG image, or empty string if no data.
    """
    studies = pooled.studies
    if not studies:
        return ""

    zh = lang == "zh"
    if title is None:
        title = "Galbraith (径向) 图" if zh else "Galbraith (Radial) Plot"
    fig, ax = plt.subplots(1, 1, figsize=(8, 6))

    yi = np.array([s.yi for s in studies])
    se = np.array([s.se for s in studies])
    precision = 1.0 / se
    std_effect = yi / se

    # Scatter
    ax.scatter(precision, std_effect, s=40, color="#1565C0", edgecolor="black",
               linewidth=0.5, zorder=3)

    # Regression line (pooled effect)
    pooled_log = pooled.pooled_log if pooled.pooled_log is not None else pooled.pooled_effect
    x_range = np.linspace(0, max(precision) * 1.1, 100)
    ax.plot(x_range, pooled_log * x_range, color="blue", linewidth=1, linestyle="--",
            label=f"{'合并效应' if zh else 'Pooled effect'} = {pooled_log:.3f}")

    # 95% CI band (±1.96 around the regression line)
    ax.plot(x_range, pooled_log * x_range + 1.96, color="gray", linewidth=0.5, linestyle=":")
    ax.plot(x_range, pooled_log * x_range - 1.96, color="gray", linewidth=0.5, linestyle=":")
    ax.fill_between(x_range, pooled_log * x_range - 1.96, pooled_log * x_range + 1.96,
                     alpha=0.1, color="gray")

    # Label outliers (outside 95% band)
    for i, s in enumerate(studies):
        resid = std_effect[i] - pooled_log * precision[i]
        if abs(resid) > 1.96:
            ax.annotate(s.study_label, (precision[i], std_effect[i]),
                        fontsize=6, ha="left", va="bottom", color="red",
                        xytext=(3, 3), textcoords="offset points")

    ax.set_xlabel("精度 (1/SE)" if zh else "Precision (1/SE)", fontsize=10)
    ax.set_ylabel("标准化效应 (yi/SE)" if zh else "Standardized effect (yi/SE)", fontsize=10)
    ax.set_title(title, fontsize=12, fontweight="bold")
    ax.legend(fontsize=8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()
    if save_path:
        fig.savefig(save_path, dpi=300, bbox_inches="tight")
        plt.close(fig)
        return ""
    return _fig_to_base64(fig)
