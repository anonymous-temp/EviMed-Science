"""Assets built by the domain itself.

The checks read an asset the control plane stores, and the control plane builds it with
`applySemanticsPatch` in `@evimed/domain`. A test that wrote the asset by hand would agree with
this module and could disagree with the one that stores it; so the asset a test reads is the one
the domain builds, by running the domain (the same arrangement `test_vcr_platform.py` makes for
the job kinds).
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess

OPEN_SCIENCE = pathlib.Path(__file__).resolve().parents[4]
SCRIPT = """
import('@evimed/domain').then(async (m) => {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const { patches, now } = JSON.parse(input)
  let asset = null
  const outcomes = []
  const issues = []
  for (const patch of patches) {
    const result = m.applySemanticsPatch(asset, patch, { now, via: patch.__via ?? 'conversation' })
    asset = result.asset
    outcomes.push(...result.outcomes)
    issues.push(...result.issues)
  }
  console.log(JSON.stringify({ asset, outcomes, issues, interpretation: m.interpretationOf(asset) }))
})
"""


def build(patches, now="2026-10-04T08:00:00.000Z"):
    """{asset, outcomes, issues} after applying each patch in turn, through the domain."""
    node = shutil.which("node")
    assert node, "node must be installed: the asset a check reads is the one the domain builds"
    out = subprocess.run([node, "--input-type=module", "-e", SCRIPT], input=json.dumps({"patches": patches, "now": now}),
                         cwd=OPEN_SCIENCE / "apps" / "server", capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)


def domain_exports(*names):
    """The named exports of the domain, as JSON."""
    node = shutil.which("node")
    assert node, "node must be installed: the tool's copies of the vocabulary are held to the domain's"
    script = "import('@evimed/domain').then((m) => console.log(JSON.stringify([%s].map((n) => m[n]))))" % ",".join(json.dumps(n) for n in names)
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=OPEN_SCIENCE / "apps" / "server", capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout)
