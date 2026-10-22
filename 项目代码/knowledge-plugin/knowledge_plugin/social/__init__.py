"""Social posts (contract 1.5.0): X through SocialData, WeChat official accounts through Dajiala, and six Chinese
platforms through the GEO module's crawler — collected into the same stream as every other source.

The scheduler's per-source loop does not poll these sources (``model.SOCIAL_ACCESSES``): their cost and pacing are not a
source's. ``collector.SocialCollector`` runs beside it in the same process, from the same registry rows
(``registry/social-sources.json``, composed with the rest by ``dynamic_registry``), and writes what it reads through the
same normalisation and store — so an X post has a ``seq``, a revision, a content hash and an identity key like a journal
article, its polls are rows of the fetch log, its source has health, and retention purges it on the same clock.

What is different is money and pacing, and both are decided here, in code:

- ``spend`` — every paid call is a ledger row; a provider's daily cap stops that provider until the next Shanghai day,
  and nothing else (``Health.providers``).
- ``media`` — the images posts carry, re-encoded and stored under their sha256, served by ``GET /v1/media/{id}``.
- ``x`` — accounts packed two dozen to a search, newest first, each account's own watermark moved only to its own newest
  post; editorial accounts every 30 minutes, the rest hourly.
- ``wechat`` — each account re-resolved from a verified article link before its first poll (a saved id is not trusted),
  then read at most twice a day, highest priority first.
- ``crawl`` — scheduled searches of a standing medical watch list on the six platforms, one request at a time, spread
  over the day, the GEO module always first.
"""
