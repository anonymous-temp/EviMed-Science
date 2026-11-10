#!/usr/bin/env python3
"""The serving host's deployment records of a directory deployment (rsi-lab-install.sh production; standard library only).

usage: rsi-online-records.py <online-dir> <lab-facts.json> <consumer-digest>

<online-dir> is the host directory the web container sees read-only at /run/evimed-rsi. The files are public identities and references and hold no credential; the server reads
them only as private records (mode 0600, no link), and the web container runs as root. Each is replaced by a rename, so a reader sees one whole file or the other.

The registry's digest is part of an admitted campaign's identity, so a registry that changes stops the campaign holding the surface: a run that changes nothing writes nothing,
and one that changes something moves the version.
"""
import json
import os
import sys

MOUNT = "/run/evimed-rsi"
SURFACE = "frontier-selection"
# The registered exposure of deploy/web/rsi-evaluator-registry.example.json: a qualified candidate serves nobody until its shadow has run on the real rounds, and then every round.
# These are exposure limits, never a claim of benefit (rsiCampaignFuse); any critical witness stops it whatever the counts. The volume bound is the domain's RSI_FRONTIER_VOLUME_BOUND, the rule the
# development choice already applied (a test holds the numbers equal): past 50 picks read from the stage's days, the candidate's line stays within 0.5 to 1.1 times the incumbent's or the campaign stops. Publishing runs in 500 to 700 distinct
# minutes a day (production, 2026-11-05), so 200 executions is under a day and minDays is what binds. A campaign that clears the global stage too is promoted (rsiCampaignImporter.observe).
ACTIVATION = {"mode": "shadow", "afterShadow": "global", "allowGlobal": True, "allowExpansion": True, "minExecutions": 200, "minDays": 2, "maxErrors": 0,
              "volumeBound": {"max": 1.1, "min": 0.5, "minPicks": 50}}


def write(path, value):
    temporary = f"{path}.tmp"
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=1, sort_keys=True)
        handle.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def main(online_dir, facts_path, consumer):
    with open(facts_path, encoding="utf-8") as handle:
        facts = json.load(handle)
    publisher, evaluator, procedures = facts["publisher"], facts["evaluator"], facts["procedureDigests"]
    if len(consumer) != 64 or not procedures or publisher["keyId"] == evaluator["keyId"] or publisher["publicKey"] == evaluator["publicKey"]:
        raise SystemExit("the lab's facts or the consumer digest are not usable")
    write(os.path.join(online_dir, "publisher.json"), {"keyId": publisher["keyId"], "publicKey": publisher["publicKey"], "surfaces": [SURFACE], "kinds": ["policy"]})
    registry = {"schemaVersion": 1, "evaluators": [{"keyId": evaluator["keyId"], "publicKey": evaluator["publicKey"], "surfaces": [SURFACE], "procedureDigests": procedures, "consumerDigests": [consumer]}],
                "activationPolicies": {SURFACE: ACTIVATION}}
    path = os.path.join(online_dir, "evaluators.json")
    try:
        with open(path, encoding="utf-8") as handle:
            current = json.load(handle)
    except FileNotFoundError:
        current = {}
    version = current.get("version", 0)
    if {key: value for key, value in current.items() if key != "version"} != registry:
        write(path, {**registry, "version": version + 1})
    write(os.path.join(online_dir, "online.json"), {"schemaVersion": 1, "transport": {"kind": "directory", "role": "production", "path": f"{MOUNT}/bundles"},
                                                    "trustedKeyRefs": [f"{MOUNT}/publisher.json"], "evaluatorRegistryRef": f"{MOUNT}/evaluators.json"})


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
