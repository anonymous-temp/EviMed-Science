"""Traceable public research connectors used when no private EviMed adapter is configured."""

import gzip
import io
import json
import math
import os
import re
import sqlite3
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone


MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_GATEWAY_CONFIG_BYTES = 1024 * 1024
EVIMED_EVIDENCE_BASE_URL = "https://www.evimed.com/api-evimed/medicine-api/ai-api"
_OPENFDA_CASE_BATCH_SIZE = 5
_OPENFDA_PUBLIC_CASE_LIMIT = 25


class PublicSourceError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirectHandler())
_NCBI_RATE_LOCK = threading.Lock()
_NCBI_LAST_REQUEST = 0.0


def enabled():
    return os.environ.get("EVIMED_PUBLIC_CONNECTORS_ENABLED", "true").strip().casefold() not in {
        "0", "false", "no", "off"
    }


def supports(name):
    return name in {
        "evimed_literature_search",
        "evimed_guideline_search",
        "evimed_clinical_trial_search",
        "evimed_patent_search",
        "evimed_pharmacy_reference_search",
        "evimed_drug_label_search",
        "evimed_adr_case_query",
        "evimed_adr_signal_analysis",
        "evimed_offlabel_evidence_packet",
        "evimed_comprehensive_drug_evaluation",
        "evimed_drug_selection_evaluation",
        "evimed_biomedical_source_search",
    }


def configured(name):
    if not supports(name):
        return False
    if name != "evimed_pharmacy_reference_search":
        return True
    try:
        _pharmacy_reference_file()
        return True
    except PublicSourceError:
        return False


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _base(env_name, fallback):
    value = os.environ.get(env_name, fallback).strip().rstrip("/")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        raise PublicSourceError("public_source_url_invalid", "%s is not a valid HTTP(S) base URL." % env_name)
    return value


def _timeout():
    try:
        return min(max(float(os.environ.get("EVIMED_PUBLIC_SOURCE_TIMEOUT_SECONDS", "20")), 1), 60)
    except ValueError:
        return 20


def _gateway_settings():
    gateway_url = os.environ.get("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", "").strip()
    if not gateway_url:
        return None
    parsed = urllib.parse.urlsplit(gateway_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        raise PublicSourceError("public_source_gateway_invalid", "The managed public-source gateway URL is invalid.")
    config_file = os.environ.get("EVIMED_MODEL_CONFIG_FILE", "").strip()
    if not config_file or not os.path.isabs(config_file) or "\0" in config_file:
        raise PublicSourceError("public_source_gateway_unconfigured", "The managed public-source gateway token is unavailable.")
    descriptor = None
    try:
        descriptor = os.open(config_file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        if metadata.st_size <= 0 or metadata.st_size > MAX_GATEWAY_CONFIG_BYTES:
            raise ValueError("invalid model configuration size")
        config = json.loads(os.read(descriptor, MAX_GATEWAY_CONFIG_BYTES + 1).decode("utf-8"))
        provider = config.get("provider", {}).get("deepseek", {})
        token = provider.get("options", {}).get("apiKey", "") if isinstance(provider, dict) else ""
        if not isinstance(token, str) or not token or len(token) > 8 * 1024 or any(character.isspace() for character in token):
            raise ValueError("invalid runtime gateway token")
        return gateway_url, token
    except PublicSourceError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise PublicSourceError(
            "public_source_gateway_unconfigured",
            "The managed public-source gateway token is unavailable.",
        ) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _direct_credential(credential_profile):
    env_name = {
        "evimed-evidence": "EVIMED_EVIDENCE_SEARCH_KEY_FILE",
    }.get(credential_profile)
    if not env_name:
        return None
    configured = os.environ.get(env_name, "").strip()
    if not configured or not os.path.isabs(configured) or "\0" in configured:
        return None
    descriptor = None
    try:
        descriptor = os.open(configured, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > 8 * 1024:
            raise ValueError("invalid credential file")
        if metadata.st_mode & 0o077:
            raise ValueError("credential file permissions are too broad")
        value = os.read(descriptor, metadata.st_size + 1).decode("utf-8").strip()
        if not value or len(value) > 8 * 1024 or any(character.isspace() for character in value):
            raise ValueError("invalid credential value")
        return value
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise PublicSourceError(
            "public_source_managed_credential_invalid",
            "The file-backed EviMed evidence credential is unavailable or unsafe.",
        ) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _open_remote(url, accepted, method="GET", json_body=None, timeout_seconds=None, credential_profile=None):
    gateway = _gateway_settings()
    if gateway is None:
        direct_credential = _direct_credential(credential_profile) if credential_profile else None
        if credential_profile and not direct_credential:
            raise PublicSourceError(
                "public_source_managed_credential_required",
                "This connector requires the EviMed server gateway to inject a managed credential.",
            )
        encoded_body = json.dumps(json_body).encode("utf-8") if method == "POST" else None
        request = urllib.request.Request(
            url,
            data=encoded_body,
            headers={
                "accept": ", ".join(accepted),
                **({"content-type": "application/json"} if encoded_body is not None else {}),
                **({"authorization": "Bearer %s" % direct_credential} if direct_credential else {}),
                "user-agent": "EviMed-Research/1.2 (research connector)",
            },
            method=method,
        )
    else:
        gateway_url, token = gateway
        payload_value = {"url": url, "accept": list(accepted)}
        if credential_profile:
            payload_value["credentialProfile"] = credential_profile
        if method == "POST":
            payload_value.update({"method": "POST", "body": json_body})
        payload = json.dumps(payload_value).encode("utf-8")
        request = urllib.request.Request(
            gateway_url,
            data=payload,
            headers={
                "accept": ", ".join(accepted),
                "authorization": "Bearer %s" % token,
                "content-type": "application/json",
                "user-agent": "EviMed-Research/1.2 (runtime connector)",
            },
            method="POST",
        )
    timeout = _timeout() if timeout_seconds is None else min(max(float(timeout_seconds), 1), 60)
    return _OPENER.open(request, timeout=timeout)


def _get_json_value(
    url, allow_not_found=False, accepted=("application/json", "text/json"), method="GET", json_body=None,
    credential_profile=None, strict_json=True,
):
    try:
        with _open_remote(
            url, accepted, method=method, json_body=json_body, credential_profile=credential_profile,
        ) as response:
            content_type = response.headers.get_content_type()
            if content_type not in accepted:
                raise PublicSourceError(
                    "public_source_invalid_response",
                    "Public source returned content type %s." % content_type,
                )
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise PublicSourceError("public_source_response_too_large", "Public source response exceeded 4 MiB.")
            value = json.loads(raw.decode("utf-8"), strict=strict_json)
            return value
    except urllib.error.HTTPError as error:
        if allow_not_found and error.code == 404:
            return {"results": [], "meta": {"results": {"total": 0}}}
        raise PublicSourceError(
            "public_source_http_error",
            "Public source returned HTTP %d." % error.code,
            error.code == 429 or error.code >= 500,
        )
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise PublicSourceError(
            "public_source_unavailable",
            "Public source is unavailable: %s." % getattr(error, "reason", error),
            True,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublicSourceError("public_source_invalid_response", "Public source returned invalid JSON: %s." % error)


def _get_json(
    url, allow_not_found=False, accepted=("application/json", "text/json"), method="GET", json_body=None,
    credential_profile=None, strict_json=True,
):
    value = _get_json_value(
        url, allow_not_found=allow_not_found, accepted=accepted, method=method, json_body=json_body,
        credential_profile=credential_profile, strict_json=strict_json,
    )
    if not isinstance(value, dict):
        raise PublicSourceError("public_source_invalid_response", "Public source returned non-object JSON.")
    return value


def _retry_json_value(url, attempts=3, accepted=("application/json", "text/json")):
    for attempt in range(attempts):
        try:
            return _get_json_value(url, accepted=accepted)
        except PublicSourceError as error:
            if not error.retryable or attempt + 1 >= attempts:
                raise
            time.sleep(1 << attempt)


def _get_text(url, accepted=("application/atom+xml", "application/xml", "text/xml", "text/plain")):
    try:
        with _open_remote(url, accepted) as response:
            content_type = response.headers.get_content_type()
            if content_type not in accepted:
                raise PublicSourceError(
                    "public_source_invalid_response",
                    "Public source returned content type %s." % content_type,
                )
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise PublicSourceError("public_source_response_too_large", "Public source response exceeded 4 MiB.")
            return raw.decode("utf-8")
    except urllib.error.HTTPError as error:
        raise PublicSourceError(
            "public_source_http_error", "Public source returned HTTP %d." % error.code,
            error.code == 429 or error.code >= 500,
        )
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise PublicSourceError(
            "public_source_unavailable", "Public source is unavailable: %s." % getattr(error, "reason", error), True,
        )
    except UnicodeDecodeError as error:
        raise PublicSourceError("public_source_invalid_response", "Public source returned invalid text: %s." % error)


def _get_gzip_json(url):
    try:
        with _open_remote(url, ("application/gzip",)) as response:
            if response.headers.get_content_type() != "application/gzip":
                raise PublicSourceError("public_source_invalid_response", "Public source returned a non-gzip response.")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise PublicSourceError("public_source_response_too_large", "Public source response exceeded 4 MiB.")
            with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as compressed:
                decoded = compressed.read(MAX_RESPONSE_BYTES + 1)
            if len(decoded) > MAX_RESPONSE_BYTES:
                raise PublicSourceError("public_source_response_too_large", "Expanded public source response exceeded 4 MiB.")
            value = json.loads(decoded.decode("utf-8"))
            if not isinstance(value, (dict, list)):
                raise PublicSourceError("public_source_invalid_response", "Public source returned an unsupported JSON value.")
            return value
    except urllib.error.HTTPError as error:
        raise PublicSourceError(
            "public_source_http_error", "Public source returned HTTP %d." % error.code,
            error.code == 429 or error.code >= 500,
        )
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise PublicSourceError(
            "public_source_unavailable", "Public source is unavailable: %s." % getattr(error, "reason", error), True,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, gzip.BadGzipFile) as error:
        raise PublicSourceError("public_source_invalid_response", "Public source returned invalid gzip JSON: %s." % error)


def _url(base, path, params):
    return "%s/%s?%s" % (base, path.lstrip("/"), urllib.parse.urlencode(params, doseq=True))


def _ncbi_params(params):
    output = {**params, "tool": "evimed_research"}
    email = os.environ.get("NCBI_EMAIL", "").strip()
    api_key = os.environ.get("NCBI_API_KEY", "").strip()
    if email:
        output["email"] = email
    if api_key:
        output["api_key"] = api_key
    return output


def _ncbi_get_json(url):
    global _NCBI_LAST_REQUEST
    hostname = (urllib.parse.urlsplit(url).hostname or "").casefold()
    if hostname != "eutils.ncbi.nlm.nih.gov":
        return _get_json(url)
    minimum_interval = 0.11 if os.environ.get("NCBI_API_KEY", "").strip() else 0.34
    for attempt in range(3):
        with _NCBI_RATE_LOCK:
            wait = minimum_interval - (time.monotonic() - _NCBI_LAST_REQUEST)
            if wait > 0:
                time.sleep(wait)
            _NCBI_LAST_REQUEST = time.monotonic()
        try:
            # Some NCBI ESummary databases emit literal control characters
            # inside JSON string values. Limit tolerant parsing to the verified
            # NCBI host; all other connectors retain strict RFC JSON parsing.
            return _get_json(url, strict_json=False)
        except PublicSourceError as error:
            if not error.retryable or attempt == 2:
                raise
            time.sleep(1 << attempt)


def _source(source_id, title, url, source):
    value = {
        "id": str(source_id),
        "url": url,
        "source": source,
        "retrievedAt": _now(),
    }
    if title:
        value["title"] = str(title)[:2048]
    return value


def _bounded_text_list(value, limit=1, max_chars=1500):
    if not isinstance(value, list):
        return []
    output = []
    for item in value[:limit]:
        if isinstance(item, str) and item.strip():
            output.append(item.strip()[:max_chars])
    return output


def _text_list_truncated(value, limit=1, max_chars=1500):
    if not isinstance(value, list):
        return False
    text = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return len(text) > limit or any(len(item) > max_chars for item in text[:limit])


def _pubmed(query, limit, date_from=None, date_to=None, source_name="pubmed"):
    base = _base("EVIMED_PUBMED_BASE_URL", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils")
    term = query.strip()
    if date_from or date_to:
        start = date_from or "1900-01-01"
        end = date_to or datetime.now(timezone.utc).date().isoformat()
        term = '(%s) AND ("%s"[Date - Publication] : "%s"[Date - Publication])' % (term, start, end)
    search_url = _url(base, "esearch.fcgi", _ncbi_params({
        "db": "pubmed", "term": term, "retmax": limit, "retmode": "json", "sort": "relevance"
    }))
    found = _ncbi_get_json(search_url)
    ids = found.get("esearchresult", {}).get("idlist", [])
    if not isinstance(ids, list) or not ids:
        return {"summary": "PubMed returned no matching records.", "data": {"items": []}, "sources": []}
    ids = [str(item) for item in ids[:limit] if str(item).strip()]
    summary_url = _url(base, "esummary.fcgi", _ncbi_params({"db": "pubmed", "id": ",".join(ids), "retmode": "json"}))
    details = _ncbi_get_json(summary_url).get("result", {})
    items = []
    sources = []
    for pmid in ids:
        record = details.get(pmid)
        if not isinstance(record, dict):
            continue
        title = str(record.get("title") or "Untitled PubMed record").strip()
        article_ids = record.get("articleids") if isinstance(record.get("articleids"), list) else []
        doi = next((str(item.get("value")) for item in article_ids if item.get("idtype") == "doi"), None)
        record_url = "https://pubmed.ncbi.nlm.nih.gov/%s/" % urllib.parse.quote(pmid)
        items.append({
            "id": "PMID:%s" % pmid,
            "pmid": pmid,
            "title": title,
            "journal": record.get("fulljournalname") or record.get("source"),
            "publicationDate": record.get("pubdate"),
            "authors": [item.get("name") for item in record.get("authors", []) if isinstance(item, dict) and item.get("name")],
            **({"doi": doi} if doi else {}),
            "url": record_url,
        })
        sources.append(_source("PMID:%s" % pmid, title, record_url, source_name))
    return {
        "summary": "Retrieved %d traceable PubMed records." % len(items),
        "data": {"items": items},
        "sources": sources,
    }


def _crossref(query, limit):
    base = _base("EVIMED_CROSSREF_BASE_URL", "https://api.crossref.org")
    url = _url(base, "works", {"query.bibliographic": query, "rows": limit, "select": "DOI,title,URL,published,author,type"})
    records = _get_json(url).get("message", {}).get("items", [])
    if not isinstance(records, list):
        records = []
    items = []
    sources = []
    for record in records[:limit]:
        if not isinstance(record, dict):
            continue
        title_value = record.get("title")
        title = title_value[0] if isinstance(title_value, list) and title_value else "Untitled Crossref record"
        doi = str(record.get("DOI") or "").strip()
        record_url = str(record.get("URL") or ("https://doi.org/%s" % doi if doi else url))
        item_id = "DOI:%s" % doi if doi else record_url
        items.append({"id": item_id, "doi": doi or None, "title": title, "url": record_url, "type": record.get("type")})
        sources.append(_source(item_id, title, record_url, "crossref"))
    return {"summary": "Retrieved %d traceable Crossref records." % len(items), "data": {"items": items}, "sources": sources}


def _evimed_post(path, body):
    url = "%s/%s" % (EVIMED_EVIDENCE_BASE_URL, path.lstrip("/"))
    payload = _get_json(
        url,
        method="POST",
        json_body=body,
        credential_profile="evimed-evidence",
    )
    if payload.get("code") != 200 or not isinstance(payload.get("data"), dict):
        raise PublicSourceError(
            "evimed_evidence_invalid_response",
            "EviMed evidence search returned an unsuccessful response.",
            False,
        )
    return payload["data"], url


def _evimed_record_url(value, fallback):
    if isinstance(value, dict):
        for key in ("Pubmed", "pubmed", "evimed", "Semantic Scholar", "Google Scholar", "url"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
        return next((str(item).strip() for item in value.values() if str(item).strip()), fallback)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError:
            return text
        return _evimed_record_url(decoded, fallback)
    return fallback


_RELEVANCE_STOPWORDS = {
    "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
    "analysis", "clinical", "disease", "disorder", "evidence", "patient", "patients",
    "research", "study", "syndrome", "treatment",
}


def _normalized_relevance_text(value):
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return " ".join(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", text.casefold()))


def _concept_is_present(record_text, concept):
    normalized = _normalized_relevance_text(concept)
    if not normalized:
        return True
    if (
        normalized in record_text
        if re.search(r"[\u4e00-\u9fff]", normalized)
        else bool(re.search(r"(?:^| )%s(?: |$)" % re.escape(normalized), record_text))
    ):
        return True
    terms = [
        term for term in normalized.split()
        if term not in _RELEVANCE_STOPWORDS and (len(term) >= 2 or term.isdigit())
    ]
    if not terms:
        return False
    if all(term.isascii() and term.isalpha() for term in terms) and len(terms) >= 2:
        acronym = "".join(term[0] for term in terms)
        if re.search(r"(?:^| )%s(?: |$)" % re.escape(acronym), record_text):
            return True
    matches = sum(
        bool(re.search(r"(?:^| )%s(?: |$)" % re.escape(term), record_text))
        if term.isascii() else term in record_text
        for term in terms
    )
    required = 1 if len(terms) == 1 else math.ceil(len(terms) * 0.6)
    return matches >= required


def _filter_evimed_records(records, required_concepts):
    concepts = [
        value.strip() for value in required_concepts or []
        if isinstance(value, str) and value.strip()
    ]
    if not concepts:
        return records, 0
    kept = []
    for record in records:
        record_text = _normalized_relevance_text(record)
        if all(_concept_is_present(record_text, concept) for concept in concepts):
            kept.append(record)
    return kept, len(records) - len(kept)


def _filter_evimed_title_records(records, required_concepts):
    concepts = [
        value.strip() for value in required_concepts or []
        if isinstance(value, str) and value.strip()
    ]
    if not concepts:
        return records, 0
    kept = [
        record for record in records
        if all(
            _concept_is_present(_normalized_relevance_text(_dict(record).get("title", "")), concept)
            for concept in concepts
        )
    ]
    return kept, len(records) - len(kept)


def _filter_trial_records(records, required_concepts):
    concepts = [
        value.strip() for value in required_concepts or []
        if isinstance(value, str) and value.strip()
    ]
    if not concepts:
        return records, 0
    drug, indications = concepts[0], concepts[1:]
    kept = []
    for value in records:
        record = _dict(value)
        drug_text = _normalized_relevance_text({
            "title": record.get("title"),
            "interventions": record.get("interventions"),
        })
        indication_text = _normalized_relevance_text({
            "title": record.get("title"),
            "conditions": record.get("conditions"),
        })
        if _concept_is_present(drug_text, drug) and all(
            _concept_is_present(indication_text, concept) for concept in indications
        ):
            kept.append(value)
    return kept, len(records) - len(kept)


def _evimed_candidate_limit(arguments, limit):
    constrained = arguments.get("requiredConcepts") or arguments.get("requiredTitleConcepts")
    return min(max(limit * 5, limit), 100) if constrained else limit


def _filter_bibliographic_title_result(result, required_concepts):
    items = result.get("data", {}).get("items", [])
    filtered, filtered_count = _filter_evimed_title_records(items, required_concepts)
    if not filtered_count:
        return result
    identifiers = {str(item.get("id")) for item in filtered if isinstance(item, dict)}
    result["data"]["items"] = filtered
    result["sources"] = [
        source for source in result.get("sources", [])
        if str(source.get("id")) in identifiers
    ]
    result.setdefault("warnings", []).append(
        "Excluded %d bibliographic candidates whose titles did not identify the required medicine."
        % filtered_count
    )
    return result


def _evimed_evidence_records(query, limit):
    data, endpoint = _evimed_post("search/api/evidence", {"query": query[:512]})
    records = _list(data.get("paper"))
    items, sources = [], []
    for index, value in enumerate(records[:limit]):
        record = _dict(value)
        title = _first_text(record.get("title"), record.get("literatureTitle"))
        identifier = str(record.get("id") or record.get("paperId") or record.get("pmid") or record.get("doi") or index).strip()
        record_url = _evimed_record_url(record.get("url"), endpoint)
        item = {
            "id": "EVIMED-PAPER:%s" % identifier,
            "title": title,
            "url": record_url,
            "year": record.get("year"),
            "journal": record.get("journal"),
            "authors": record.get("authors") or record.get("author") or record.get("authorList"),
            "doi": record.get("doi"),
            "pmid": record.get("pmid"),
            "summary": str(record.get("summary") or record.get("answer") or "")[:4000],
            "sourceType": "paper",
        }
        items.append({key: value for key, value in item.items() if value not in (None, "", [])})
        sources.append(_source(item["id"], title, record_url, "evimed-evidence-paper"))
    return {
        "status": "warning",
        "summary": "Retrieved %d EviMed evidence records." % len(items),
        "data": {"items": items},
        "sources": sources,
        "warnings": [
            "EviMed search results are evidence candidates; verify the cited primary record before classifying study design, certainty, or outcomes."
        ],
        "next_actions": ["Open the cited primary record and extract only verified fields needed by the assessment."],
    }


def _evimed_literature_records(arguments):
    limit = min(arguments.get("limit", 10), 100)
    body = {"query": arguments["query"][:512], "count": _evimed_candidate_limit(arguments, limit)}
    field_map = {
        "articleTypes": "articleTypes",
        "hasPdf": "hasPdf",
        "language": "language",
        "minImpactFactor": "minImpactFactor",
        "maxImpactFactor": "maxImpactFactor",
        "journalTiers": "journalTiers",
    }
    for source_name, target_name in field_map.items():
        value = arguments.get(source_name)
        if value not in (None, "", []):
            body[target_name] = value
    for source_name, target_name in (("dateFrom", "startYear"), ("dateTo", "endYear")):
        value = arguments.get(source_name)
        if isinstance(value, str) and len(value) >= 4:
            body[target_name] = int(value[:4])
    data, endpoint = _evimed_post("review/api/literature", body)
    records, filtered_count = _filter_evimed_records(
        _list(data.get("list")), arguments.get("requiredConcepts")
    )
    records, title_filtered_count = _filter_evimed_title_records(
        records, arguments.get("requiredTitleConcepts")
    )
    items, sources = [], []
    for index, value in enumerate(records[:limit]):
        record = _dict(value)
        title = _first_text(record.get("title"))
        identifier = str(record.get("id") or index).strip()
        record_url = _evimed_record_url(record.get("url"), endpoint)
        item = {
            "id": "EVIMED-LITERATURE:%s" % identifier,
            "title": title,
            "url": record_url,
            "authors": record.get("authors"),
            "abstract": str(record.get("abstract") or "")[:12000],
            "journal": record.get("journal"),
            "year": record.get("year"),
            "impactFactor": record.get("impactFactor"),
            "studyType": record.get("studyType"),
            "language": record.get("language"),
            "aiSummary": str(record.get("aiSummary") or "")[:4000],
            "coreJournals": record.get("coreJournals"),
        }
        items.append({key: value for key, value in item.items() if value not in (None, "", [])})
        sources.append(_source(item["id"], title, record_url, "evimed-literature"))
    return {
        "status": "warning",
        "summary": "Retrieved %d traceable EviMed literature records." % len(items),
        "data": {"items": items, "total": data.get("total")},
        "sources": sources,
        "warnings": [
            "AI summaries and indexed metadata are discovery aids; verify material claims against the primary record.",
            *(["Excluded %d EviMed literature candidates that did not match every required concept." % filtered_count] if filtered_count else []),
            *(["Excluded %d additional literature candidates whose titles did not identify the required medicine." % title_filtered_count] if title_filtered_count else []),
        ],
        "next_actions": ["Open the primary record and verify the study design, population, outcomes, and effect estimates."],
    }


def _evimed_guidelines(arguments):
    mode = arguments.get("mode", "records")
    body = {"query": arguments["query"][:512]}
    if arguments.get("language"):
        body["language"] = arguments["language"]
    for name in ("startYear", "endYear"):
        if arguments.get(name) is not None:
            body[name] = arguments[name]
    publisher = arguments.get("publisher") or arguments.get("jurisdiction")
    if publisher:
        body["publisher" if mode == "blocks" else "publishers"] = publisher if mode == "blocks" else [publisher]
    if mode == "blocks":
        data, endpoint = _evimed_post("review/api/guide-block", body)
        records = _list(data.get("guides"))
        limit = min(arguments.get("limit", 10), 100)
    else:
        limit = min(arguments.get("limit", 10), 100)
        body["count"] = _evimed_candidate_limit(arguments, limit)
        data, endpoint = _evimed_post("review/api/guide", body)
        records = _list(data.get("list"))
    records, filtered_count = _filter_evimed_records(records, arguments.get("requiredConcepts"))
    items, sources = [], []
    for index, value in enumerate(records[:limit]):
        record = _dict(value)
        title = _first_text(record.get("title"))
        identifier = str(record.get("guideId") or record.get("id") or index).strip()
        record_url = _evimed_record_url(record.get("url"), endpoint)
        item = {
            "id": "EVIMED-GUIDE:%s" % identifier,
            "title": title,
            "url": record_url,
            "year": record.get("year"),
            "publisher": record.get("publisher") or record.get("formulator"),
            "summary": str(record.get("summary") or record.get("introduction") or "")[:4000],
            "jurisdiction": record.get("jurisdiction") or record.get("region") or record.get("country"),
            "language": record.get("language"),
            "publicationDate": record.get("publicationDate"),
            "blocks": _bounded_text_list(record.get("blocks"), limit=10, max_chars=4000),
            "rerankScore": record.get("rerankScore"),
            "rerankRank": record.get("rerankRank"),
        }
        items.append({key: value for key, value in item.items() if value not in (None, "", [])})
        sources.append(_source(item["id"], title, record_url, "evimed-guideline"))
    return {
        "status": "warning",
        "summary": "Retrieved %d traceable EviMed guideline candidates." % len(items),
        "data": {
            "items": items,
            "total": data.get("total"),
            "keywords": data.get("keywords") if mode == "blocks" else None,
            "enrichedQuery": data.get("enrichedQuery") if mode == "blocks" else None,
            "requestedJurisdiction": arguments.get("jurisdiction"),
        },
        "sources": sources,
        "warnings": [
            "Verify the guideline version, issuing body, jurisdiction, and original recommendation context before use.",
            *(["Excluded %d EviMed guideline candidates that did not match every required concept." % filtered_count] if filtered_count else []),
        ],
        "next_actions": ["Open the original guideline and verify the relevant recommendation text and version."],
    }


def _evimed_trial_records(arguments):
    limit = min(arguments.get("limit", 10), 100)
    body = {
        "query": arguments["query"][:512],
        "count": _evimed_candidate_limit(arguments, limit),
        "registry": arguments.get("registry", 1),
    }
    for name in ("startYear", "endYear", "status", "phase", "studyType", "hasArticles", "source", "minSampleSize", "maxSampleSize"):
        value = arguments.get(name)
        if value not in (None, "", []):
            body[name] = value
    if arguments.get("recruitmentStatus") and "status" not in body:
        body["status"] = [arguments["recruitmentStatus"]]
    data, endpoint = _evimed_post("review/api/clinical-trial", body)
    records, filtered_count = _filter_trial_records(
        _list(data.get("list")), arguments.get("requiredConcepts")
    )
    items, sources = [], []
    for index, value in enumerate(records[:limit]):
        record = _dict(value)
        title = _first_text(record.get("title"))
        identifier = str(record.get("registrationNo") or record.get("cochraneId") or index).strip()
        record_url = _first_text(record.get("url"), endpoint)
        item = {
            "id": identifier,
            "title": title,
            "url": record_url,
            "status": record.get("status"),
            "registrationDate": record.get("registrationDate"),
            "phase": record.get("phase"),
            "sampleSize": record.get("sampleSize"),
            "studyType": record.get("studyType") or record.get("publicationType"),
            "conditions": record.get("conditions"),
            "primarySponsor": record.get("primarySponsor"),
            "interventions": record.get("interventions"),
            "year": record.get("year"),
            "journal": record.get("journal"),
            "registry": body["registry"],
        }
        items.append({key: value for key, value in item.items() if value not in (None, "", [])})
        sources.append(_source(identifier, title, record_url, "evimed-clinical-trial"))
    result = {
        "summary": "Retrieved %d traceable EviMed trial records." % len(items),
        "data": {"items": items, "total": data.get("total"), "registry": body["registry"]},
        "sources": sources,
    }
    if filtered_count:
        result.update({
            "status": "warning",
            "warnings": [
                "Excluded %d EviMed trial candidates that did not match every required concept." % filtered_count
            ],
            "next_actions": ["Verify the current registry record and protocol before using trial fields in an assessment."],
        })
    return result


def patent(arguments):
    limit = min(arguments.get("limit", 10), 100)
    data, endpoint = _evimed_post("review/api/patent", {"query": arguments["query"][:512], "count": limit})
    items, sources = [], []
    for index, value in enumerate(_list(data.get("list"))[:limit]):
        record = _dict(value)
        title = _first_text(record.get("title"), record.get("patentNumber"))
        identifier = str(record.get("id") or record.get("patentNumber") or index).strip()
        record_url = _first_text(record.get("url"), endpoint)
        item = {
            "id": "EVIMED-PATENT:%s" % identifier,
            "title": title,
            "url": record_url,
            "patentNumber": record.get("patentNumber"),
            "patentType": record.get("patentType"),
            "abstract": str(record.get("patentAbstract") or "")[:12000],
            "patentee": record.get("patentee"),
            "designers": record.get("designer"),
            "applicationDate": record.get("applicationDate"),
            "announcementDate": record.get("announcementDate"),
            "source": record.get("source"),
            "claims": record.get("claims"),
        }
        items.append({key: value for key, value in item.items() if value not in (None, "", [])})
        sources.append(_source(item["id"], title, record_url, "evimed-patent"))
    return {
        "status": "warning",
        "summary": "Retrieved %d traceable EviMed patent records." % len(items),
        "data": {"items": items, "total": data.get("total")},
        "sources": sources,
        "warnings": ["Patent records describe claims and filings, not clinical efficacy, safety, approval, or freedom to operate."],
        "next_actions": ["Review the complete patent family and obtain qualified legal analysis before making an IP decision."],
    }


def _evimed_instruction_records(arguments):
    limit = min(arguments.get("limit", 3), 50)
    query = " ".join(
        value.strip()
        for value in (arguments["drug"], arguments.get("product", ""))
        if isinstance(value, str) and value.strip()
    )
    data, endpoint = _evimed_post(
        "review/api/instruction",
        {"query": query[:512], "count": limit},
    )
    registry_labels = {
        "nmpa": "China (NMPA)",
        "fda": "United States (FDA)",
        "ema": "European Union (EMA)",
        "pmda": "Japan (PMDA)",
    }
    requested = str(arguments.get("jurisdiction") or "").strip()
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", requested.casefold())
    aliases = {
        "nmpa": {"cn", "china", "chinanmpa", "nmpa", "中国", "中國"},
        "fda": {"us", "usa", "unitedstates", "unitedstatesfda", "fda", "美国", "美國"},
        "ema": {"eu", "europeanunion", "europeanunionema", "ema", "欧盟", "歐盟"},
        "pmda": {"jp", "japan", "japanpmda", "pmda", "日本"},
    }
    selected = [key for key, values in aliases.items() if normalized in values] if requested else list(registry_labels)
    if requested and not selected:
        selected = []
    items, sources = [], []
    field_map = {
        "tradeNames": "tradeNames",
        "genericNames": "genericNames",
        "englishName": "englishName",
        "indication": "indicationsAndUsage",
        "pharmacologyAndIndication": "pharmacologyAndIndication",
        "enterpriseName": "manufacturer",
        "specifications": "specifications",
        "revisionDate": "revisionDate",
        "approvalDates": "approvalDates",
        "boxedWarning": "boxedWarnings",
        "contraindications": "contraindications",
        "precautions": "precautions",
        "adverseReactions": "adverseReactions",
        "warningsMarks": "warnings",
        "drugInteractions": "drugInteractions",
        "useInPregLact": "pregnancyLactationUse",
        "useInChildren": "pediatricUse",
        "useInElderly": "elderlyUse",
        "storage": "storage",
    }
    for registry in selected:
        for index, value in enumerate(_list(data.get(registry))):
            if len(items) >= limit:
                break
            record = _dict(value)
            title = _first_text(record.get("tradeNames"), record.get("genericNames"), record.get("englishName"), arguments["drug"])
            record_url = _first_text(record.get("url"), record.get("pdfUrl"), endpoint)
            identifier = str(record.get("id") or "%s-%d" % (registry, index)).strip()
            item = {
                "id": "EVIMED-LABEL:%s" % identifier,
                "title": title,
                "url": record_url,
                "jurisdiction": registry_labels[registry],
                "registry": registry.upper(),
                "sourceStatus": "EviMed indexed label candidate; official-current verification required",
            }
            for source_field, target_field in field_map.items():
                value = record.get(source_field)
                if value not in (None, "", []):
                    item[target_field] = value[:4000] if isinstance(value, str) else value
            items.append(item)
            sources.append(_source(item["id"], title, record_url, "evimed-%s-label" % registry))
    warnings = [
        "EviMed label search is an indexed evidence source, not proof that the retrieved copy is the current official label."
    ]
    next_actions = ["Verify the exact product, approval number, revision date, and content against the current official regulator or institution copy."]
    if requested and not selected:
        warnings.append("The requested jurisdiction is not mapped to an EviMed regulator collection.")
    return {
        "status": "warning",
        "summary": "Retrieved %d traceable EviMed label candidates." % len(items),
        "data": {"items": items, "requestedJurisdiction": requested or None},
        "sources": sources,
        "warnings": warnings,
        "next_actions": next_actions,
    }


def _bibliographic_metadata_only(result):
    return {
        "status": "warning",
        **result,
        "warnings": [
            "Public literature results contain bibliographic metadata only; titles do not establish study design, evidence level, outcomes, effect estimates, or causality."
        ],
        "next_actions": [
            "Retrieve and review the abstract or full text before classifying study design or summarizing findings."
        ],
    }


def literature(arguments):
    query = arguments["query"]
    limit = arguments.get("limit", 10)
    databases = arguments.get("databases") or ["internal", "pubmed"]
    if "internal" in databases:
        try:
            result = _evimed_literature_records(arguments)
            if result.get("data", {}).get("items") or "pubmed" not in databases:
                return result
            evimed_warning = "EviMed literature search returned no records matching all required concepts."
        except PublicSourceError as error:
            try:
                legacy = _evimed_evidence_records(query, limit)
                if legacy.get("data", {}).get("items"):
                    legacy["warnings"].insert(0, "The documented EviMed literature endpoint was unavailable: %s" % error)
                    return legacy
            except PublicSourceError:
                pass
            evimed_warning = "EviMed evidence search was unavailable: %s" % error
        fallback = _pubmed(query, limit, arguments.get("dateFrom"), arguments.get("dateTo"))
        fallback = _bibliographic_metadata_only(fallback)
        fallback["warnings"].insert(0, evimed_warning)
        return _filter_bibliographic_title_result(fallback, arguments.get("requiredTitleConcepts"))
    if "pubmed" in databases:
        result = _pubmed(query, limit, arguments.get("dateFrom"), arguments.get("dateTo"))
    else:
        result = _crossref(query, limit)
    return _bibliographic_metadata_only(result)


def guideline(arguments):
    try:
        result = _evimed_guidelines(arguments)
        if result.get("data", {}).get("items"):
            return result
        evimed_warning = "EviMed guideline search returned no records matching all required concepts."
    except PublicSourceError as error:
        evimed_warning = "EviMed guideline search was unavailable: %s" % error
    query = arguments["query"]
    if arguments.get("jurisdiction"):
        query = "%s AND %s" % (query, arguments["jurisdiction"])
    query = "(%s) AND (guideline[Publication Type] OR practice guideline[Publication Type])" % query
    fallback = _bibliographic_metadata_only(
        _pubmed(query, arguments.get("limit", 10), source_name="pubmed-guideline")
    )
    fallback["warnings"].insert(0, evimed_warning)
    return fallback


def trials(arguments):
    try:
        result = _evimed_trial_records(arguments)
        if result.get("data", {}).get("items"):
            return result
        evimed_warning = "EviMed clinical-trial search returned no records matching all required concepts."
    except PublicSourceError as error:
        evimed_warning = "EviMed clinical-trial search was unavailable: %s" % error
    base = _base("EVIMED_CLINICAL_TRIALS_BASE_URL", "https://clinicaltrials.gov/api/v2")
    limit = min(arguments.get("limit", 10), 100)
    candidate_limit = _evimed_candidate_limit(arguments, limit)
    params = {"query.term": arguments["query"], "pageSize": candidate_limit, "format": "json"}
    if arguments.get("recruitmentStatus"):
        params["filter.overallStatus"] = arguments["recruitmentStatus"]
    url = _url(base, "studies", params)
    records = _get_json(url).get("studies", [])
    if not isinstance(records, list):
        records = []
    items = []
    for record in records[:candidate_limit]:
        protocol = record.get("protocolSection", {}) if isinstance(record, dict) else {}
        identification = protocol.get("identificationModule", {})
        status = protocol.get("statusModule", {})
        conditions = protocol.get("conditionsModule", {})
        arms = protocol.get("armsInterventionsModule", {})
        nct_id = str(identification.get("nctId") or "").strip()
        if not nct_id:
            continue
        title = identification.get("briefTitle") or identification.get("officialTitle") or nct_id
        record_url = "https://clinicaltrials.gov/study/%s" % urllib.parse.quote(nct_id)
        items.append({
            "id": nct_id,
            "title": title,
            "status": status.get("overallStatus"),
            "conditions": conditions.get("conditions", []),
            "interventions": [item.get("name") for item in arms.get("interventions", []) if isinstance(item, dict) and item.get("name")],
            "url": record_url,
        })
    items, filtered_count = _filter_trial_records(items, arguments.get("requiredConcepts"))
    items = items[:limit]
    sources = [
        _source(item["id"], item.get("title"), item.get("url"), "clinicaltrials.gov")
        for item in items
    ]
    return {
        "status": "warning",
        "summary": "Retrieved %d registered clinical trials." % len(items),
        "data": {"items": items},
        "sources": sources,
        "warnings": [
            evimed_warning,
            *(["Excluded %d public trial candidates that did not identify the required medicine as an intervention and the required condition." % filtered_count] if filtered_count else []),
        ],
        "next_actions": ["Verify the current trial record and protocol before using registry fields in an assessment."],
    }


def _openfda_search(field, term):
    escaped = term.replace("\\", "\\\\").replace('"', '\\"')
    return '%s:"%s"' % (field, escaped)


def labels(arguments):
    try:
        result = _evimed_instruction_records(arguments)
        if result.get("data", {}).get("items"):
            return result
        evimed_warning = "EviMed label search returned no records for the requested jurisdiction."
    except PublicSourceError as error:
        evimed_warning = "EviMed label search was unavailable: %s" % error
    requested_jurisdiction = str(arguments.get("jurisdiction") or "").strip()
    jurisdiction_key = requested_jurisdiction.casefold()
    normalized_jurisdiction = re.sub(r"[^a-z0-9]+", "", requested_jurisdiction.casefold())
    us_jurisdictions = {"us", "usa", "unitedstates", "unitedstatesfda", "fda", "美国", "美國"}
    if requested_jurisdiction and jurisdiction_key not in us_jurisdictions and normalized_jurisdiction not in us_jurisdictions:
        return {
            "status": "warning",
            "summary": "The public label connector cannot retrieve the requested jurisdiction.",
            "data": {
                "items": [],
                "requestedJurisdiction": requested_jurisdiction,
                "availableJurisdiction": "United States (FDA)",
            },
            "warnings": [
                evimed_warning,
                "FDA labeling was not substituted for the requested jurisdiction.",
                "Missing jurisdictional label data is not evidence of approval, non-approval, or off-label status.",
            ],
            "next_actions": [
                "Configure a verified jurisdiction-specific EviMed label adapter or provide the current official label."
            ],
        }
    base = _base("EVIMED_OPENFDA_BASE_URL", "https://api.fda.gov")
    drug = arguments.get("product") or arguments["drug"]
    search = "(%s OR %s)" % (
        _openfda_search("openfda.generic_name", drug),
        _openfda_search("openfda.brand_name", drug),
    )
    limit = min(arguments.get("limit", 3), 3)
    url = _url(base, "drug/label.json", {"search": search, "limit": limit})
    records = _get_json(url, allow_not_found=True).get("results", [])
    if not isinstance(records, list):
        records = []
    items = []
    sources = []
    for record in records[:limit]:
        if not isinstance(record, dict):
            continue
        openfda = record.get("openfda") if isinstance(record.get("openfda"), dict) else {}
        set_id = str(record.get("set_id") or record.get("id") or "").strip()
        title = ", ".join(openfda.get("brand_name") or openfda.get("generic_name") or [drug])
        sections = {
            "indicationsAndUsage": record.get("indications_and_usage"),
            "dosageAndAdministration": record.get("dosage_and_administration"),
            "contraindications": record.get("contraindications"),
            "boxedWarnings": record.get("boxed_warning"),
            "warningsAndCautions": record.get("warnings_and_cautions"),
            "warnings": record.get("warnings"),
        }
        item = {
            "id": set_id or title,
            "title": title,
            "effectiveTime": record.get("effective_time"),
            "brandNames": openfda.get("brand_name", []),
            "genericNames": openfda.get("generic_name", []),
            **{key: _bounded_text_list(value) for key, value in sections.items()},
            "contentTruncated": any(_text_list_truncated(value) for value in sections.values()),
            "jurisdiction": "United States (FDA)",
        }
        items.append(item)
        source_url = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=%s" % urllib.parse.quote(set_id) if set_id else url
        sources.append(_source(set_id or title, title, source_url, "openfda-label"))
    result = {
        "summary": "Retrieved %d FDA label records." % len(items),
        "data": {
            "items": items,
            "requestedJurisdiction": requested_jurisdiction or None,
            "labelJurisdiction": "United States (FDA)",
        },
        "sources": sources,
    }
    if not requested_jurisdiction:
        return {
            "status": "warning",
            **result,
            "warnings": [
                evimed_warning,
                "No jurisdiction was supplied; the returned FDA label must not be treated as a universal label."
            ],
            "next_actions": ["Specify the decision jurisdiction and verify its current official product label."],
        }
    return {
        "status": "warning",
        **result,
        "warnings": [
            evimed_warning,
            *(["No exact product was supplied; generic-name results may include different brands, formulations, strengths, or approved uses and cannot establish label status for the proposed use."] if not arguments.get("product") else []),
        ],
        "next_actions": ["Verify the exact product and current official label before making a label-status determination."],
    }


def _event_search(arguments, include_event=True):
    parts = [_openfda_search("patient.drug.medicinalproduct", arguments["drug"])]
    event = arguments.get("adverseEvent")
    if include_event and event:
        parts.append(_openfda_search("patient.reaction.reactionmeddrapt", event))
    if arguments.get("dateFrom") or arguments.get("dateTo"):
        start = (arguments.get("dateFrom") or "2004-01-01").replace("-", "")
        end = (arguments.get("dateTo") or datetime.now(timezone.utc).date().isoformat()).replace("-", "")
        parts.append("receivedate:[%s TO %s]" % (start, end))
    # Keep the boolean operator semantic in the query value. ``urlencode``
    # will encode the surrounding spaces as ``+`` exactly once; embedding
    # literal plus signs here would turn them into ``%2B`` and make openFDA
    # search for a literal ``+AND+`` token instead of intersecting clauses.
    return " AND ".join(parts)


def adr_cases(arguments):
    base = _base("EVIMED_OPENFDA_BASE_URL", "https://api.fda.gov")
    requested_limit = int(arguments.get("limit", 25) or 25)
    effective_limit = min(requested_limit, _OPENFDA_PUBLIC_CASE_LIMIT)
    records = []
    search = _event_search(arguments)
    for offset in range(0, effective_limit, _OPENFDA_CASE_BATCH_SIZE):
        batch_limit = min(_OPENFDA_CASE_BATCH_SIZE, effective_limit - offset)
        url = _url(
            base,
            "drug/event.json",
            {"search": search, "limit": batch_limit, "skip": offset},
        )
        page = _get_json(url, allow_not_found=True).get("results", [])
        if not isinstance(page, list):
            page = []
        records.extend(page)
        if len(page) < batch_limit:
            break
    items = []
    sources = []
    seen_report_ids = set()
    for record in records[:effective_limit]:
        report_id = str(record.get("safetyreportid") or "").strip()
        if not report_id or report_id in seen_report_ids:
            continue
        seen_report_ids.add(report_id)
        patient = record.get("patient") if isinstance(record.get("patient"), dict) else {}
        reactions = patient.get("reaction") if isinstance(patient.get("reaction"), list) else []
        drugs = patient.get("drug") if isinstance(patient.get("drug"), list) else []
        items.append({
            "id": report_id,
            "receivedDate": record.get("receivedate"),
            "serious": record.get("serious"),
            "reactions": [item.get("reactionmeddrapt") for item in reactions if isinstance(item, dict) and item.get("reactionmeddrapt")],
            "drugs": [item.get("medicinalproduct") for item in drugs if isinstance(item, dict) and item.get("medicinalproduct")],
            "patientSex": patient.get("patientsex"),
            "patientAge": patient.get("patientonsetage"),
            "patientAgeUnit": patient.get("patientonsetageunit"),
        })
        source_url = "https://api.fda.gov/drug/event.json?search=safetyreportid:%s" % urllib.parse.quote(report_id)
        sources.append(_source("FAERS:%s" % report_id, "FAERS safety report %s" % report_id, source_url, "openfda-faers"))
    result = {
        "summary": "Retrieved %d de-identified FAERS reports." % len(items),
        "data": {
            "items": items,
            "requestedLimit": requested_limit,
            "effectiveLimit": effective_limit,
            "publicConnectorLimit": _OPENFDA_PUBLIC_CASE_LIMIT,
        },
        "sources": sources,
    }
    if requested_limit > effective_limit:
        return {
            "status": "warning",
            **result,
            "warnings": [
                "The public OpenFDA fallback caps de-identified case retrieval at %d records per task; configure the managed pharmacovigilance adapter for larger case sets."
                % _OPENFDA_PUBLIC_CASE_LIMIT
            ],
            "next_actions": [
                "Use the returned bounded case set for screening, or configure the managed pharmacovigilance adapter before requesting more than %d case records."
                % _OPENFDA_PUBLIC_CASE_LIMIT
            ],
        }
    return result


def _openfda_total(base, search=None):
    params = {"limit": 1}
    if search:
        params["search"] = search
    url = _url(base, "drug/event.json", params)
    payload = _get_json(url, allow_not_found=True)
    total = payload.get("meta", {}).get("results", {}).get("total", 0)
    return int(total or 0), url


def adr_signal(arguments):
    base = _base("EVIMED_OPENFDA_BASE_URL", "https://api.fda.gov")
    event = arguments.get("adverseEvent")
    if not event:
        url = _url(base, "drug/event.json", {
            "search": _event_search(arguments, include_event=False),
            "count": "patient.reaction.reactionmeddrapt.exact",
            "limit": 100,
        })
        records = _get_json(url, allow_not_found=True).get("results", [])
        records = records if isinstance(records, list) else []
        source = _source("openfda-faers-reaction-count", "FAERS reaction counts for %s" % arguments["drug"], url, "openfda-faers")
        return {
            "status": "warning",
            "summary": "Returned reported reaction counts; an adverse event is required for disproportionality metrics.",
            "data": {"items": records[:100], "metricScope": "reporting counts, not incidence"},
            "sources": [source],
            "warnings": ["Spontaneous-report counts do not estimate incidence or prove causality."],
            "next_actions": ["Select a specific adverse event to calculate ROR, PRR, and crude IC."],
        }
    drug_search = _event_search({**arguments, "adverseEvent": None}, include_event=False)
    event_search = _openfda_search("patient.reaction.reactionmeddrapt", event)
    joint_search = _event_search(arguments)
    a, joint_url = _openfda_total(base, joint_search)
    drug_total, drug_url = _openfda_total(base, drug_search)
    event_total, event_url = _openfda_total(base, event_search)
    total, total_url = _openfda_total(base)
    b = max(drug_total - a, 0)
    c = max(event_total - a, 0)
    d = max(total - a - b - c, 0)
    metrics = arguments.get("metrics") or ["ror", "prr", "ic"]
    values = {}
    warnings = ["Disproportionality is a screening signal and does not establish causality or incidence."]
    estimable = all(value > 0 for value in (a, b, c, d))
    if estimable:
        ror = (a * d) / (b * c)
        se = math.sqrt(sum(1 / value for value in (a, b, c, d)))
        prr = (a / (a + b)) / (c / (c + d))
        ic = math.log2((a * (a + b + c + d)) / ((a + b) * (a + c)))
        if "ror" in metrics:
            values["ror"] = ror
            values["ror95CI"] = [math.exp(math.log(ror) - 1.96 * se), math.exp(math.log(ror) + 1.96 * se)]
        if "prr" in metrics:
            values["prr"] = prr
        if "ic" in metrics:
            values["crudeIc"] = ic
    else:
        warnings.append("One or more FAERS contingency-table cells are zero; requested disproportionality metrics are not estimable and were not calculated.")
    unsupported = [item for item in metrics if item == "ebgm"]
    if unsupported:
        warnings.append("EBGM requires a validated empirical-Bayes implementation and was not calculated by this connector.")
    sources = [
        _source("openfda-faers-joint", "Joint drug-event FAERS count", joint_url, "openfda-faers"),
        _source("openfda-faers-drug", "Drug FAERS count", drug_url, "openfda-faers"),
        _source("openfda-faers-event", "Event FAERS count", event_url, "openfda-faers"),
        _source("openfda-faers-total", "Total FAERS count", total_url, "openfda-faers"),
    ]
    return {
        "status": "warning" if unsupported or not estimable else "success",
        "summary": "Calculated traceable FAERS disproportionality screening metrics." if estimable else "FAERS counts were retrieved, but disproportionality metrics were not estimable.",
        "data": {
            "drug": arguments["drug"],
            "adverseEvent": event,
            "cells": {"a": a, "b": b, "c": c, "d": d},
            "metrics": values,
            "metricStatus": "estimated" if estimable else "not_estimable",
        },
        "sources": sources,
        **({"warnings": warnings, "next_actions": ["Broaden or correct the query until every contingency-table cell is non-zero, then interpret any signal with labels, trials, and clinical literature."]} if unsupported or not estimable else {"warnings": warnings}),
    }


def _capture(function, arguments, warnings):
    try:
        result = function(arguments)
        warnings.extend(result.get("warnings", []))
        return result
    except PublicSourceError as error:
        warnings.append(str(error))
        return {"data": {"items": []}, "sources": []}


def _composite(arguments, mode):
    warnings = []
    drug = arguments["drug"]
    indication = arguments.get("proposedUse") or arguments.get("indication") or ""
    query = "%s %s" % (drug, indication)
    required_concepts = [value for value in (drug, indication) if value]
    label_result = _capture(labels, {
        "drug": drug,
        "product": arguments.get("product"),
        "jurisdiction": arguments.get("jurisdiction"),
        "limit": 5,
    }, warnings)
    guideline_result = _capture(guideline, {
        "query": query,
        "jurisdiction": arguments.get("jurisdiction"),
        "limit": 5,
        "requiredConcepts": required_concepts,
    }, warnings)
    trial_result = _capture(trials, {
        "query": query,
        "limit": 5,
        "requiredConcepts": required_concepts,
    }, warnings)
    literature_result = _capture(literature, {
        "query": query,
        "limit": 8,
        "databases": ["internal", "pubmed"],
        "requiredConcepts": required_concepts,
        "requiredTitleConcepts": [drug],
    }, warnings)
    data = {
        "mode": mode,
        "drug": drug,
        "question": indication,
        "scope": {
            key: arguments.get(key)
            for key in (
                "product", "population", "dose", "route", "frequency", "duration", "formulation",
                "comparator", "jurisdiction", "outcomes", "careSetting", "timeHorizon", "decisionDate",
                "selectionDomains", "evaluationDomains", "scoringPolicyVersion",
            )
            if arguments.get(key)
        },
        "labels": label_result.get("data", {}).get("items", []),
        "guidelines": guideline_result.get("data", {}).get("items", []),
        "trials": trial_result.get("data", {}).get("items", []),
        "literature": literature_result.get("data", {}).get("items", []),
    }
    combined_sources = label_result.get("sources", []) + guideline_result.get("sources", []) + trial_result.get("sources", []) + literature_result.get("sources", [])
    sources = []
    seen_sources = set()
    for source in combined_sources:
        key = (source.get("source"), source.get("id"), source.get("url"))
        if key not in seen_sources:
            seen_sources.add(key)
            sources.append(source)
    if not sources:
        return {
            "status": "warning",
            "summary": "Managed evidence sources returned no traceable records.",
            "data": {"items": []},
            "warnings": warnings or ["No traceable managed evidence was retrieved."],
            "next_actions": ["Broaden the question or configure a private EviMed evidence adapter."],
        }
    common_warnings = warnings + ["Retrieved-source coverage is not equivalent to a complete jurisdictional or HTA review."]
    return {
        "status": "warning",
        "summary": "Assembled a traceable managed evidence packet across labels, guidelines, trials, and literature.",
        "data": data,
        "sources": sources,
        "warnings": common_warnings,
        "next_actions": ["Resolve contradictory sources and state evidence gaps before drawing conclusions."],
    }


def drug_selection(arguments):
    warnings = []
    candidates = arguments["candidateDrugs"][:10]
    records = []
    sources = []
    for drug in candidates:
        packet = _composite({
            "drug": drug,
            "indication": arguments["indication"],
            "population": arguments.get("population"),
            "jurisdiction": arguments.get("jurisdiction"),
        }, "drug-selection-evidence")
        packet_data = packet.get("data", {})
        records.append({
            "drug": drug,
            "labelRecords": len(packet_data.get("labels", [])),
            "guidelineRecords": len(packet_data.get("guidelines", [])),
            "trialRecords": len(packet_data.get("trials", [])),
            "literatureRecords": len(packet_data.get("literature", [])),
            "scores": None,
        })
        sources.extend(packet.get("sources", []))
        warnings.extend(packet.get("warnings", []))
    warnings.append("This public connector provides evidence coverage, not validated formulary scores or price data.")
    if len(arguments["candidateDrugs"]) > len(candidates):
        warnings.append("Only the first 10 candidate medicines were queried in this bounded public-source call.")
    if not sources:
        return {
            "status": "warning",
            "summary": "No traceable public evidence was retrieved for the candidate medicines.",
            "data": {"items": []},
            "warnings": list(dict.fromkeys(warnings)),
            "next_actions": ["Configure the legacy drug-selection adapter for validated scoring."],
        }
    unique_sources = []
    seen_sources = set()
    for source in sources:
        key = (source.get("source"), source.get("id"), source.get("url"))
        if key not in seen_sources:
            seen_sources.add(key)
            unique_sources.append(source)
    return {
        "status": "warning",
        "summary": "Retrieved a traceable evidence-coverage inventory for %d candidate medicines." % len(records),
        "data": {"items": records, "weights": arguments.get("selectionCriteria") or [], "budgetContext": arguments.get("budgetContext")},
        "sources": unique_sources,
        "warnings": list(dict.fromkeys(warnings)),
        "next_actions": ["Configure the legacy drug-selection adapter before assigning validated domain scores."],
    }


def _list(value):
    return value if isinstance(value, list) else []


def _dict(value):
    return value if isinstance(value, dict) else {}


def _first_text(*values):
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()[:2048]
    return "Untitled record"


def _metadata_result(source_id, items, sources, limitation=None):
    warning_text = limitation or (
        "This connector returns source metadata and selected public fields; verify the primary record before scientific interpretation."
    )
    return {
        "status": "warning",
        "summary": "Retrieved %d traceable records from %s." % (len(items), source_id),
        "data": {"source": source_id, "items": items},
        "sources": sources,
        "warnings": [warning_text],
        "next_actions": ["Open and verify the cited primary record before using it in a material claim."],
    }


def _ncbi_database(source_id, query, limit):
    database_map = {
        "pmc": "pmc",
        "pubmed": "pubmed",
        "mesh": "mesh",
        "clinvar": "clinvar",
        "dbsnp": "snp",
        "ncbi-gene": "gene",
        "ncbi-geo": "gds",
        "ncbi-protein": "protein",
        "ncbi-taxonomy": "taxonomy",
        "sra": "sra",
    }
    database = database_map[source_id]
    base = _base("EVIMED_NCBI_EUTILS_BASE_URL", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils")
    search_url = _url(base, "esearch.fcgi", _ncbi_params({
        "db": database, "term": query, "retmax": limit, "retmode": "json", "sort": "relevance",
    }))
    found = _ncbi_get_json(search_url)
    ids = [str(value) for value in _list(_dict(found.get("esearchresult")).get("idlist"))[:limit] if str(value).strip()]
    if not ids:
        return _metadata_result(source_id, [], [])
    summary_url = _url(base, "esummary.fcgi", _ncbi_params({"db": database, "id": ",".join(ids), "retmode": "json"}))
    payload = _dict(_ncbi_get_json(summary_url).get("result"))
    items = []
    sources = []
    for identifier in ids:
        record = _dict(payload.get(identifier))
        title = _first_text(record.get("title"), record.get("caption"), record.get("name"), record.get("description"), identifier)
        record_url = "https://www.ncbi.nlm.nih.gov/%s/%s/" % (
            urllib.parse.quote(database), urllib.parse.quote(identifier)
        )
        item = {
            "id": identifier,
            "title": title,
            "url": record_url,
            "description": _first_text(record.get("description"), record.get("summary"), title)[:1500],
        }
        items.append(item)
        sources.append(_source(identifier, title, record_url, source_id))
    return _metadata_result(source_id, items, sources)


def _arxiv(query, limit):
    base = _base("EVIMED_ARXIV_BASE_URL", "https://export.arxiv.org")
    url = _url(base, "api/query", {"search_query": "all:%s" % query, "start": 0, "max_results": limit})
    try:
        root = ET.fromstring(_get_text(url))
    except ET.ParseError as error:
        raise PublicSourceError("public_source_invalid_response", "arXiv returned invalid Atom XML: %s." % error)
    namespace = {"a": "http://www.w3.org/2005/Atom"}
    items = []
    sources = []
    for entry in root.findall("a:entry", namespace)[:limit]:
        record_url = _first_text(entry.findtext("a:id", namespaces=namespace))
        identifier = record_url.rstrip("/").rsplit("/", 1)[-1]
        title = " ".join(_first_text(entry.findtext("a:title", namespaces=namespace)).split())
        authors = [
            _first_text(author.findtext("a:name", namespaces=namespace))
            for author in entry.findall("a:author", namespace)
        ]
        items.append({
            "id": identifier, "title": title, "url": record_url,
            "published": entry.findtext("a:published", default="", namespaces=namespace),
            "authors": authors,
        })
        sources.append(_source(identifier, title, record_url, "arxiv"))
    return _metadata_result("arxiv", items, sources, "arXiv records may be preprints and are not necessarily peer reviewed.")


def _europe_pmc(query, limit):
    base = _base("EVIMED_EUROPE_PMC_BASE_URL", "https://www.ebi.ac.uk/europepmc/webservices/rest")
    url = _url(base, "search", {"query": query, "format": "json", "pageSize": limit})
    records = _list(_dict(_get_json(url).get("resultList")).get("result"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("pmid"), record.get("pmcid"), record.get("id"))
        title = _first_text(record.get("title"), identifier)
        record_url = "https://europepmc.org/article/%s/%s" % (
            urllib.parse.quote(_first_text(record.get("source"), "MED")), urllib.parse.quote(identifier)
        )
        items.append({"id": identifier, "title": title, "url": record_url, "doi": record.get("doi"), "year": record.get("pubYear")})
        sources.append(_source(identifier, title, record_url, "europe-pmc"))
    return _metadata_result("europe-pmc", items, sources)


def _openalex(query, limit):
    base = _base("EVIMED_OPENALEX_BASE_URL", "https://api.openalex.org")
    url = _url(base, "works", {"search": query, "per-page": limit, "select": "id,doi,title,publication_year,type,primary_location"})
    records = _list(_get_json(url).get("results"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("id"))
        title = _first_text(record.get("title"), identifier)
        record_url = _first_text(record.get("doi"), identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "year": record.get("publication_year"), "type": record.get("type")})
        sources.append(_source(identifier, title, record_url, "openalex"))
    return _metadata_result("openalex", items, sources)


def _dailymed(query, limit):
    base = _base("EVIMED_DAILYMED_BASE_URL", "https://dailymed.nlm.nih.gov/dailymed/services/v2")
    url = _url(base, "spls.json", {"drug_name": query, "pagesize": min(limit, 100)})
    records = _list(_get_json(url).get("data"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("setid"), record.get("spl_version"))
        title = _first_text(record.get("title"), record.get("drug_name"), identifier)
        record_url = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "publishedDate": record.get("published_date")})
        sources.append(_source(identifier, title, record_url, "dailymed"))
    return _metadata_result("dailymed", items, sources, "DailyMed content is jurisdiction-specific labeling; confirm the current label version and product scope.")


def _pubchem(query, limit):
    base = _base("EVIMED_PUBCHEM_BASE_URL", "https://pubchem.ncbi.nlm.nih.gov/rest/pug")
    path = "compound/name/%s/property/Title,MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey/JSON" % urllib.parse.quote(query, safe="")
    url = "%s/%s" % (base, path)
    records = _list(_dict(_get_json(url).get("PropertyTable")).get("Properties"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = str(record.get("CID") or "")
        title = _first_text(record.get("Title"), query)
        record_url = "https://pubchem.ncbi.nlm.nih.gov/compound/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "molecularFormula": record.get("MolecularFormula"), "molecularWeight": record.get("MolecularWeight"), "canonicalSmiles": record.get("ConnectivitySMILES") or record.get("CanonicalSMILES"), "inchiKey": record.get("InChIKey")})
        sources.append(_source(identifier, title, record_url, "pubchem"))
    return _metadata_result("pubchem", items, sources)


def _ols(source_id, query, limit, ontology):
    base = _base("EVIMED_OLS_BASE_URL", "https://www.ebi.ac.uk/ols4/api")
    url = _url(base, "search", {"q": query, "ontology": ontology, "rows": limit})
    records = _list(_dict(_get_json(url).get("response")).get("docs"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("obo_id"), record.get("short_form"), record.get("iri"))
        title = _first_text(record.get("label"), identifier)
        record_url = _first_text(record.get("iri"), url)
        items.append({"id": identifier, "title": title, "url": record_url, "ontology": ontology, "description": _first_text(*_list(record.get("description")), title)[:1500]})
        sources.append(_source(identifier, title, record_url, source_id))
    return _metadata_result(source_id, items, sources)


def _simple_json_source(source_id, query, limit):
    if source_id == "cbioportal":
        base = _base("EVIMED_CBIOPORTAL_BASE_URL", "https://www.cbioportal.org/api")
        url = _url(base, "studies", {"keyword": query, "pageSize": limit, "pageNumber": 0})
        records = _list(_get_json_value(url))
        get_id = lambda r: r.get("studyId")
        get_title = lambda r: r.get("name")
        get_url = lambda r, i: "https://www.cbioportal.org/study/summary?id=%s" % urllib.parse.quote(i)
    elif source_id == "gdc-tcga":
        base = _base("EVIMED_GDC_BASE_URL", "https://api.gdc.cancer.gov")
        url = _url(base, "projects", {"size": 200, "pretty": "false", "fields": "project_id,name,disease_type,primary_site"})
        candidates = _list(_dict(_get_json(url).get("data")).get("hits"))
        needle = query.casefold()
        records = [record for record in candidates if needle in " ".join(str(_dict(record).get(key) or "") for key in ("project_id", "name", "disease_type", "primary_site")).casefold()][:limit]
        get_id = lambda r: r.get("project_id") or r.get("id")
        get_title = lambda r: r.get("name")
        get_url = lambda r, i: "https://portal.gdc.cancer.gov/projects/%s" % urllib.parse.quote(i)
    elif source_id == "monarch":
        base = _base("EVIMED_MONARCH_BASE_URL", "https://api.monarchinitiative.org/v3/api")
        url = _url(base, "search", {"q": query, "limit": limit})
        records = _list(_get_json(url).get("items"))
        get_id = lambda r: r.get("id")
        get_title = lambda r: r.get("name") or r.get("label")
        get_url = lambda r, i: "https://monarchinitiative.org/%s" % urllib.parse.quote(i, safe=":")
    elif source_id == "ena":
        base = _base("EVIMED_ENA_BASE_URL", "https://www.ebi.ac.uk/ena/portal/api")
        normalized_query = " ".join(query.replace('"', "").split())
        url = _url(base, "search", {
            "result": "study",
            "query": 'study_title="%s"' % normalized_query,
            "format": "json",
            "limit": limit,
        })
        records = _list(_get_json_value(url))
        get_id = lambda r: r.get("study_accession") or r.get("accession")
        get_title = lambda r: r.get("study_title") or r.get("description")
        get_url = lambda r, i: "https://www.ebi.ac.uk/ena/browser/view/%s" % urllib.parse.quote(i)
    elif source_id == "interpro":
        base = _base("EVIMED_INTERPRO_BASE_URL", "https://www.ebi.ac.uk/interpro/api")
        url = _url(base, "entry/all", {"search": query, "page_size": limit})
        records = _list(_get_json(url).get("results"))
        get_id = lambda r: _dict(r.get("metadata")).get("accession")
        get_title = lambda r: _dict(r.get("metadata")).get("name")
        get_url = lambda r, i: "https://www.ebi.ac.uk/interpro/entry/InterPro/%s/" % urllib.parse.quote(i)
    elif source_id == "jaspar":
        base = _base("EVIMED_JASPAR_BASE_URL", "https://jaspar.elixir.no/api/v1")
        url = _url(base, "matrix/", {"search": query, "page_size": limit})
        records = _list(_get_json(url).get("results"))
        get_id = lambda r: r.get("matrix_id")
        get_title = lambda r: r.get("name")
        get_url = lambda r, i: "https://jaspar.elixir.no/matrix/%s/" % urllib.parse.quote(i)
    elif source_id == "pride":
        base = _base("EVIMED_PRIDE_BASE_URL", "https://www.ebi.ac.uk/pride/ws/archive/v2")
        url = _url(base, "search/projects", {"keyword": query, "page": 0, "pageSize": limit})
        payload = _get_json_value(url)
        records = _list(payload) or _list(_dict(_dict(payload).get("_embedded")).get("projects")) or _list(_dict(payload).get("projects"))
        get_id = lambda r: r.get("accession")
        get_title = lambda r: r.get("title")
        get_url = lambda r, i: "https://www.ebi.ac.uk/pride/archive/projects/%s" % urllib.parse.quote(i)
    elif source_id == "quickgo":
        base = _base("EVIMED_QUICKGO_BASE_URL", "https://www.ebi.ac.uk/QuickGO/services")
        url = _url(base, "ontology/go/search", {"query": query, "limit": limit})
        records = _list(_get_json(url).get("results"))
        get_id = lambda r: r.get("id")
        get_title = lambda r: r.get("name")
        get_url = lambda r, i: "https://www.ebi.ac.uk/QuickGO/term/%s" % urllib.parse.quote(i, safe=":")
    elif source_id == "reactome":
        base = _base("EVIMED_REACTOME_BASE_URL", "https://reactome.org/ContentService")
        url = _url(base, "search/query", {"query": query, "species": "Homo sapiens", "cluster": "true"})
        groups = _list(_get_json(url).get("results"))
        records = [entry for group in groups for entry in _list(_dict(group).get("entries"))][:limit]
        get_id = lambda r: r.get("stId") or r.get("dbId")
        get_title = lambda r: r.get("name")
        get_url = lambda r, i: "https://reactome.org/content/detail/%s" % urllib.parse.quote(str(i))
    elif source_id == "string":
        base = _base("EVIMED_STRING_BASE_URL", "https://string-db.org/api")
        url = _url(base, "json/resolve", {"identifiers": query, "species": 9606, "limit": limit})
        records = _list(_get_json_value(url))
        get_id = lambda r: r.get("stringId")
        get_title = lambda r: r.get("preferredName")
        get_url = lambda r, i: "https://string-db.org/network/%s" % urllib.parse.quote(i)
    elif source_id == "uniprot":
        base = _base("EVIMED_UNIPROT_BASE_URL", "https://rest.uniprot.org")
        url = _url(base, "uniprotkb/search", {"query": query, "format": "json", "size": limit})
        records = _list(_get_json(url).get("results"))
        get_id = lambda r: r.get("primaryAccession")
        get_title = lambda r: _dict(_dict(r.get("proteinDescription")).get("recommendedName")).get("fullName", {}).get("value") if isinstance(_dict(_dict(r.get("proteinDescription")).get("recommendedName")).get("fullName"), dict) else r.get("uniProtkbId")
        get_url = lambda r, i: "https://www.uniprot.org/uniprotkb/%s/entry" % urllib.parse.quote(i)
    elif source_id == "mygene":
        base = _base("EVIMED_MYGENE_BASE_URL", "https://mygene.info/v3")
        url = _url(base, "query", {"q": query, "size": limit, "fields": "symbol,name,entrezgene,taxid"})
        records = _list(_get_json(url).get("hits"))
        get_id = lambda r: r.get("_id")
        get_title = lambda r: r.get("name") or r.get("symbol")
        get_url = lambda r, i: "https://mygene.info/v3/gene/%s" % urllib.parse.quote(i)
    elif source_id == "myvariant":
        base = _base("EVIMED_MYVARIANT_BASE_URL", "https://myvariant.info/v1")
        url = _url(base, "query", {"q": query, "size": limit, "fields": "_id,dbsnp,clinvar,hg19,hg38"})
        records = _list(_get_json(url).get("hits"))
        get_id = lambda r: r.get("_id")
        get_title = lambda r: r.get("_id")
        get_url = lambda r, i: "https://myvariant.info/v1/variant/%s" % urllib.parse.quote(i, safe=":><")
    elif source_id == "who-gho":
        base = _base("EVIMED_WHO_GHO_BASE_URL", "https://ghoapi.azureedge.net/api")
        url = _url(base, "Indicator", {"$filter": "contains(IndicatorName,'%s')" % query.replace("'", ""), "$top": limit})
        records = _list(_get_json(url).get("value"))
        get_id = lambda r: r.get("IndicatorCode")
        get_title = lambda r: r.get("IndicatorName")
        get_url = lambda r, i: "https://www.who.int/data/gho/indicator-metadata-registry/imr-details/%s" % urllib.parse.quote(i)
    elif source_id == "rxnorm":
        base = _base("EVIMED_RXNORM_BASE_URL", "https://rxnav.nlm.nih.gov/REST")
        url = _url(base, "drugs.json", {"name": query})
        groups = _list(_dict(_get_json(url).get("drugGroup")).get("conceptGroup"))
        records = [entry for group in groups for entry in _list(_dict(group).get("conceptProperties"))][:limit]
        get_id = lambda r: r.get("rxcui")
        get_title = lambda r: r.get("name")
        get_url = lambda r, i: "https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=%s" % urllib.parse.quote(i)
    else:
        raise PublicSourceError("public_source_unsupported", "No public connector is available for %s." % source_id)

    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(get_id(record))
        title = _first_text(get_title(record), identifier)
        record_url = get_url(record, identifier)
        items.append({"id": identifier, "title": title, "url": record_url})
        sources.append(_source(identifier, title, record_url, source_id))
    return _metadata_result(source_id, items, sources)


def _isrctn(query, limit):
    base = _base("EVIMED_ISRCTN_BASE_URL", "https://www.isrctn.com")
    url = _url(base, "api/query/format/default", {"q": query, "limit": limit})
    try:
        root = ET.fromstring(_get_text(url))
    except ET.ParseError as error:
        raise PublicSourceError("public_source_invalid_response", "ISRCTN returned invalid XML: %s." % error)
    items, sources = [], []
    for wrapper in root.findall("{*}fullTrial")[:limit]:
        trial = wrapper.find("{*}trial")
        if trial is None:
            continue
        identifier = _first_text(trial.get("publicIdentifierCanonical"), trial.findtext("{*}isrctn"))
        title = _first_text(trial.findtext("{*}trialDescription/{*}title"), identifier)
        record_url = "https://www.isrctn.com/%s" % urllib.parse.quote(identifier)
        items.append({
            "id": identifier,
            "title": title,
            "url": record_url,
            "scientificTitle": _first_text(trial.findtext("{*}trialDescription/{*}scientificTitle"), title),
            "lastUpdated": trial.get("lastUpdated"),
        })
        sources.append(_source(identifier, title, record_url, "isrctn"))
    return _metadata_result("isrctn", items, sources, "Registry metadata does not establish trial quality, completion, or reported results.")


def _preprint(server, query, limit):
    doi = query.strip()
    if doi.casefold().startswith("https://doi.org/"):
        doi = doi[16:]
    if not re.fullmatch(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", doi):
        raise PublicSourceError(
            "public_source_query_invalid",
            "%s connector currently requires an exact DOI; broad text search is not exposed by the official API." % server,
        )
    base = _base("EVIMED_BIORXIV_BASE_URL", "https://api.biorxiv.org")
    url = "%s/details/%s/%s/na/json" % (base, server, urllib.parse.quote(doi, safe="/"))
    records = _list(_get_json(url).get("collection"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("doi"), doi)
        title = _first_text(record.get("title"), identifier)
        record_url = "https://doi.org/%s" % urllib.parse.quote(identifier, safe="/")
        items.append({
            "id": identifier, "doi": identifier, "title": title, "url": record_url,
            "date": record.get("date"), "version": record.get("version"),
            "category": record.get("category"), "license": record.get("license"),
        })
        sources.append(_source(identifier, title, record_url, server))
    return _metadata_result(server, items, sources, "%s records are preprints and may not be peer reviewed." % server)


def _chembl(query, limit):
    base = _base("EVIMED_CHEMBL_BASE_URL", "https://www.ebi.ac.uk/chembl/api/data")
    url = _url(base, "molecule/search.json", {"q": query, "limit": limit})
    records = _list(_get_json(url).get("molecules"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("molecule_chembl_id"))
        title = _first_text(record.get("pref_name"), identifier)
        record_url = "https://www.ebi.ac.uk/chembl/explore/compound/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "maxPhase": record.get("max_phase"), "moleculeType": record.get("molecule_type")})
        sources.append(_source(identifier, title, record_url, "chembl"))
    return _metadata_result("chembl", items, sources)


def _bindingdb(query, limit):
    accession = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{6,10}(?:-\d+)?", accession):
        raise PublicSourceError("public_source_query_invalid", "BindingDB connector requires a UniProt accession.")
    base = _base("EVIMED_BINDINGDB_BASE_URL", "https://bindingdb.org/rest")
    url = _url(base, "getLigandsByUniprots", {"uniprot": accession, "cutoff": 10, "response": "application/json"})
    payload = _get_json(url)
    response = next((value for key, value in payload.items() if key.casefold().endswith("response") and isinstance(value, dict)), {})
    records = _list(response.get("affinities"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("monomerid"), record.get("doi"), record.get("pmid"))
        title = "%s %s=%s" % (_first_text(record.get("query"), accession), _first_text(record.get("affinity_type"), "affinity"), _first_text(record.get("affinity"), "not reported"))
        record_url = "https://www.bindingdb.org/rwd/bind/chemsearch/marvin/MolStructure.jsp?monomerid=%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "doi": record.get("doi"), "pmid": record.get("pmid"), "affinityType": record.get("affinity_type"), "affinity": record.get("affinity")})
        sources.append(_source(identifier, title, record_url, "bindingdb"))
    return _metadata_result("bindingdb", items, sources, "Binding measurements require assay-context, units, and primary-publication verification.")


def _clinpgx(query, limit):
    base = _base("EVIMED_CLINPGX_BASE_URL", "https://api.clinpgx.org/v1/data")
    url = _url(base, "chemical", {"name": query})
    records = _list(_get_json(url).get("data"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("id"))
        title = _first_text(record.get("name"), identifier)
        record_url = "https://www.clinpgx.org/chemical/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "types": _list(record.get("types"))})
        sources.append(_source(identifier, title, record_url, "clinpgx-pharmgkb"))
    return _metadata_result("clinpgx-pharmgkb", items, sources, "Chemical records are entry points; verify the relevant guideline or annotation before clinical interpretation.")


def _gwas_catalog(query, limit):
    base = _base("EVIMED_GWAS_BASE_URL", "https://www.ebi.ac.uk/gwas/rest/api/v2")
    url = _url(base, "studies", {"diseaseTrait": query, "size": limit})
    records = _list(_dict(_get_json(url).get("_embedded")).get("studies"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("accession_id"))
        title = _first_text(record.get("disease_trait"), identifier)
        record_url = "https://www.ebi.ac.uk/gwas/studies/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "pubmedId": record.get("pubmed_id"), "initialSampleSize": record.get("initial_sample_size")})
        sources.append(_source(identifier, title, record_url, "gwas-catalog-ebi"))
    return _metadata_result("gwas-catalog-ebi", items, sources, "GWAS associations require ancestry, phenotype, harmonization, and multiple-testing context.")


def _alphafold(query, limit):
    accession = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{6,10}(?:-\d+)?", accession):
        raise PublicSourceError("public_source_query_invalid", "AlphaFold DB connector requires a UniProt accession.")
    base = _base("EVIMED_ALPHAFOLD_BASE_URL", "https://alphafold.ebi.ac.uk/api")
    url = "%s/prediction/%s" % (base, urllib.parse.quote(accession))
    records = _list(_retry_json_value(url))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("modelEntityId"), accession)
        title = _first_text(record.get("uniprotDescription"), record.get("uniprotAccession"), identifier)
        record_url = "https://alphafold.ebi.ac.uk/entry/%s" % urllib.parse.quote(accession)
        items.append({"id": identifier, "title": title, "url": record_url, "uniprotAccession": record.get("uniprotAccession"), "modelVersion": record.get("latestVersion"), "globalMetricValue": record.get("globalMetricValue")})
        sources.append(_source(identifier, title, record_url, "alphafold-db-predicted-protein-structures"))
    return _metadata_result("alphafold-db-predicted-protein-structures", items, sources, "Predicted structures require confidence and experimental-context review.")


def _emdb(query, limit):
    base = _base("EVIMED_EMDB_BASE_URL", "https://www.ebi.ac.uk/emdb/api")
    normalized = " ".join(query.split())
    url = _url(base, "search/title:%s" % urllib.parse.quote(normalized, safe=""), {"rows": limit})
    records = _list(_get_json_value(url))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("emdb_id"), record.get("_id"))
        title = _first_text(_dict(record.get("admin")).get("title"), identifier)
        record_url = "https://www.ebi.ac.uk/emdb/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "version": record.get("version")})
        sources.append(_source(identifier, title, record_url, "emdb-electron-microscopy-data-bank"))
    return _metadata_result("emdb-electron-microscopy-data-bank", items, sources)


def _encode(query, limit):
    base = _base("EVIMED_ENCODE_BASE_URL", "https://www.encodeproject.org")
    url = _url(base, "search/", {"type": "Experiment", "searchTerm": query, "limit": limit, "format": "json"})
    records = _list(_get_json(url).get("@graph"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("accession"), record.get("@id"))
        title = _first_text(record.get("description"), record.get("assay_title"), record.get("assay_term_name"), identifier)
        relative = _first_text(record.get("@id"), "/experiments/%s/" % identifier)
        record_url = urllib.parse.urljoin(base + "/", relative)
        items.append({"id": identifier, "title": title, "url": record_url, "assay": record.get("assay_title") or record.get("assay_term_name"), "status": record.get("status")})
        sources.append(_source(identifier, title, record_url, "encode-encyclopedia-of-dna-elements"))
    return _metadata_result("encode-encyclopedia-of-dna-elements", items, sources)


def _ensembl(query, limit):
    symbol = query.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", symbol):
        raise PublicSourceError("public_source_query_invalid", "Ensembl connector requires a gene symbol.")
    base = _base("EVIMED_ENSEMBL_BASE_URL", "https://rest.ensembl.org")
    url = _url(base, "lookup/symbol/homo_sapiens/%s" % urllib.parse.quote(symbol), {"expand": 0})
    record = _retry_json_value(url)
    if not isinstance(record, dict):
        raise PublicSourceError("public_source_invalid_response", "Ensembl returned a non-object JSON response.")
    records = [record]
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("id"))
        title = _first_text(record.get("display_name"), record.get("description"), symbol)
        record_url = "https://www.ensembl.org/Homo_sapiens/Gene/Summary?g=%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "description": record.get("description"), "assembly": record.get("assembly_name"), "biotype": record.get("biotype")})
        sources.append(_source(identifier, title, record_url, "ensembl"))
    return _metadata_result("ensembl", items, sources)


def _gtex(query, limit):
    base = _base("EVIMED_GTEX_BASE_URL", "https://gtexportal.org/api/v2")
    url = _url(base, "reference/gene", {"geneId": query, "pageSize": limit})
    records = _list(_get_json(url).get("data"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("gencodeId"), record.get("entrezGeneId"))
        title = _first_text(record.get("geneSymbol"), record.get("description"), identifier)
        record_url = "https://gtexportal.org/home/gene/%s" % urllib.parse.quote(_first_text(record.get("geneSymbol"), identifier))
        items.append({"id": identifier, "title": title, "url": record_url, "description": record.get("description"), "genomeBuild": record.get("genomeBuild")})
        sources.append(_source(identifier, title, record_url, "gtex-genotype-tissue-expression"))
    return _metadata_result("gtex-genotype-tissue-expression", items, sources)


def _human_protein_atlas(query, limit):
    base = _base("EVIMED_HPA_BASE_URL", "https://www.proteinatlas.org")
    url = _url(base, "api/search_download.php", {"search": query, "format": "json", "columns": "g,gs,up"})
    records = _list(_get_gzip_json(url))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("Gene"), record.get("gene"), record.get("Ensembl"), record.get("Uniprot"))
        title = _first_text(record.get("Gene synonym"), record.get("Gene name"), record.get("Gene"), identifier)
        record_url = "https://www.proteinatlas.org/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "uniprot": record.get("Uniprot")})
        sources.append(_source(identifier, title, record_url, "human-protein-atlas-hpa"))
    return _metadata_result("human-protein-atlas-hpa", items, sources)


def _mousemine(query, limit):
    base = _base("EVIMED_MOUSEMINE_BASE_URL", "https://www.mousemine.org/mousemine/service")
    url = _url(base, "search", {"q": query, "format": "json"})
    records = _list(_get_json(url).get("results"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record); fields = _dict(record.get("fields"))
        identifier = _first_text(fields.get("primaryIdentifier"), record.get("id"))
        title = _first_text(fields.get("symbol"), fields.get("name"), identifier)
        record_url = "https://www.mousemine.org/mousemine/report.do?id=%s" % urllib.parse.quote(str(record.get("id") or identifier))
        items.append({"id": identifier, "title": title, "url": record_url, "type": record.get("type"), "organism": fields.get("organism.commonName")})
        sources.append(_source(identifier, title, record_url, "mousemine-mouse-genome-informatics-intermine-based"))
    return _metadata_result("mousemine-mouse-genome-informatics-intermine-based", items, sources)


def _metabolomics_workbench(query, limit):
    identifier = query.strip().upper()
    if not re.fullmatch(r"ST\d{6}", identifier):
        raise PublicSourceError("public_source_query_invalid", "Metabolomics Workbench connector requires a study identifier such as ST000001.")
    base = _base("EVIMED_METABOLOMICS_BASE_URL", "https://www.metabolomicsworkbench.org/rest")
    url = "%s/study/study_id/%s/summary" % (base, urllib.parse.quote(identifier))
    record = _get_json(url)
    record_id = _first_text(record.get("study_id"), identifier)
    title = _first_text(record.get("study_title"), record_id)
    record_url = _first_text(record.get("study_url"), "https://www.metabolomicsworkbench.org/data/DRCCMetadata.php?Mode=Study&StudyID=%s" % record_id)
    item = {"id": record_id, "title": title, "url": record_url, "species": record.get("species"), "analysisType": record.get("analysis_type"), "license": record.get("license")}
    return _metadata_result("metabolomics-workbench", [item][:limit], [_source(record_id, title, record_url, "metabolomics-workbench")])


def _rcsb_pdb(query, limit):
    identifier = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{4}", identifier):
        raise PublicSourceError("public_source_query_invalid", "RCSB PDB connector requires a four-character PDB identifier.")
    base = _base("EVIMED_RCSB_BASE_URL", "https://data.rcsb.org/rest/v1")
    url = "%s/core/entry/%s" % (base, urllib.parse.quote(identifier))
    record = _get_json(url)
    struct = _dict(record.get("struct")); info = _dict(record.get("rcsb_entry_info"))
    title = _first_text(struct.get("title"), identifier)
    record_url = "https://www.rcsb.org/structure/%s" % urllib.parse.quote(identifier)
    item = {"id": identifier, "title": title, "url": record_url, "resolution": info.get("resolution_combined"), "experimentalMethod": _list(info.get("experimental_method"))}
    return _metadata_result("rcsb-protein-data-bank-pdb", [item][:limit], [_source(identifier, title, record_url, "rcsb-protein-data-bank-pdb")])


def _ucsc(query, limit):
    base = _base("EVIMED_UCSC_BASE_URL", "https://api.genome.ucsc.edu")
    url = _url(base, "search", {"search": query, "genome": "hg38"})
    groups = _list(_get_json(url).get("positionMatches"))
    records = [(group, record) for group in groups for record in _list(_dict(group).get("matches"))][:limit]
    items, sources = [], []
    for group, record in records:
        group = _dict(group); record = _dict(record)
        identifier = _first_text(record.get("hgFindMatches"), record.get("position"))
        title = _first_text(record.get("posName"), record.get("description"), identifier)
        position = _first_text(record.get("position"))
        record_url = "https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=%s" % urllib.parse.quote(position)
        items.append({"id": identifier, "title": title, "url": record_url, "position": position, "track": group.get("trackName"), "description": record.get("description")})
        sources.append(_source(identifier, title, record_url, "ucsc-genome-browser"))
    return _metadata_result("ucsc-genome-browser", items, sources)


def _wikipathways(query, limit):
    literal = query.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")
    sparql = 'SELECT ?pathway ?title WHERE { ?pathway a wp:Pathway ; dc:title ?title . FILTER(CONTAINS(LCASE(STR(?title)), LCASE("%s"))) } LIMIT %d' % (literal, limit)
    base = _base("EVIMED_WIKIPATHWAYS_BASE_URL", "https://sparql.wikipathways.org")
    url = _url(base, "sparql", {"query": sparql})
    payload = _get_json(url, accepted=("application/sparql-results+json", "application/json"))
    records = _list(_dict(payload.get("results")).get("bindings"))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(_dict(record.get("pathway")).get("value"))
        title = _first_text(_dict(record.get("title")).get("value"), identifier)
        items.append({"id": identifier, "title": title, "url": identifier})
        sources.append(_source(identifier, title, identifier, "wikipathways"))
    return _metadata_result("wikipathways", items, sources)


def _iuphar(query, limit):
    base = _base("EVIMED_IUPHAR_BASE_URL", "https://www.guidetopharmacology.org/services")
    url = _url(base, "targets", {"name": query})
    records = _list(_get_json_value(url))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        identifier = _first_text(str(record.get("targetId") or ""))
        title = _first_text(record.get("name"), identifier)
        record_url = "https://www.guidetopharmacology.org/GRAC/ObjectDisplayForward?objectId=%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "type": record.get("type"), "familyNames": _list(record.get("familyNames"))})
        sources.append(_source(identifier, title, record_url, "iuphar-bps-guide-to-pharmacology"))
    return _metadata_result("iuphar-bps-guide-to-pharmacology", items, sources)


def _human_cell_atlas(query, limit):
    identifier = query.strip().casefold()
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", identifier):
        raise PublicSourceError(
            "public_source_query_invalid",
            "Human Cell Atlas connector requires a project UUID.",
        )
    base = _base("EVIMED_HCA_BASE_URL", "https://service.azul.data.humancellatlas.org")
    filters = json.dumps({"projectId": {"is": [identifier]}}, separators=(",", ":"))
    url = _url(base, "index/projects", {"filters": filters, "size": min(limit, 50)})
    hits = _list(_get_json(url).get("hits"))
    projects = [
        project
        for hit in hits
        for project in _list(_dict(hit).get("projects"))
    ]
    items, sources = [], []
    for record in projects[:limit]:
        record = _dict(record)
        record_id = _first_text(record.get("projectId"), identifier)
        title = _first_text(record.get("projectTitle"), record_id)
        record_url = "https://explore.data.humancellatlas.org/projects/%s" % urllib.parse.quote(record_id)
        items.append({
            "id": record_id,
            "title": title,
            "url": record_url,
            "estimatedCellCount": record.get("estimatedCellCount"),
            "laboratory": record.get("laboratory"),
        })
        sources.append(_source(record_id, title, record_url, "human-cell-atlas"))
    return _metadata_result(
        "human-cell-atlas",
        items,
        sources,
        "Project metadata does not itself provide cell-level measurements; inspect the project files and their licenses before analysis.",
    )


def _thousand_genomes(query, limit):
    identifier = query.strip().upper()
    if not re.fullmatch(r"PRJ(?:EB|NA|DB)\d{3,12}", identifier):
        raise PublicSourceError(
            "public_source_query_invalid",
            "1000 Genomes connector requires an ENA/NCBI study accession such as PRJEB31736.",
        )
    base = _base("EVIMED_ENA_PORTAL_BASE_URL", "https://www.ebi.ac.uk/ena/portal/api")
    url = _url(base, "search", {
        "result": "study",
        "query": 'study_accession="%s"' % identifier,
        "fields": "study_accession,study_title,study_description",
        "format": "json",
        "limit": min(limit, 50),
    })
    records = _list(_get_json_value(url))
    items, sources = [], []
    for record in records[:limit]:
        record = _dict(record)
        record_id = _first_text(record.get("study_accession"), identifier)
        title = _first_text(record.get("study_title"), record_id)
        record_url = "https://www.ebi.ac.uk/ena/browser/view/%s" % urllib.parse.quote(record_id)
        items.append({
            "id": record_id,
            "title": title,
            "url": record_url,
            "description": record.get("study_description"),
        })
        sources.append(_source(record_id, title, record_url, "1000-genomes-project"))
    return _metadata_result(
        "1000-genomes-project",
        items,
        sources,
        "This connector resolves study metadata through ENA; cohort files, sample consent, ancestry context, and analysis-ready formats require separate review.",
    )


def _archs4(query, limit):
    normalized = query.strip()
    if not normalized or len(normalized) > 256 or any(character in normalized for character in "\r\n\0"):
        raise PublicSourceError("public_source_query_invalid", "ARCHS4 connector requires a short metadata query.")
    base = _base("EVIMED_ARCHS4_BASE_URL", "https://maayanlab.cloud/sigpy/meta")
    url = _url(base, "quicksearch", {"query": normalized, "species": "human"})
    payload = _get_json(url)
    sample_ids = [
        value for value in _list(payload.get("samples"))
        if isinstance(value, str) and re.fullmatch(r"GSM\d+", value)
    ][:limit]
    items, sources = [], []
    for identifier in sample_ids:
        record_url = "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=%s" % urllib.parse.quote(identifier)
        title = "ARCHS4 human sample %s matching %s" % (identifier, normalized)
        items.append({
            "id": identifier,
            "title": title,
            "url": record_url,
            "species": payload.get("species"),
            "matchingSeriesCount": payload.get("series_count"),
        })
        sources.append(_source(identifier, title, record_url, "archs4"))
    return _metadata_result(
        "archs4",
        items,
        sources,
        "Quick-search results are metadata matches only; expression matrices, normalization choices, and original GEO study context must be verified before inference.",
    )


def _sider_cache_file():
    configured = os.environ.get("EVIMED_SIDER_CACHE_FILE", "").strip()
    path = configured or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "sider-4.1.sqlite")
    if not os.path.isabs(path) or "\0" in path:
        raise PublicSourceError("public_source_dataset_unconfigured", "SIDER cache path must be absolute.")
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise PublicSourceError(
            "public_source_dataset_unconfigured",
            "The verified SIDER cache is not installed; run build_sider_cache.py during release preparation.",
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > 64 * 1024 * 1024:
        raise PublicSourceError("public_source_dataset_invalid", "The verified SIDER cache is not a bounded regular file.")
    return path


def _sider(query, limit):
    normalized = query.strip().casefold()
    if not normalized or len(normalized) > 128 or any(character in normalized for character in "\r\n\0"):
        raise PublicSourceError("public_source_query_invalid", "SIDER connector requires a short drug name.")
    path = _sider_cache_file()
    uri = "file:%s?mode=ro&immutable=1" % urllib.parse.quote(path)
    try:
        connection = sqlite3.connect(uri, uri=True)
        release = connection.execute("SELECT value FROM metadata WHERE key = 'release'").fetchone()
        if release != ("SIDER 4.1 (2015-10-21)",):
            raise PublicSourceError("public_source_dataset_invalid", "The installed SIDER cache has an unexpected release.")
        matches = connection.execute(
            "SELECT compound_id, name FROM drug_names WHERE normalized_name = ? ORDER BY compound_id LIMIT 5",
            (normalized,),
        ).fetchall()
        if not matches:
            escaped = normalized.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            matches = connection.execute(
                "SELECT compound_id, name FROM drug_names WHERE normalized_name LIKE ? ESCAPE '\\' ORDER BY normalized_name, compound_id LIMIT 5",
                ("%%%s%%" % escaped,),
            ).fetchall()
        rows = []
        for compound, drug_name in matches:
            effects = connection.execute(
                "SELECT concept_id, effect_name FROM side_effects WHERE compound_id = ? ORDER BY effect_name, concept_id LIMIT ?",
                (compound, limit - len(rows)),
            ).fetchall()
            rows.extend((compound, drug_name, concept_id, effect_name) for concept_id, effect_name in effects)
            if len(rows) >= limit:
                break
    except (sqlite3.Error, OSError) as error:
        raise PublicSourceError("public_source_dataset_invalid", "The installed SIDER cache cannot be queried: %s." % error) from error
    finally:
        if "connection" in locals():
            connection.close()
    items, sources = [], []
    for compound, drug_name, concept_id, effect_name in rows:
        identifier = "%s|%s" % (compound, concept_id)
        record_url = "https://sideeffects.embl.de/drugs/%s/" % urllib.parse.quote(compound)
        title = "%s - %s" % (drug_name, effect_name)
        items.append({
            "id": identifier,
            "title": title,
            "url": record_url,
            "drug": drug_name,
            "compoundId": compound,
            "meddraConceptId": concept_id,
            "sideEffect": effect_name,
            "release": "SIDER 4.1 (2015-10-21)",
        })
        sources.append(_source(identifier, title, record_url, "sider"))
    return _metadata_result(
        "sider",
        items,
        sources,
        "SIDER 4.1 is a research-only 2015 label-derived dataset. It is not current clinical guidance and must not replace current product labels or pharmacovigilance review.",
    )


def _pharmacy_reference_file():
    configured = os.environ.get("EVIMED_PHARMACY_REFERENCE_DB", "").strip()
    if not configured or not os.path.isabs(configured) or "\0" in configured:
        raise PublicSourceError(
            "pharmacy_reference_unconfigured",
            "The private pharmacy reference database is not configured for this runtime.",
        )
    try:
        metadata = os.lstat(configured)
    except OSError as error:
        raise PublicSourceError(
            "pharmacy_reference_unconfigured",
            "The private pharmacy reference database is unavailable.",
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size <= 0 or metadata.st_size > 256 * 1024 * 1024:
        raise PublicSourceError("pharmacy_reference_invalid", "The private pharmacy reference database is invalid.")
    return configured


def _pharmacy_fts_query(query):
    normalized = query.strip().casefold()
    if not normalized or len(normalized) > 512 or any(value in normalized for value in "\r\n\0"):
        raise PublicSourceError("public_source_query_invalid", "Pharmacy reference query is invalid.")
    tokens = re.findall(r"[a-z0-9][a-z0-9._-]{1,}|[\u3400-\u9fff]{2,}", normalized)
    expanded = []
    for token in tokens[:32]:
        if re.fullmatch(r"[\u3400-\u9fff]{3,}", token):
            expanded.extend(token[index:index + 2] for index in range(len(token) - 1))
        else:
            expanded.append(token)
    if not expanded:
        raise PublicSourceError("public_source_query_invalid", "Pharmacy reference query has no searchable term.")
    return " AND ".join('"%s"' % token.replace('"', '""') for token in dict.fromkeys(expanded))


def pharmacy_reference(arguments):
    path = _pharmacy_reference_file()
    limit = min(arguments.get("limit", 10), 50)
    uri = "file:%s?mode=ro&immutable=1" % urllib.parse.quote(path)
    try:
        connection = sqlite3.connect(uri, uri=True)
        release = connection.execute("SELECT value FROM metadata WHERE key = 'release'").fetchone()
        if release != ("evimed-pharmacy-reference-v1",):
            raise PublicSourceError("pharmacy_reference_invalid", "The private pharmacy reference release is unsupported.")
        rows = connection.execute(
            """
            SELECT r.dataset_id, r.row_number, r.content_json
            FROM records_fts JOIN records r ON r.id = records_fts.rowid
            WHERE records_fts MATCH ?
            ORDER BY bm25(records_fts), r.dataset_id, r.row_number
            LIMIT ?
            """,
            (_pharmacy_fts_query(arguments["query"]), limit),
        ).fetchall()
    except PublicSourceError:
        raise
    except (sqlite3.Error, OSError) as error:
        raise PublicSourceError("pharmacy_reference_invalid", "The private pharmacy reference database cannot be queried.") from error
    finally:
        if "connection" in locals():
            connection.close()
    items, sources = [], []
    for dataset_id, row_number, content_json in rows:
        try:
            content = json.loads(content_json)
        except (TypeError, json.JSONDecodeError) as error:
            raise PublicSourceError(
                "pharmacy_reference_invalid",
                "The private pharmacy reference database contains an invalid record.",
            ) from error
        identifier = "PHARMACY:%s:%s" % (dataset_id, row_number)
        title = "%s row %s" % (dataset_id, row_number)
        items.append({"id": identifier, "dataset": dataset_id, "rowNumber": row_number, "fields": content})
        sources.append({
            "id": identifier,
            "title": title,
            "source": "evimed-private-pharmacy-reference",
            "retrievedAt": _now(),
            "evidenceAccess": "user_provided_other",
        })
    return {
        "status": "warning",
        "summary": "Retrieved %d private pharmacy reference rows." % len(items),
        "data": {"items": items, "release": "evimed-pharmacy-reference-v1"},
        "sources": sources,
        "warnings": [
            "These curated rows are private decision-support references, may include institution-specific mappings, and are not proof of a current label, guideline, or patient-specific recommendation."
        ],
        "next_actions": [
            "Verify material rules against the current official label, pharmacopeia, guideline, and local governance policy before clinical use."
        ],
    }


OPEN_TARGETS_QUERY = "query EviMedOpenTargets($q:String!){ search(queryString:$q){ hits { id name entity } } }"
DGIDB_QUERY = "query EviMedDgidb($names:[String!]!){ genes(names:$names){ nodes { name conceptId interactions { drug { name conceptId } interactionScore } } } }"
GNOMAD_QUERY = "query EviMedGnomad($symbol:String!){ gene(gene_symbol:$symbol, reference_genome:GRCh38){ gene_id symbol } }"
OPENNEURO_QUERY = "query EviMedOpenNeuro($id:ID!){ dataset(id:$id){ id name } }"
CIVIC_QUERY = "query EviMedCivic($symbol:String!){ gene(entrezSymbol:$symbol){ id name entrezId } }"
RUMMAGEO_QUERY = "query EviMedRummaGeo($terms:[String]!, $first:Int!){ geneSetTermSearch(terms:$terms, first:$first, offset:0){ nodes { id term gse platform pmid publishedDate title geneSetById { nGeneIds species } } totalCount } }"


def _graphql(url, query, variables):
    payload = _get_json(url, method="POST", json_body={"query": query, "variables": variables})
    errors = payload.get("errors")
    if isinstance(errors, list) and errors:
        message = _first_text(*[item.get("message") for item in errors if isinstance(item, dict)])
        raise PublicSourceError("public_source_invalid_response", "GraphQL source returned an error: %s." % message)
    return _dict(payload.get("data"))


def _open_targets(query, limit):
    url = _base("EVIMED_OPEN_TARGETS_BASE_URL", "https://api.platform.opentargets.org/api/v4/graphql")
    hits = _list(_dict(_graphql(url, OPEN_TARGETS_QUERY, {"q": query}).get("search")).get("hits"))
    items, sources = [], []
    for record in hits[:limit]:
        record = _dict(record); identifier = _first_text(record.get("id")); title = _first_text(record.get("name"), identifier)
        entity = _first_text(record.get("entity"), "entity")
        record_url = "https://platform.opentargets.org/%s/%s" % (urllib.parse.quote(entity), urllib.parse.quote(identifier))
        items.append({"id": identifier, "title": title, "url": record_url, "entity": entity})
        sources.append(_source(identifier, title, record_url, "open-targets"))
    return _metadata_result("open-targets", items, sources, "Search hits are entity metadata; association claims require the relevant evidence records and scores.")


def _dgidb(query, limit):
    symbol = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9._-]{1,64}", symbol):
        raise PublicSourceError("public_source_query_invalid", "DGIdb connector requires a gene symbol.")
    url = _base("EVIMED_DGIDB_BASE_URL", "https://dgidb.org/api/graphql")
    genes = _list(_dict(_graphql(url, DGIDB_QUERY, {"names": [symbol]}).get("genes")).get("nodes"))
    items, sources = [], []
    for gene in genes:
        gene = _dict(gene); gene_id = _first_text(gene.get("conceptId"), gene.get("name"), symbol)
        for interaction in _list(gene.get("interactions")):
            interaction = _dict(interaction); drug = _dict(interaction.get("drug"))
            drug_id = _first_text(drug.get("conceptId"), drug.get("name"))
            identifier = "%s|%s" % (gene_id, drug_id); title = "%s - %s" % (_first_text(gene.get("name"), symbol), _first_text(drug.get("name"), drug_id))
            record_url = "https://dgidb.org/results?genes=%s" % urllib.parse.quote(symbol)
            items.append({"id": identifier, "title": title, "url": record_url, "gene": gene.get("name"), "drug": drug.get("name"), "interactionScore": interaction.get("interactionScore")})
            sources.append(_source(identifier, title, record_url, "dgidb"))
            if len(items) >= limit:
                break
        if len(items) >= limit:
            break
    return _metadata_result("dgidb", items, sources, "Aggregated drug-gene interactions are hypothesis-generating and require source-level verification.")


def _gnomad(query, limit):
    symbol = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9._-]{1,64}", symbol):
        raise PublicSourceError("public_source_query_invalid", "gnomAD connector requires a gene symbol.")
    url = _base("EVIMED_GNOMAD_BASE_URL", "https://gnomad.broadinstitute.org/api")
    record = _dict(_graphql(url, GNOMAD_QUERY, {"symbol": symbol}).get("gene"))
    if not record:
        return _metadata_result("gnomad", [], [])
    identifier = _first_text(record.get("gene_id"), symbol); title = _first_text(record.get("symbol"), identifier)
    record_url = "https://gnomad.broadinstitute.org/gene/%s?dataset=gnomad_r4" % urllib.parse.quote(identifier)
    item = {"id": identifier, "title": title, "url": record_url}
    return _metadata_result("gnomad", [item][:limit], [_source(identifier, title, record_url, "gnomad")], "Gene resolution alone does not provide variant frequency or constraint evidence.")


def _openneuro(query, limit):
    identifier = query.strip().casefold()
    if not re.fullmatch(r"ds\d{6,}", identifier):
        raise PublicSourceError("public_source_query_invalid", "OpenNeuro connector requires a dataset identifier such as ds000224.")
    url = _base("EVIMED_OPENNEURO_BASE_URL", "https://openneuro.org/crn/graphql")
    record = _dict(_graphql(url, OPENNEURO_QUERY, {"id": identifier}).get("dataset"))
    if not record:
        return _metadata_result("openneuro", [], [])
    record_id = _first_text(record.get("id"), identifier); title = _first_text(record.get("name"), record_id)
    record_url = "https://openneuro.org/datasets/%s" % urllib.parse.quote(record_id)
    item = {"id": record_id, "title": title, "url": record_url}
    return _metadata_result("openneuro", [item][:limit], [_source(record_id, title, record_url, "openneuro")])


def _civic(query, limit):
    symbol = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9._-]{1,64}", symbol):
        raise PublicSourceError("public_source_query_invalid", "CIViC connector requires an Entrez gene symbol.")
    url = _base("EVIMED_CIVIC_BASE_URL", "https://civicdb.org/api/graphql")
    record = _dict(_graphql(url, CIVIC_QUERY, {"symbol": symbol}).get("gene"))
    if not record:
        return _metadata_result("civic", [], [])
    identifier = _first_text(str(record.get("id") or ""), str(record.get("entrezId") or "")); title = _first_text(record.get("name"), symbol)
    record_url = "https://civicdb.org/genes/%s/summary" % urllib.parse.quote(identifier)
    item = {"id": identifier, "title": title, "url": record_url, "entrezId": record.get("entrezId")}
    return _metadata_result("civic", [item][:limit], [_source(identifier, title, record_url, "civic")], "Gene resolution is not a clinical interpretation; inspect variant, evidence-item, assertion, and evidence-level records.")


def _rummageo(query, limit):
    normalized = query.strip()
    if not normalized or len(normalized) > 256 or any(character in normalized for character in "\r\n\0"):
        raise PublicSourceError("public_source_query_invalid", "RummaGEO connector requires a short metadata query.")
    url = _base("EVIMED_RUMMAGEO_BASE_URL", "https://rummageo.com/graphql")
    result = _dict(_graphql(url, RUMMAGEO_QUERY, {"terms": [normalized], "first": limit}).get("geneSetTermSearch"))
    items, sources = [], []
    for record in _list(result.get("nodes"))[:limit]:
        record = _dict(record)
        identifier = _first_text(record.get("id"))
        title = _first_text(record.get("title"), record.get("term"), identifier)
        record_url = "https://rummageo.com/term-search?terms=%s" % urllib.parse.quote(normalized)
        gene_set = _dict(record.get("geneSetById"))
        items.append({
            "id": identifier,
            "title": title,
            "url": record_url,
            "term": record.get("term"),
            "gse": record.get("gse"),
            "platform": record.get("platform"),
            "pmid": record.get("pmid"),
            "publishedDate": record.get("publishedDate"),
            "species": gene_set.get("species"),
            "geneCount": gene_set.get("nGeneIds"),
        })
        sources.append(_source(identifier, title, record_url, "rummageo-geo-gene-set-enrichment-search"))
    return _metadata_result(
        "rummageo-geo-gene-set-enrichment-search",
        items,
        sources,
        "Term-search results are candidate GEO-derived gene sets; inspect contrasts, samples, organism, platform, and source study before enrichment claims.",
    )


def _credentialed_json(url, profile):
    return _get_json_value(url, credential_profile=profile)


def _semantic_scholar(query, limit):
    url = _url("https://api.semanticscholar.org/graph/v1", "paper/search", {
        "query": query, "limit": limit,
        "fields": "paperId,title,url,year,authors,externalIds,abstract,openAccessPdf",
    })
    records = _list(_dict(_credentialed_json(url, "semantic-scholar")).get("data"))
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(value)
        identifier = str(record.get("paperId") or "").strip()
        if not identifier:
            continue
        title = _first_text(record.get("title"), identifier)
        record_url = _first_text(record.get("url"), "https://www.semanticscholar.org/paper/%s" % urllib.parse.quote(identifier))
        external_ids = _dict(record.get("externalIds"))
        items.append({
            "id": identifier, "title": title, "url": record_url, "year": record.get("year"),
            "doi": external_ids.get("DOI"), "pmid": external_ids.get("PubMed"),
            "authors": [_first_text(_dict(author).get("name")) for author in _list(record.get("authors"))[:50]],
            "abstract": str(record.get("abstract") or "").strip()[:1500] or None,
            "openAccessPdf": _dict(record.get("openAccessPdf")).get("url"),
        })
        sources.append(_source(identifier, title, record_url, "semantic-scholar"))
    return _metadata_result("semantic-scholar", items, sources, "Semantic Scholar is a discovery index; verify identifiers, metadata, and claims against the primary record.")


def _core(query, limit):
    url = _url("https://api.core.ac.uk/v3", "search/works", {"q": query, "limit": limit})
    payload = _dict(_credentialed_json(url, "core"))
    records = _list(payload.get("results")) or _list(payload.get("data"))
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(value)
        identifier = str(record.get("id") or record.get("doi") or "").strip()
        if not identifier:
            continue
        title = _first_text(record.get("title"), identifier)
        record_url = _first_text(record.get("downloadUrl"), record.get("sourceFulltextUrls", [None])[0] if _list(record.get("sourceFulltextUrls")) else None, "https://core.ac.uk/works/%s" % urllib.parse.quote(identifier))
        items.append({
            "id": identifier, "title": title, "url": record_url, "doi": record.get("doi"),
            "year": record.get("yearPublished"), "authors": record.get("authors"),
            "fullTextAvailable": bool(record.get("fullText") or record.get("downloadUrl")),
        })
        sources.append(_source(identifier, title, record_url, "core"))
    return _metadata_result("core", items, sources, "CORE availability does not grant reuse rights; verify the primary record and its article-level license.")


def _unpaywall(query, limit):
    url = _url("https://api.unpaywall.org/v2", "search", {"query": query, "page": 1})
    payload = _dict(_credentialed_json(url, "unpaywall"))
    records = _list(payload.get("results"))
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(_dict(value).get("response")) or _dict(value)
        doi = str(record.get("doi") or "").strip()
        if not doi:
            continue
        identifier = "DOI:%s" % doi
        title = _first_text(record.get("title"), identifier)
        best_oa = _dict(record.get("best_oa_location"))
        record_url = _first_text(best_oa.get("url_for_landing_page"), record.get("doi_url"), "https://doi.org/%s" % urllib.parse.quote(doi))
        items.append({
            "id": identifier, "title": title, "url": record_url, "doi": doi,
            "isOa": record.get("is_oa"), "oaStatus": record.get("oa_status"),
            "license": best_oa.get("license"), "pdfUrl": best_oa.get("url_for_pdf"),
        })
        sources.append(_source(identifier, title, record_url, "unpaywall"))
    return _metadata_result("unpaywall", items, sources, "Unpaywall reports open-access locations; verify the landing page, file integrity, and article-level license before reuse.")


def _umls(query, limit):
    url = _url("https://uts-ws.nlm.nih.gov/rest", "search/current", {"string": query, "pageSize": min(limit, 50)})
    payload = _dict(_credentialed_json(url, "umls"))
    records = _list(_dict(payload.get("result")).get("results"))
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(value)
        identifier = str(record.get("ui") or "").strip()
        if not identifier:
            continue
        title = _first_text(record.get("name"), identifier)
        record_url = _first_text(record.get("uri"), "https://uts.nlm.nih.gov/uts/umls/concept/%s" % urllib.parse.quote(identifier))
        items.append({"id": identifier, "title": title, "url": record_url, "rootSource": record.get("rootSource"), "semanticTypes": record.get("semanticTypes")})
        sources.append(_source(identifier, title, record_url, "umls"))
    return _metadata_result("umls", items, sources, "UMLS mappings may include multiple vocabularies and obsolete or non-preferred concepts; verify source vocabulary and release.")


def _omim(query, limit):
    url = _url("https://api.omim.org/api", "entry/search", {"search": query, "limit": limit, "format": "json"})
    payload = _dict(_credentialed_json(url, "omim"))
    records = _list(_dict(_dict(payload.get("omim")).get("searchResponse")).get("entryList"))
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(_dict(value).get("entry")) or _dict(value)
        mim_number = str(record.get("mimNumber") or "").strip()
        if not mim_number:
            continue
        identifier = "MIM:%s" % mim_number
        title = _first_text(record.get("titles", {}).get("preferredTitle") if isinstance(record.get("titles"), dict) else None, record.get("title"), identifier)
        record_url = "https://omim.org/entry/%s" % urllib.parse.quote(mim_number) if mim_number else "https://omim.org"
        items.append({"id": identifier, "title": title, "url": record_url, "mimNumber": mim_number or None})
        sources.append(_source(identifier, title, record_url, "omim"))
    return _metadata_result("omim-online-mendelian-inheritance-in-man", items, sources, "OMIM content is licensed and descriptive; verify the current OMIM entry and permitted use before downstream reuse.")


def _addgene(query, limit):
    url = _url("https://api.developers.addgene.org", "catalog/plasmid/", {"name": query, "page_size": limit})
    payload = _dict(_credentialed_json(url, "addgene"))
    records = _list(payload.get("results"))
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(value)
        identifier = str(record.get("id") or "").strip()
        if not identifier:
            continue
        title = _first_text(record.get("name"), identifier)
        record_url = _first_text(record.get("details_url"), "https://www.addgene.org/%s/" % urllib.parse.quote(identifier))
        items.append({
            "id": identifier, "title": title, "url": record_url, "purpose": record.get("purpose"),
            "genes": record.get("genes"), "species": record.get("species"),
            "experimentalUse": record.get("experimental_use"), "vectorTypes": record.get("vector_types"),
        })
        sources.append(_source(identifier, title, record_url, "addgene-plasmid-repository"))
    return _metadata_result("addgene-plasmid-repository", items, sources, "Catalog metadata does not establish plasmid suitability, sequence identity, or material-transfer permissions; verify the Addgene record and terms.")


def _biogrid(query, limit):
    symbol = query.strip().upper()
    if not re.fullmatch(r"[A-Z0-9._*()-]{1,64}", symbol):
        raise PublicSourceError("public_source_query_invalid", "BioGRID connector requires a bounded gene name or identifier.")
    url = _url("https://webservice.thebiogrid.org", "interactions", {
        "searchNames": "true", "searchSynonyms": "true", "geneList": symbol,
        "includeInteractors": "true", "includeInteractorInteractions": "false",
        "taxId": "9606", "format": "json", "max": limit,
    })
    payload = _credentialed_json(url, "biogrid")
    records = list(payload.values()) if isinstance(payload, dict) else _list(payload)
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(value)
        identifier = str(record.get("BIOGRID_INTERACTION_ID") or record.get("BIOGRID_ID") or "").strip()
        if not identifier:
            continue
        interactor_a = _first_text(record.get("OFFICIAL_SYMBOL_A"), record.get("SYSTEMATIC_NAME_A"))
        interactor_b = _first_text(record.get("OFFICIAL_SYMBOL_B"), record.get("SYSTEMATIC_NAME_B"))
        title = "%s - %s" % (interactor_a, interactor_b)
        pubmed = str(record.get("PUBMED_ID") or "").strip()
        record_url = "https://thebiogrid.org/interaction/%s" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "interactorA": interactor_a, "interactorB": interactor_b, "experimentalSystem": record.get("EXPERIMENTAL_SYSTEM"), "pubmed": pubmed or None})
        sources.append(_source(identifier, title, record_url, "biogrid"))
    return _metadata_result("biogrid", items, sources, "BioGRID interactions are curated experimental records; verify organism, experimental system, throughput, and source publication.")


def _opengwas(query, limit):
    study_id = query.strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{2,128}", study_id):
        raise PublicSourceError("public_source_query_invalid", "OpenGWAS connector requires a study identifier such as ieu-a-2.")
    url = _url("https://api.opengwas.io/api", "gwasinfo", {"id": study_id})
    payload = _credentialed_json(url, "opengwas")
    records = _list(payload) if isinstance(payload, list) else list(_dict(payload).values())
    items, sources = [], []
    for value in records[:limit]:
        record = _dict(value)
        identifier = _first_text(str(record.get("id") or study_id))
        title = _first_text(record.get("trait"), record.get("title"), identifier)
        record_url = "https://gwas.mrcieu.ac.uk/datasets/%s/" % urllib.parse.quote(identifier)
        items.append({"id": identifier, "title": title, "url": record_url, "sampleSize": record.get("sample_size"), "population": record.get("population"), "year": record.get("year")})
        sources.append(_source(identifier, title, record_url, "opengwas-ieu-gwas"))
    return _metadata_result("opengwas-ieu-gwas", items, sources, "OpenGWAS records require source-study verification and must retain OpenGWAS attribution; association data alone do not establish causality.")


BIOMEDICAL_SOURCE_IDS = (
    "arxiv", "cbioportal", "chebi", "clinvar", "crossref", "dailymed", "dbsnp", "ena",
    "europe-pmc", "gdc-tcga", "hpo", "interpro", "jaspar", "mesh", "monarch", "mygene",
    "myvariant", "ncbi-gene", "ncbi-geo", "ncbi-protein", "ncbi-taxonomy", "openalex", "openfda",
    "pmc", "pride", "pubchem", "pubmed", "quickgo", "reactome", "rxnorm", "sra", "string",
    "uniprot", "who-gho", "clinicaltrials-gov", "isrctn", "biorxiv", "medrxiv", "bindingdb",
    "chembl", "clinpgx-pharmgkb", "gwas-catalog-ebi", "alphafold-db-predicted-protein-structures",
    "emdb-electron-microscopy-data-bank", "encode-encyclopedia-of-dna-elements", "ensembl",
    "gtex-genotype-tissue-expression", "human-protein-atlas-hpa",
    "mousemine-mouse-genome-informatics-intermine-based", "metabolomics-workbench",
    "rcsb-protein-data-bank-pdb", "ucsc-genome-browser", "wikipathways",
    "iuphar-bps-guide-to-pharmacology",
    "open-targets", "dgidb", "gnomad", "openneuro", "civic",
    "human-cell-atlas", "1000-genomes-project", "archs4",
    "rummageo-geo-gene-set-enrichment-search",
    "sider",
)
BUNDLED_DATASET_SOURCE_IDS = ("sider",)
CONDITIONAL_BIOMEDICAL_SOURCE_IDS = (
    "core", "semantic-scholar", "unpaywall", "umls",
    "omim-online-mendelian-inheritance-in-man", "addgene-plasmid-repository",
    "biogrid", "opengwas-ieu-gwas",
)
QUERYABLE_BIOMEDICAL_SOURCE_IDS = BIOMEDICAL_SOURCE_IDS + CONDITIONAL_BIOMEDICAL_SOURCE_IDS


def biomedical_search(arguments):
    source_id = arguments["source"]
    query = arguments["query"]
    limit = min(arguments.get("limit", 10), 50)
    credentialed_connectors = {
        "core": _core,
        "semantic-scholar": _semantic_scholar,
        "unpaywall": _unpaywall,
        "umls": _umls,
        "omim-online-mendelian-inheritance-in-man": _omim,
        "addgene-plasmid-repository": _addgene,
        "biogrid": _biogrid,
        "opengwas-ieu-gwas": _opengwas,
    }
    if source_id in credentialed_connectors:
        return credentialed_connectors[source_id](query, limit)
    if source_id in {"pmc", "pubmed", "mesh", "clinvar", "dbsnp", "ncbi-gene", "ncbi-geo", "ncbi-protein", "ncbi-taxonomy", "sra"}:
        return _ncbi_database(source_id, query, limit)
    if source_id == "arxiv":
        return _arxiv(query, limit)
    if source_id == "europe-pmc":
        return _europe_pmc(query, limit)
    if source_id == "openalex":
        return _openalex(query, limit)
    if source_id == "crossref":
        result = _crossref(query, limit)
        return _metadata_result("crossref", result["data"]["items"], result["sources"])
    if source_id == "clinicaltrials-gov":
        result = trials({"query": query, "limit": limit})
        normalized_sources = [{**item, "source": "clinicaltrials-gov"} for item in result["sources"]]
        return _metadata_result("clinicaltrials-gov", result["data"]["items"], normalized_sources)
    if source_id == "openfda":
        result = labels({"drug": query, "limit": min(limit, 3)})
        normalized_sources = [{**item, "source": "openfda"} for item in result["sources"]]
        return _metadata_result("openfda", result["data"]["items"], normalized_sources)
    if source_id == "dailymed":
        return _dailymed(query, limit)
    if source_id == "pubchem":
        return _pubchem(query, limit)
    if source_id == "chebi":
        return _ols("chebi", query, limit, "chebi")
    if source_id == "hpo":
        return _ols("hpo", query, limit, "hp")
    if source_id == "isrctn":
        return _isrctn(query, limit)
    if source_id in {"biorxiv", "medrxiv"}:
        return _preprint(source_id, query, limit)
    if source_id == "bindingdb":
        return _bindingdb(query, limit)
    if source_id == "chembl":
        return _chembl(query, limit)
    if source_id == "clinpgx-pharmgkb":
        return _clinpgx(query, limit)
    if source_id == "gwas-catalog-ebi":
        return _gwas_catalog(query, limit)
    if source_id == "alphafold-db-predicted-protein-structures":
        return _alphafold(query, limit)
    if source_id == "emdb-electron-microscopy-data-bank":
        return _emdb(query, limit)
    if source_id == "encode-encyclopedia-of-dna-elements":
        return _encode(query, limit)
    if source_id == "ensembl":
        return _ensembl(query, limit)
    if source_id == "gtex-genotype-tissue-expression":
        return _gtex(query, limit)
    if source_id == "human-protein-atlas-hpa":
        return _human_protein_atlas(query, limit)
    if source_id == "mousemine-mouse-genome-informatics-intermine-based":
        return _mousemine(query, limit)
    if source_id == "metabolomics-workbench":
        return _metabolomics_workbench(query, limit)
    if source_id == "rcsb-protein-data-bank-pdb":
        return _rcsb_pdb(query, limit)
    if source_id == "ucsc-genome-browser":
        return _ucsc(query, limit)
    if source_id == "wikipathways":
        return _wikipathways(query, limit)
    if source_id == "iuphar-bps-guide-to-pharmacology":
        return _iuphar(query, limit)
    if source_id == "open-targets":
        return _open_targets(query, limit)
    if source_id == "dgidb":
        return _dgidb(query, limit)
    if source_id == "gnomad":
        return _gnomad(query, limit)
    if source_id == "openneuro":
        return _openneuro(query, limit)
    if source_id == "civic":
        return _civic(query, limit)
    if source_id == "human-cell-atlas":
        return _human_cell_atlas(query, limit)
    if source_id == "1000-genomes-project":
        return _thousand_genomes(query, limit)
    if source_id == "archs4":
        return _archs4(query, limit)
    if source_id == "rummageo-geo-gene-set-enrichment-search":
        return _rummageo(query, limit)
    if source_id == "sider":
        return _sider(query, limit)
    return _simple_json_source(source_id, query, limit)


def call(name, arguments):
    if name == "evimed_biomedical_source_search":
        return biomedical_search(arguments)
    if name == "evimed_literature_search":
        return literature(arguments)
    if name == "evimed_guideline_search":
        return guideline(arguments)
    if name == "evimed_clinical_trial_search":
        return trials(arguments)
    if name == "evimed_patent_search":
        return patent(arguments)
    if name == "evimed_pharmacy_reference_search":
        return pharmacy_reference(arguments)
    if name == "evimed_drug_label_search":
        return labels(arguments)
    if name == "evimed_adr_case_query":
        return adr_cases(arguments)
    if name == "evimed_adr_signal_analysis":
        return adr_signal(arguments)
    if name == "evimed_offlabel_evidence_packet":
        return _composite(arguments, "off-label")
    if name == "evimed_comprehensive_drug_evaluation":
        return _composite(arguments, "comprehensive-drug-evaluation")
    if name == "evimed_drug_selection_evaluation":
        return drug_selection(arguments)
    raise PublicSourceError("public_source_unsupported", "No public connector is available for %s." % name)
