"""Read-only catalog for the EviMed biomedical data-source registry."""

import json
import os


CATALOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "source_catalog.json")
MAX_CATALOG_BYTES = 1024 * 1024
CONNECTION_STATE = {
    "active_tool": "connected_public",
    "active_skill": "skill_guidance",
    "catalogued": "catalog_only",
}
BUNDLED_DATASET_CONNECTORS = {"sider"}


def _classified(item):
    value = dict(item)
    catalog_status = value.get("status", "unknown")
    value["catalogStatus"] = catalog_status
    value["connectionState"] = CONNECTION_STATE.get(catalog_status, catalog_status)
    value["status"] = value["connectionState"]
    if value["connectionState"] == "connected_public":
        validation = dict(value.get("validation") or {})
        if value.get("connector") in BUNDLED_DATASET_CONNECTORS:
            validation["productionRoute"] = "bundled_verified_dataset"
            validation["deploymentRequirement"] = (
                "Production ships the pinned, licensed, read-only dataset index; release verification checks its receipt."
            )
        else:
            validation["productionRoute"] = "server_allowlisted_gateway"
            validation["deploymentRequirement"] = (
                "Production uses the authenticated EviMed server gateway with an official-host allowlist; "
                "the OpenCode runtime itself keeps arbitrary network egress disabled."
            )
        value["validation"] = validation
    return value


def _load():
    descriptor = os.open(CATALOG_FILE, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_size <= 0 or metadata.st_size > MAX_CATALOG_BYTES:
            raise ValueError("data-source catalog has an invalid size")
        raw = os.read(descriptor, MAX_CATALOG_BYTES + 1)
    finally:
        os.close(descriptor)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("data-source catalog has an unsupported schema")
    sources = value.get("sources")
    if not isinstance(sources, list) or not all(isinstance(item, dict) for item in sources):
        raise ValueError("data-source catalog sources are invalid")
    return value


def sources():
    return [_classified(item) for item in _load()["sources"]]


def active_connector_ids():
    return tuple(sorted(
        item["id"]
        for item in sources()
        if item.get("connectionState") == "connected_public" and isinstance(item.get("id"), str)
    ))


def counts():
    result = {}
    for item in sources():
        status = str(item.get("connectionState") or "unknown")
        result[status] = result.get(status, 0) + 1
    return dict(sorted(result.items()))


def connection_counts():
    result = {}
    for item in sources():
        state = item["connectionState"]
        result[state] = result.get(state, 0) + 1
    return dict(sorted(result.items()))


def integration_summary():
    states = connection_counts()
    connected = states.get("connected_public", 0)
    skill_guidance = states.get("skill_guidance", 0)
    total = len(sources())
    return {
        "reviewedTotal": total,
        "connectedPublic": connected,
        "skillGuidanceOnly": skill_guidance,
        "notConnected": total - connected - skill_guidance,
        "connectionStateCounts": states,
        "productionConnectorRoute": "controlled_connector_routes",
        "productionConnectorRoutes": ["bundled_verified_dataset", "server_allowlisted_gateway"],
        "runtimeArbitraryEgress": False,
    }


def search(arguments):
    query = str(arguments.get("query") or "").strip().casefold()
    domain = str(arguments.get("domain") or "").strip().casefold()
    status = str(arguments.get("status") or "").strip()
    access_class = str(arguments.get("accessClass") or "").strip()
    limit = int(arguments.get("limit") or 50)
    matched = []
    for item in sources():
        haystack = " ".join(str(item.get(key) or "") for key in (
            "id", "name", "domain", "priority", "connector", "skill", "credential", "license", "blocker"
        )).casefold()
        if query and query not in haystack:
            continue
        if domain and domain not in str(item.get("domain") or "").casefold():
            continue
        if status and item.get("connectionState") != status:
            continue
        if access_class and item.get("accessClass") != access_class:
            continue
        matched.append(item)
        if len(matched) >= limit:
            break
    return {
        "items": matched,
        "matched": len(matched),
        "catalogTotal": len(sources()),
        "integrationSummary": integration_summary(),
        "generatedAt": _load().get("generatedAt"),
    }
