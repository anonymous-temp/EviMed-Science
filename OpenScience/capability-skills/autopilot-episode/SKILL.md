---
name: autopilot-episode
description: Produce a bounded, evidence-linked agenda delta when a capability runs as a proactive research episode.
---

# Proactive research episode

Apply this companion only when the brief explicitly identifies a proactive research episode. Keep the capability's ordinary deliverables and gates unchanged.

Also write `agenda-delta.json` with `schemaVersion: 1` and a `claims` array. Each claim carries `id`, `statement`, `type` (`direct`, `synthesized`, or `derived`), `tier: "unverified"`, non-empty `sources`, and `provenance: { "episodeId": "<the episode id>", "artifact": "<an accepted artifact path from this run>" }`. A synthesized or derived claim also carries `what_would_change` and `confidence` (`high`, `moderate`, or `low`). An episode with no defensible claim writes an empty array. Never invent a headline, grade your own claim, send messages, purchase anything, reach an unlisted source, or give individual treatment advice.
