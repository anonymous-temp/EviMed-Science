"""The candidate lines of automatic source discovery (``discovery.py``): each proposes candidates, never admits one.

Every line is bounded: it proposes at most a few times what its validation cap can take in a day (the rest waits as a
candidate), and the two that spend requests to find candidates — ``outbound`` reads article pages, ``hot-origin`` looks
DOIs up in Crossref, ``journal`` reads the NLM catalogue — have their own request bounds. What a line "knows" about a
candidate (its type, its owner, its ISSNs) travels as ``hint``; the medical basis it has in data as ``medical_basis``.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from urllib.parse import quote, urljoin

from .discovery import (CROSSREF, EUTILS, LINES, MAX_PAGE_BYTES, SOCIAL_PLATFORMS, Candidate, canonical_site, canonical_url,
                        host_matches, host_of, site_family)
from .model import FetchError, RequestSpec

log = logging.getLogger("knowledge_plugin.discovery_lines")

PROPOSE_PER_CAP = 3                    # a line proposes up to this many times its daily validation cap
OUTBOUND_PER_SOURCE = 3                # article pages read per referring source a day: many publishers, not one
OUTBOUND_TYPES = ("media", "company", "regulator", "evidence-body")
NLM_PAGE = 100
HOT_DOI_LOOKUPS = 30
ISSN = re.compile(r"^\d{4}-\d{3}[\dX]$")
# A URL written out in text (a format, not language): scheme, host, then anything up to whitespace or a closing mark.
BARE_URL = re.compile(r"https?://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:/[^\s<>\"'()\[\]{}，。；）]*)?")


def families_of(urls: set[str]) -> set[str]:
    return {site_family(host_of(url)) for url in urls if host_of(url)}


CHROME_TAGS = frozenset({"nav", "header", "footer", "aside", "form"})


def _in_chrome(node) -> bool:
    parent, depth = node.parent, 0
    while parent is not None and depth < 25:
        if (parent.tag or "").lower() in CHROME_TAGS:
            return True
        parent, depth = parent.parent, depth + 1
    return False


def links_in_page(body: bytes, page_url: str) -> list[str]:
    """Absolute http(s) targets of the links in a page's text: inside ``<article>``/``<main>`` when the page marks its
    body, else every link outside its navigation, header, footer, sidebars and forms (where the partner sites, ads and
    share buttons are). The page's structure decides, not its words."""
    from selectolax.parser import HTMLParser

    try:
        tree = HTMLParser(body[:MAX_PAGE_BYTES].decode("utf-8", errors="replace"))
    except Exception:
        return []
    bodies = tree.css("article, main, [role=main]")
    anchors = [a for container in bodies for a in container.css("a[href]")] if bodies else \
        [a for a in tree.css("a[href]") if not _in_chrome(a)]
    links = []
    for node in anchors:
        href = (node.attributes.get("href") or "").strip()
        if href.startswith(("http://", "https://", "//")):
            if (clean := canonical_url(urljoin(page_url, href))) and clean not in links:
                links.append(clean)
    return links


async def outbound(conn, fetcher, now: datetime, *, pages: int, cap: int, known: set[str], excluded: set[str]) -> list[Candidate]:
    """(a) Sites linked from recent entries' pages: the institutions, hospitals, societies, journals, regulators and
    newsrooms medical news and press releases point to. Pages are read through the protected fetch under the
    referring source's own exit (robots and budgets as for any page); a site linked by more sources ranks first."""
    if pages <= 0 or cap <= 0:
        return []
    rows = await (await conn.execute(
        """SELECT e.url, e.summary, e.source_id, s.egress, s.homepage FROM evimed_knowledge.entries e
             JOIN evimed_knowledge.sources s ON s.id = e.source_id
            WHERE e.first_seen_at > %s AND NOT e.backfill AND s.enabled AND s.retired_at IS NULL AND s.lane <> 'ai'
              AND s.source_type = ANY(%s) AND s.egress IN ('direct', 'relay')
            ORDER BY md5(e.entry_id || %s) LIMIT %s""",
        (now - timedelta(days=2), list(OUTBOUND_TYPES), now.date().isoformat(), pages * 4),
    )).fetchall()
    per_source: Counter = Counter()
    referrers: dict[str, set[str]] = defaultdict(set)
    examples: dict[str, list[str]] = defaultdict(list)
    read = 0

    def note(link: str, row: dict) -> None:
        host = host_of(link)
        family = site_family(host)
        own = {site_family(host_of(row["url"])), site_family(host_of(row["homepage"]))}
        if not host or family in own or host_matches(host, excluded) or host_matches(host, known):
            return
        referrers[family].add(row["source_id"])
        if len(examples[family]) < 3 and link not in examples[family]:
            examples[family].append(link)

    for row in rows:
        for link in BARE_URL.findall(row["summary"] or ""):
            if clean := canonical_url(link):
                note(clean, row)
        if read >= pages or per_source[row["source_id"]] >= OUTBOUND_PER_SOURCE:
            continue
        per_source[row["source_id"]] += 1
        read += 1
        try:
            result = await fetcher.fetch(RequestSpec(url=row["url"], conditional=False), source_id=row["source_id"],
                                         egress=row["egress"], allowed_hosts=[host_of(row["url"])])
        except FetchError:
            continue
        if result.status == 200 and len(result.body) <= MAX_PAGE_BYTES:
            for link in links_in_page(result.body, result.final_url):
                note(link, row)
    ranked = sorted(referrers, key=lambda family: (-len(referrers[family]), family))[:cap * PROPOSE_PER_CAP]
    found = []
    for family in ranked:
        site = canonical_site(examples[family][0]) if examples[family] else None
        if not site:
            continue
        found.append(Candidate("outbound", "site", site, evidence={
            "referrers": sorted(referrers[family])[:5], "referrer_count": len(referrers[family]),
            "links": examples[family], "pages_read": read}))
    return found


async def journal(conn, fetcher, now: datetime, *, cap: int, known_issns: set[str], cursor: int) -> tuple[list[Candidate], int]:
    """(b) MEDLINE journals not in the registry. First the ISSNs the literature streams delivered in the last 14 days
    (they are already reaching us one paper at a time); then the NLM catalogue's journals currently indexed for MEDLINE,
    a page a day in rotation. Validation checks MEDLINE indexing (when not known), a Crossref volume of at least eight
    articles in 30 days, and builds a ``crossref-issn`` row."""
    if cap <= 0:
        return [], cursor
    want = cap * PROPOSE_PER_CAP
    rows = await (await conn.execute(
        """SELECT upper(e.facts->>'issn') AS issn, max(e.facts->>'journal') AS title, count(*) AS n
             FROM evimed_knowledge.entries e
            WHERE e.first_seen_at > %s AND e.facts ? 'issn'
            GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT %s""",
        (now - timedelta(days=14), want * 2),
    )).fetchall()
    found = []
    for row in rows:
        issn = row["issn"] or ""
        if not ISSN.match(issn) or issn in known_issns:
            continue
        found.append(Candidate("journal", "journal", f"issn:{issn}", name=row["title"],
                               hint={"issns": [issn], "title": row["title"]},
                               evidence={"stream_entries_14d": int(row["n"])}))
        if len(found) >= want:
            return found, cursor
    try:
        listing = await fetcher.fetch(RequestSpec(
            url=f"{EUTILS}/esearch.fcgi?db=nlmcatalog&retmode=json&term=currentlyindexed%5BAll%5D"
                f"&retmax={NLM_PAGE}&retstart={cursor}", conditional=False, api=True),
            source_id="discovery", egress="api", allowed_hosts=["eutils.ncbi.nlm.nih.gov"])
        result = json.loads(listing.body).get("esearchresult") or {}
        total, ids = int(result.get("count") or 0), result.get("idlist") or []
        cursor = cursor + NLM_PAGE if cursor + NLM_PAGE < total else 0
        if ids:
            summary = await fetcher.fetch(RequestSpec(
                url=f"{EUTILS}/esummary.fcgi?db=nlmcatalog&retmode=json&id={','.join(ids)}", conditional=False, api=True),
                source_id="discovery", egress="api", allowed_hosts=["eutils.ncbi.nlm.nih.gov"])
            records = json.loads(summary.body).get("result") or {}
            for uid in records.get("uids") or []:
                record = records.get(uid) or {}
                issns = [str(i.get("issn") or "").upper() for i in record.get("issnlist") or []]
                issns = [i for i in issns if ISSN.match(i)]
                if not issns or any(i in known_issns for i in issns):
                    continue
                titles = record.get("titlemainlist") or [{}]
                publishers = record.get("publicationinfolist") or [{}]
                title = (titles[0].get("title") or "").rstrip(". ")
                found.append(Candidate("journal", "journal", f"issn:{issns[0]}", name=title, medical_basis="medline",
                                       hint={"issns": issns, "title": title, "publisher": publishers[0].get("publisher")},
                                       evidence={"nlm_id": uid}))
    except (FetchError, ValueError) as error:
        log.info("NLM catalogue page not read: %s", getattr(error, "detail", type(error).__name__))
    return found[:want], cursor


def directory(data: dict, *, cap: int, known_urls: set[str], cursor: int) -> tuple[list[Candidate], int]:
    """(c) Organisations a person listed as medical or health (``registry/discovery.json``), a slice a day in rotation;
    each is probed for a subscription feed."""
    entries = data.get("directories") or []
    if cap <= 0 or not entries:
        return [], cursor
    want = cap * 2
    found = []
    start = cursor % len(entries)
    for offset in range(len(entries)):
        if len(found) >= want:
            break
        entry = entries[(start + offset) % len(entries)]
        homepage = canonical_url(entry.get("homepage"))
        if not homepage or homepage in known_urls:
            continue
        hint = {name: entry.get(name) for name in ("source_type", "category", "lane", "region", "language",
                                                    "owner_entity", "name") if entry.get(name)}
        hint["homepage"] = homepage
        found.append(Candidate("directory", "site", homepage, name=entry.get("name"), medical_basis="directory", hint=hint))
    return found, (start + want) % len(entries)


async def hot_origin(conn, fetcher, now: datetime, *, cap: int, known_issns: set[str], known: set[str],
                     excluded: set[str]) -> list[Candidate]:
    """(d) Where today's hot items come from: entries two or more publishers carried in the last two days. Their
    journals (the ISSN an entry states, else Crossref's record of the DOI) and their sites when not a resolver."""
    if cap <= 0:
        return []
    rows = await (await conn.execute(
        """SELECT e.identity_key, max(e.doi) AS doi, max(upper(e.facts->>'issn')) AS issn, max(e.facts->>'journal') AS title,
                  array_agg(DISTINCT e.canonical_url) AS urls, count(DISTINCT s.owner_entity) AS publishers
             FROM evimed_knowledge.entries e JOIN evimed_knowledge.sources s ON s.id = e.source_id
            WHERE e.first_seen_at > %s
            GROUP BY e.identity_key HAVING count(DISTINCT s.owner_entity) >= 2
            ORDER BY count(DISTINCT s.owner_entity) DESC, e.identity_key LIMIT 200""",
        (now - timedelta(days=2),),
    )).fetchall()
    found: dict[str, Candidate] = {}
    lookups = 0
    for row in rows:
        if len(found) >= cap * PROPOSE_PER_CAP:
            break
        issn, title = row["issn"], row["title"]
        if not issn and row["doi"] and lookups < HOT_DOI_LOOKUPS:
            lookups += 1
            try:
                work = await fetcher.fetch(RequestSpec(url=f"{CROSSREF}/works/{quote(row['doi'], safe='/')}",
                                                       conditional=False, api=True),
                                           source_id="discovery", egress="api", allowed_hosts=["api.crossref.org"])
                message = json.loads(work.body).get("message") or {}
                issns = [str(i).upper() for i in message.get("ISSN") or []]
                issn = issns[0] if issns else None
                title = (message.get("container-title") or [None])[0]
            except (FetchError, ValueError):
                issn = None
        if issn and ISSN.match(issn) and issn not in known_issns:
            found.setdefault(f"issn:{issn}", Candidate("hot-origin", "journal", f"issn:{issn}", name=title,
                                                       hint={"issns": [issn], "title": title},
                                                       evidence={"publishers": int(row["publishers"]), "doi": row["doi"]}))
        for url in row["urls"] or []:
            host = host_of(url)
            site = canonical_site(url)
            if site and not host_matches(host, excluded) and not host_matches(host, known):
                found.setdefault(site, Candidate("hot-origin", "site", site,
                                                 evidence={"publishers": int(row["publishers"]), "example": url}))
    return list(found.values())


async def social(conn, now: datetime, *, cap: int) -> list[Candidate]:
    """(e) Accounts quoted or reposted in social entries: an X post's quoted author, the account a WeChat repost names.
    Read only when this build stores those fields (another package's adapters); the candidate carries the registry row
    shape the social adapters read, and waits while this build has no adapter for its platform."""
    if cap <= 0:
        return []
    columns = {row["column_name"] for row in await (await conn.execute(
        """SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'evimed_knowledge' AND table_name = 'entries' AND column_name IN ('platform', 'quoted')""",
    )).fetchall()}
    if columns != {"platform", "quoted"}:
        return []
    rows = await (await conn.execute(
        """SELECT platform, quoted->'author'->>'handle' AS handle, quoted->'author'->>'name' AS name, count(*) AS n
             FROM evimed_knowledge.entries
            WHERE first_seen_at > %s AND platform = ANY(%s) AND quoted ? 'author'
            GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT %s""",
        (now - timedelta(days=7), list(SOCIAL_PLATFORMS), cap * PROPOSE_PER_CAP),
    )).fetchall()
    found = []
    for row in rows:
        account = (row["handle"] or row["name"] or "").strip().lstrip("@")
        if not account:
            continue
        key = f"{row['platform']}:{account.lower() if row['platform'] == 'x' else account}"
        found.append(Candidate("social", "social", key, name=row["name"] or account,
                               hint={"platform": row["platform"], "account": account},
                               evidence={"quoted_times_7d": int(row["n"])}))
    return found


async def readmit(conn, now: datetime, *, cap: int) -> list[Candidate]:
    """Retired sources whose re-check is due: proposed as candidates (``key`` ``source:<id>``) and their next re-check
    moved on by their reason's interval, so a source that is still gone is looked at again later, not daily."""
    if cap <= 0:
        return []
    from .lifecycle import RECHECK_AFTER

    rows = await (await conn.execute(
        """SELECT source_id, reason FROM evimed_knowledge.source_lifecycle
            WHERE recheck_after IS NOT NULL AND recheck_after <= %s ORDER BY recheck_after LIMIT %s""",
        (now, cap),
    )).fetchall()
    found = []
    for row in rows:
        interval = RECHECK_AFTER.get(row["reason"])
        await conn.execute("UPDATE evimed_knowledge.source_lifecycle SET recheck_after = %s WHERE source_id = %s",
                           (now + interval if interval else None, row["source_id"]))
        key = f"source:{row['source_id']}"
        # A re-check is a fresh look each time: reopen the candidate the last re-check closed.
        await conn.execute(
            """UPDATE evimed_knowledge.source_candidates SET state = 'candidate', state_reason = NULL, state_at = %s,
                      next_check_at = NULL WHERE key = %s AND state IN ('failed', 'admitted')""",
            (now, key),
        )
        found.append(Candidate("readmit", "source", key, name=row["source_id"], evidence={"reason": row["reason"]}))
    return found


async def gather_all(conn, fetcher, now: datetime, *, data: dict, known_urls: set[str], known_issns: set[str],
                     excluded_hosts: set[str], cursors: dict, outbound_pages: int, caps: dict, lines=None
                     ) -> tuple[list[Candidate], dict]:
    """Every enabled line's proposals for today, and the lines' rotation cursors."""
    lines = set(LINES if lines is None else lines)
    excluded = set(excluded_hosts) | {h.lower() for h in data.get("exclude_hosts", [])}
    known_families = families_of(known_urls)
    cursors = dict(cursors or {})
    found: list[Candidate] = []
    if "readmit" in lines:
        found += await readmit(conn, now, cap=caps.get("readmit", 0))
    if "directory" in lines:
        proposed, cursors["directory"] = directory(data, cap=caps.get("directory", 0), known_urls=known_urls,
                                                   cursor=int(cursors.get("directory", 0)))
        found += proposed
    if "journal" in lines:
        proposed, cursors["journal"] = await journal(conn, fetcher, now, cap=caps.get("journal", 0),
                                                     known_issns=known_issns, cursor=int(cursors.get("journal", 0)))
        found += proposed
    if "hot-origin" in lines:
        found += await hot_origin(conn, fetcher, now, cap=caps.get("hot-origin", 0), known_issns=known_issns,
                                  known=known_families, excluded=excluded)
    if "social" in lines:
        found += await social(conn, now, cap=caps.get("social", 0))
    if "outbound" in lines:
        found += await outbound(conn, fetcher, now, pages=outbound_pages, cap=caps.get("outbound", 0),
                                known=known_families, excluded=excluded)
    unique: dict[str, Candidate] = {}
    for candidate in found:
        unique.setdefault(candidate.key, candidate)
    return list(unique.values()), cursors


def request_candidates(document: dict) -> list[Candidate]:
    """(f) Rows the platform's public source-request manifest asks for in any lane but the AI discovery lane (which keeps
    its own direct admission, ``source_requests.py``): each is a candidate validated like the rest."""
    found = []
    for request in (document.get("sources") or [])[:25]:
        if not isinstance(request, dict) or request.get("lane") == "ai":
            continue
        url = canonical_url((request.get("config") or {}).get("url"))
        if not url or not isinstance(request.get("id"), str):
            continue
        found.append(Candidate("request", "row", url, name=request.get("name"), medical_basis="request",
                               hint={"row": request}))
    return found


