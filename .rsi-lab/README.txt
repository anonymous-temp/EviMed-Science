RSI lab lanes. A batch is one commit that edits config.json on this branch (mode "idle" starts nothing):

  mode          "lanes" (start lane jobs), "reupload" (copy the CI image artifact again), "probe" (runner facts), "idle"
  batch         a short label, part of every lane id (b013-base-1)
  sourceRef     the branch of the repository whose OpenScience tree supplies the Compose files, scripts and bench driver
  labFrom       "branch" (the copy under .rsi-lab/lab) or "source" (OpenScience/evals/harness-adaptation/lab at sourceRef)
  imageRunId / imageArtifact   where the release images are downloaded from (this repository's own artifact copy, 30 days)
  idleExitMin   a lane that has been given nothing for this long ends
  sandboxCheck  true: run deploy/runtime-dsh/check-tool-sandbox.sh and print the Landlock ABI before taking requests
  promptMarkers ["text", ...]: capture the runtime-to-gateway traffic and print how often each text occurs (a guidance change reached a live session)
  arms          [{"key": image key, "jobs": 1..8 in all, "workers": concurrent items per job, "patch": ref or null}]
                an arm with a patch ref builds a candidate runtime image from it (Dockerfile.delta, about 10 minutes, swap on for the build)
                and claims requests whose "image" is its key; an arm without one runs the base images

Requests, results and the broker are on the lab host; see OpenScience/evals/harness-adaptation/lab/brokerctl.py.
