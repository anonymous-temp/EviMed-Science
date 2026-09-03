"""Forest plot rendering checks that do not depend on the host font set."""
import matplotlib

matplotlib.use("Agg")
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt

from new_meta.engines import visualization


def test_chinese_rows_leave_the_monospace_family() -> None:
    if not visualization._chosen_font:
        return  # no CJK face installed; the label can only fall back to monospace
    figure, axes = plt.subplots()
    axes.set_yticks([0, 1])
    visualization._set_row_labels(
        axes, ["Morrow 2010  0.32 [0.11, 0.92]", "合并效应  1.03 [0.68, 1.55]"]
    )
    families = [tick.get_fontfamily()[0] for tick in axes.get_yticklabels()]
    plt.close(figure)
    assert families == ["monospace", visualization._chosen_font]


def test_a_pan_cjk_family_satisfies_the_chinese_font_search() -> None:
    # Debian ships one pan-CJK face registered as "Noto Sans CJK JP". It carries
    # the Simplified Chinese glyphs, so the search must accept it.
    class _Face:
        def __init__(self, name: str) -> None:
            self.name = name

    original = fm.fontManager.ttflist
    fm.fontManager.ttflist = [_Face(name) for name in ("DejaVu Sans", "Noto Serif CJK JP", "Noto Sans CJK JP")]
    try:
        assert visualization._detect_chinese_font() == "Noto Sans CJK JP"
    finally:
        fm.fontManager.ttflist = original


def test_a_font_installed_after_the_cache_was_built_is_still_found(monkeypatch) -> None:
    # `ttflist` is a cache. Installing a CJK family after matplotlib first
    # built it leaves the font on disk and out of the list, and the search
    # reported "no Chinese-capable font found" on a host carrying five of them
    # -- so a Chinese manuscript got tofu boxes from a machine that had the
    # glyphs. The search must read the directories, not only the cache.
    class _Face:
        def __init__(self, name: str) -> None:
            self.name = name

    registered: list[str] = []
    monkeypatch.setattr(fm.fontManager, "ttflist", registered)
    monkeypatch.setattr(
        fm,
        "findSystemFonts",
        lambda *args, **kwargs: [
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansMonoCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        ],
    )

    def _addfont(path: str) -> None:
        assert path.endswith("NotoSansCJK-Regular.ttc"), path
        registered.append(_Face("Noto Sans CJK JP"))

    monkeypatch.setattr(fm.fontManager, "addfont", _addfont)

    assert visualization._detect_chinese_font() == "Noto Sans CJK JP"


def test_a_host_with_no_cjk_font_at_all_still_says_so(monkeypatch) -> None:
    # The control. Registering nothing must not be reported as a font.
    monkeypatch.setattr(fm.fontManager, "ttflist", [])
    monkeypatch.setattr(fm, "findSystemFonts", lambda *args, **kwargs: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"])
    monkeypatch.setattr(fm.fontManager, "addfont", lambda path: (_ for _ in ()).throw(AssertionError("must not be called")))

    assert visualization._detect_chinese_font() == ""
