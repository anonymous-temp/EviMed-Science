RSI lab lanes. A batch is one commit that edits config.json on this branch:

  mode          "lanes" (start lane jobs), "reupload" (copy the CI image artifact again), "probe" (runner facts), "idle"
  batch         a short label, part of every lane id (b003-base-1)
  sourceRef     the branch of the repository whose OpenScience tree supplies the Compose files, scripts and bench driver
  labFrom       "branch" (the copy under .rsi-lab/lab) or "source" (OpenScience/evals/harness-adaptation/lab at sourceRef)
  imageRunId / imageArtifact   where the release images are downloaded from (this repository's own artifact)
  idleExitMin   a lane that has been given nothing for this long ends
  arms          [{"key": image key, "jobs": 1..8 in all, "workers": concurrent items per job, "patch": ref or null}]
                an arm with a patch ref builds a candidate runtime image from it (Dockerfile.delta) and claims requests of its key

Requests, results and the broker are on the lab host; see OpenScience/evals/harness-adaptation/lab/brokerctl.py.
