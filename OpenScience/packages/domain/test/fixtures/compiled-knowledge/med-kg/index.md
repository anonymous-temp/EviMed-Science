---
type: index
title: Oral Anticoagulation in Atrial Fibrillation — Knowledge Graph
description: Entry point to the entity graph of randomized trials comparing new oral anticoagulants with warfarin, aspirin or placebo for stroke prevention in atrial fibrillation.
tags: [atrial-fibrillation, anticoagulation, knowledge-graph]
---

## Overview

This graph covers eight supplied source documents: seven randomized-trial reports and one prespecified meta-analysis on oral anticoagulation for stroke and systemic embolism prevention in patients with atrial fibrillation. The corpus spans 2009 to 2020 and is dominated by comparisons of direct oral anticoagulants (factor Xa inhibitors and a direct thrombin inhibitor) against warfarin, plus two non-warfarin comparisons (apixaban versus aspirin, and low-dose edoxaban versus placebo).

## Drugs

- [Edoxaban](entities/edoxaban.md) — direct factor Xa inhibitor; studied in ENGAGE AF-TIMI 48 and ELDERCARE-AF.
- [Rivaroxaban](entities/rivaroxaban.md) — factor Xa inhibitor; studied in ROCKET AF and J-ROCKET AF.
- [Apixaban](entities/apixaban.md) — direct factor Xa inhibitor; studied in ARISTOTLE and AVERROES.
- [Dabigatran](entities/dabigatran.md) — direct thrombin inhibitor; studied in RE-LY.
- [Warfarin](entities/warfarin.md) — vitamin K antagonist and the common comparator across the corpus.
- [Aspirin](entities/aspirin.md) — antiplatelet comparator in AVERROES.

## Trials

- [RE-LY Trial](entities/rel-y-trial.md)
- [ROCKET AF Trial](entities/rocket-af-trial.md)
- [J-ROCKET AF Trial](entities/j-rocket-af-trial.md)
- [ARISTOTLE Trial](entities/aristotle-trial.md)
- [ENGAGE AF-TIMI 48 Trial](entities/engage-af-timi-48-trial.md)
- [ELDERCARE-AF Trial](entities/eldercare-af-trial.md)
- [AVERROES Trial](entities/averroes-trial.md)

## Synthesis and context

- [Meta-Analysis of New Oral Anticoagulants versus Warfarin in Atrial Fibrillation (2014)](entities/noac-af-meta-analysis-2014.md) — pools 71,683 participants from RE-LY, ROCKET AF, ARISTOTLE and ENGAGE AF-TIMI 48.
- [Atrial Fibrillation](entities/atrial-fibrillation.md) — the condition studied by every trial in the corpus.

## Sponsors

- [Daiichi Sankyo](entities/daiichi-sankyo.md)
- [Bristol-Myers Squibb](entities/bristol-myers-squibb.md)
- [Pfizer](entities/pfizer.md)
- [Johnson & Johnson](entities/johnson-and-johnson.md)
- [Bayer](entities/bayer.md)

## Graph artifacts

Typed edges are stored in `relations.jsonl`, one directed statement per line with a machine-readable `relation` predicate, a localized `label`, and per-edge `evidence` references.
