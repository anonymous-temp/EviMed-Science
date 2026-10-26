# Preserved citation observation declarations

The selected GEO source history can distinguish an observed absence from an
unobservable interval only when the original collection records its citation
surface explicitly. Snapshot `surface` retains this optional declaration:

```json
{
  "citationObservation": {
    "schemaVersion": 1,
    "capability": "linked_list",
    "complete": true
  }
}
```

This is a collector declaration about the linked citation list captured for
that exact answer. It is not proof of every source the model knows or of the
whole web. An adapter may supply it only when the provider's documented
citation surface was fully captured and associated with the actual request and
answer. Preserve the original surface with the snapshot; do not derive this
declaration from a successful job, a valid answer, an empty citation array,
retrieval being enabled, or a later interpretation of the answer text.

Missing, unsupported or incomplete declarations remain unknown. Existing
snapshots must not be backfilled as complete without their original collection
evidence. Failed/refused or linkless-only collection does not establish absence.

An appearance or disappearance is reported only within a comparable recorded
question/version/platform/sampling cohort. A changed cohort or unobserved
interval stays explicitly unknown or incomparable. “First observed” means
within the selected scope, not the date the source first existed. UI,
drilldowns, frozen conversation inputs and exports retain the same declaration
and cohort basis; no history read initiates fresh collection or publication.

The existing external consumer-AI collector is deferred for this release task.
This contract does not claim that it currently emits the declaration or that
its availability has been validated. Its later integration must verify the
actual response-to-snapshot path and negative cases before emitting `complete`.
