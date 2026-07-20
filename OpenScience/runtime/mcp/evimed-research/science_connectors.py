#!/usr/bin/env python3
"""Seven first-party science connector MCP bridges for desktop and hosted runtimes."""

from __future__ import annotations

import json
import math
import os
import re
import sys
from urllib.parse import urlencode

import public_sources


CONNECTORS = {
    "paper-search": {
        "tool": "search_papers",
        "description": "Search scholarly records through Crossref.",
        "schema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, "required": ["query"], "additionalProperties": False},
    },
    "biomcp": {
        "tool": "search_biomedical_records",
        "description": "Search PubMed, clinical-trial, or ClinVar records.",
        "schema": {"type": "object", "properties": {"query": {"type": "string"}, "database": {"type": "string", "enum": ["pubmed", "clinicaltrials", "clinvar"]}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, "required": ["query"], "additionalProperties": False},
    },
    "materials-project": {
        "tool": "search_materials",
        "description": "Retrieve a Materials Project summary by material id or formula.",
        "schema": {"type": "object", "properties": {"material_id": {"type": "string"}, "formula": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, "additionalProperties": False},
    },
    "fred": {
        "tool": "get_fred_series",
        "description": "Retrieve a public FRED economic time series by series id.",
        "schema": {"type": "object", "properties": {"series_id": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 1000}}, "required": ["series_id"], "additionalProperties": False},
    },
    "spaceweather": {
        "tool": "get_space_weather_alerts",
        "description": "Retrieve current NOAA Space Weather Prediction Center alerts.",
        "schema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 100}}, "additionalProperties": False},
    },
    "open-meteo": {
        "tool": "get_weather",
        "description": "Retrieve current and forecast weather from Open-Meteo.",
        "schema": {"type": "object", "properties": {"latitude": {"type": "number", "minimum": -90, "maximum": 90}, "longitude": {"type": "number", "minimum": -180, "maximum": 180}, "forecast_days": {"type": "integer", "minimum": 1, "maximum": 16}}, "required": ["latitude", "longitude"], "additionalProperties": False},
    },
    "usgs-water": {
        "tool": "get_usgs_water_data",
        "description": "Retrieve recent USGS instantaneous water observations for a site.",
        "schema": {"type": "object", "properties": {"site": {"type": "string"}, "period": {"type": "string", "pattern": "^P[0-9]+D$"}}, "required": ["site"], "additionalProperties": False},
    },
}

MAX_REQUEST_LINE_BYTES = 64 * 1024
MAX_STRING_CHARS = 512


def bounded_int(value, default, maximum):
    try:
        return max(1, min(maximum, int(value)))
    except (TypeError, ValueError):
        return default


def validate_arguments(connector, arguments):
    if connector not in CONNECTORS or not isinstance(arguments, dict):
        raise ValueError("science_connector_arguments_invalid")
    schema = CONNECTORS[connector]["schema"]
    properties = schema.get("properties", {})
    unknown = set(arguments) - set(properties)
    if unknown:
        raise ValueError("science_connector_argument_unknown")
    for required in schema.get("required", []):
        if required not in arguments:
            raise ValueError("science_connector_argument_required")
    for name, value in arguments.items():
        field = properties[name]
        field_type = field.get("type")
        if field_type == "string":
            if not isinstance(value, str) or not value.strip() or len(value) > MAX_STRING_CHARS or "\0" in value:
                raise ValueError("science_connector_string_invalid")
            if "pattern" in field and re.fullmatch(field["pattern"], value) is None:
                raise ValueError("science_connector_string_pattern_invalid")
        elif field_type == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("science_connector_integer_invalid")
        elif field_type == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError("science_connector_number_invalid")
        else:
            raise ValueError("science_connector_schema_invalid")
        if "minimum" in field and value < field["minimum"]:
            raise ValueError("science_connector_value_below_minimum")
        if "maximum" in field and value > field["maximum"]:
            raise ValueError("science_connector_value_above_maximum")
        if "enum" in field and value not in field["enum"]:
            raise ValueError("science_connector_enum_invalid")
    return arguments


def direct_query(connector, arguments):
    arguments = validate_arguments(connector, arguments)
    limit = bounded_int(arguments.get("limit"), 10, 1000)
    if connector == "paper-search":
        url = "https://api.crossref.org/works?" + urlencode({"query": arguments["query"], "rows": min(limit, 20), "select": "DOI,title,author,published,URL,type"})
        return {"source": url, "data": public_sources._get_json_value(url)}
    if connector == "biomcp":
        database = arguments.get("database", "pubmed")
        if database not in {"pubmed", "clinicaltrials", "clinvar"}:
            raise ValueError("science_connector_database_invalid")
        if database == "clinicaltrials":
            url = "https://clinicaltrials.gov/api/v2/studies?" + urlencode({"query.term": arguments["query"], "pageSize": min(limit, 20), "format": "json"})
            data = public_sources._get_json_value(url)
        else:
            params = public_sources._ncbi_params({"db": database, "retmode": "json", "retmax": min(limit, 20), "term": arguments["query"]})
            url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?" + urlencode(params)
            data = public_sources._ncbi_get_json(url)
        return {"source": url, "data": data}
    if connector == "materials-project":
        params = {"_limit": min(limit, 20)}
        if arguments.get("material_id"):
            params["material_ids"] = arguments["material_id"]
        elif arguments.get("formula"):
            params["formula"] = arguments["formula"]
        else:
            raise ValueError("science_connector_query_invalid")
        url = "https://api.materialsproject.org/materials/summary/?" + urlencode(params)
        return {"source": url, "data": public_sources._get_json_value(url)}
    if connector == "fred":
        series = str(arguments["series_id"]).upper()
        if not series.replace("_", "").isalnum() or len(series) > 64:
            raise ValueError("science_connector_series_invalid")
        url = "https://fred.stlouisfed.org/graph/fredgraph.csv?" + urlencode({"id": series})
        lines = public_sources._get_text(url, ("text/csv", "text/plain")).splitlines()
        return {"source": url, "data": lines[: limit + 1]}
    if connector == "spaceweather":
        url = "https://services.swpc.noaa.gov/products/alerts.json"
        return {"source": url, "data": public_sources._get_json_value(url)[: min(limit, 100)]}
    if connector == "open-meteo":
        url = "https://api.open-meteo.com/v1/forecast?" + urlencode({"latitude": arguments["latitude"], "longitude": arguments["longitude"], "forecast_days": bounded_int(arguments.get("forecast_days"), 7, 16), "current": "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m", "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum"})
        return {"source": url, "data": public_sources._get_json_value(url)}
    if connector == "usgs-water":
        site = str(arguments["site"])
        if not site.isdigit() or len(site) > 15:
            raise ValueError("science_connector_site_invalid")
        period = str(arguments.get("period", "P7D"))
        if not (period.startswith("P") and period.endswith("D") and period[1:-1].isdigit()):
            raise ValueError("science_connector_period_invalid")
        url = "https://waterservices.usgs.gov/nwis/iv/?" + urlencode({"format": "json", "sites": site, "period": period, "siteStatus": "all"})
        return {"source": url, "data": public_sources._get_json_value(url)}
    raise ValueError("science_connector_unknown")


def reply(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(request, connector):
    request_id = request.get("id")
    method = request.get("method")
    spec = CONNECTORS[connector]
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": f"evimed-science-{connector}", "version": "1.0.0"}}}
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": [{"name": spec["tool"], "description": spec["description"], "inputSchema": spec["schema"]}]}}
    if method == "tools/call":
        params = request.get("params") or {}
        if params.get("name") != spec["tool"] or not isinstance(params.get("arguments", {}), dict):
            raise ValueError("science_connector_tool_invalid")
        result = direct_query(connector, params.get("arguments", {}))
        return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": False}}
    if request_id is None:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}


def main():
    connector = os.environ.get("OPEN_SCIENCE_CONNECTOR_ID", "").strip()
    if connector not in CONNECTORS:
        raise SystemExit("OPEN_SCIENCE_CONNECTOR_ID is invalid")
    for line in sys.stdin:
        try:
            if len(line.encode("utf-8")) > MAX_REQUEST_LINE_BYTES:
                raise ValueError("science_connector_request_too_large")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("science_connector_request_invalid")
            response = handle(request, connector)
            if response is not None:
                reply(response)
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError, public_sources.PublicSourceError) as error:
            reply({"jsonrpc": "2.0", "id": request.get("id") if isinstance(locals().get("request"), dict) else None, "error": {"code": -32000, "message": str(error)[:500]}})


if __name__ == "__main__":
    main()
