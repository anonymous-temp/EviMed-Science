"""robots.txt (RFC 9309) parsing, matching and the cache's failure semantics."""

from __future__ import annotations

from knowledge_plugin.robots import RobotsCache, parse_robots

ROBOTS = """
# comment
User-agent: *
Disallow: /private/
Allow: /private/open
Disallow: /*.pdf$
Crawl-delay: 5

User-agent: EviMedBot
Disallow: /search
Allow: /search/feeds
"""


def test_our_group_wins_over_the_star_group():
    rules = parse_robots(ROBOTS)
    assert not rules.allowed("/search?q=x")
    assert rules.allowed("/search/feeds/rss")
    assert rules.allowed("/private/anything")          # the * rules do not apply when our group exists
    assert rules.crawl_delay is None


def test_star_group_longest_match_and_anchors():
    rules = parse_robots(ROBOTS.split("User-agent: EviMedBot")[0])
    assert not rules.allowed("/private/x")
    assert rules.allowed("/private/open/page")          # the longer Allow wins
    assert not rules.allowed("/docs/a.pdf")
    assert rules.allowed("/docs/a.pdf?download=1")      # $ anchors the end
    assert rules.allowed("/robots.txt")
    assert rules.crawl_delay == 5.0


def test_equal_length_tie_goes_to_allow():
    rules = parse_robots("User-agent: *\nDisallow: /a\nAllow: /a\n")
    assert rules.allowed("/a")


def test_empty_disallow_allows_everything_and_no_group_allows_all():
    assert parse_robots("User-agent: *\nDisallow:\n").allowed("/anything")
    assert parse_robots("User-agent: SomeOtherBot\nDisallow: /\n").allowed("/anything")


def test_eutils_style_disallow_all():
    assert not parse_robots("User-agent: *\nDisallow: /\n").allowed("/entrez/eutils/esearch.fcgi")


async def test_cache_semantics_4xx_allows_5xx_disallows():
    answers = {"https://a.example": (404, None), "https://b.example": (503, None), "https://c.example": (None, None),
               "https://d.example": (200, "User-agent: *\nDisallow: /x\n")}
    calls = []

    async def fetch(origin):
        calls.append(origin)
        return answers[origin]

    cache = RobotsCache(fetch)
    assert (await cache.check("https://a.example/page"))[0] is True
    allowed, _, unreachable = await cache.check("https://b.example/page")
    assert allowed is False and unreachable is True
    assert (await cache.check("https://c.example/page"))[0] is False
    assert (await cache.check("https://d.example/x/1"))[0] is False
    assert (await cache.check("https://d.example/y"))[0] is True
    assert calls.count("https://d.example") == 1           # cached for the hour


async def test_concurrent_checks_fetch_robots_once():
    import asyncio
    calls = []

    async def fetch(origin):
        calls.append(origin)
        await asyncio.sleep(0.05)
        return None, None                       # a dead host: each fetch would wait out a timeout

    cache = RobotsCache(fetch)
    results = await asyncio.gather(*(cache.check(f"http://slow.example/list{n}") for n in range(3)))
    assert calls == ["http://slow.example"] and all(r[0] is False for r in results)
