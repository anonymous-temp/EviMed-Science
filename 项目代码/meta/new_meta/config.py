"""Global configuration for MetaAgent."""

import os
from pathlib import Path
import stat
from typing import Optional

from dotenv import load_dotenv

# Load .env file if present (project root or current directory)
load_dotenv()
_project_env = Path(__file__).resolve().parent.parent / ".env"
if _project_env.exists():
    load_dotenv(_project_env)

# --- LLM Configuration ---
def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


def read_secret(name: str, environ=os.environ) -> tuple[str, str]:
    """(value, problem) of a credential set as NAME, or as the file NAME_FILE names.

    The EviMed compose stack mounts credentials as files and passes the path
    (EVIMED_API_KEY_FILE: /run/secrets/evimed-api-key). A variable set directly
    wins. The file must be an absolute path to a regular file of one line; a
    problem is named, never the value.
    """
    value = str(environ.get(name) or "").strip()
    if value:
        return value, ""
    path = str(environ.get(f"{name}_FILE") or "").strip()
    if not path:
        return "", ""
    if not os.path.isabs(path) or "\0" in path:
        return "", f"{name}_FILE must be an absolute path"
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        return "", f"{name}_FILE is unreadable ({type(exc).__name__})"
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 8192:
            return "", f"{name}_FILE is not a regular file of at most 8192 bytes"
        content = os.read(descriptor, 8193).decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return "", f"{name}_FILE is unreadable ({type(exc).__name__})"
    finally:
        os.close(descriptor)
    content = content[:-1] if content.endswith("\n") else content
    if not content or content != content.strip() or any(character in content for character in "\r\n\0"):
        return "", f"{name}_FILE does not hold one credential line"
    return content, ""


def _env_optional_bool(name: str) -> Optional[bool]:
    value = os.getenv(name)
    if value is None:
        return None
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


LLM_API_KEY = os.getenv("LLM_API_KEY") or os.getenv("DEEPSEEK_API_KEY") or os.getenv("DASHSCOPE_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL") or os.getenv("DASHSCOPE_BASE_URL", "https://api.deepseek.com")
LLM_MODEL = os.getenv("LLM_MODEL") or os.getenv("DASHSCOPE_MODEL", "deepseek-flash")
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", os.getenv("LLM_MAX_TOKENS_DEFAULT", "8192")))
LLM_MAX_TOKENS_PLANNING = int(os.getenv("LLM_MAX_TOKENS_PLANNING", "4096"))
LLM_MAX_TOKENS_SCREENING = int(os.getenv("LLM_MAX_TOKENS_SCREENING", "8192"))
LLM_MAX_TOKENS_EXTRACTION = int(os.getenv("LLM_MAX_TOKENS_EXTRACTION", "16384"))
LLM_MAX_TOKENS_WRITING = int(os.getenv("LLM_MAX_TOKENS_WRITING", "32768"))
LLM_MAX_TOKENS_GRADE = int(os.getenv("LLM_MAX_TOKENS_GRADE", "8192"))
# With DeepSeek V4 thinking enabled, max_tokens covers the reasoning as well as
# the answer, so the per-task budgets above (sized for answers) were eaten by
# reasoning: on 2026-09-28 the ma-001 planning call hit 8,192 and then 16,384
# with finish_reason=length, each a full generation thrown away before the
# retry doubled the budget. Thinking calls start at this floor instead; an
# unused budget costs nothing.
LLM_THINKING_MIN_MAX_TOKENS = int(os.getenv("LLM_THINKING_MIN_MAX_TOKENS", "32768"))
# No retry asks for more than this. A response truncated at the cap is not
# asked for again: the same prompt at the same budget truncates the same way.
LLM_MAX_TOKENS_CAP = int(os.getenv("LLM_MAX_TOKENS_CAP", "65536"))
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0"))
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "5"))
LLM_RETRY_MAX_WAIT_SECONDS = float(os.getenv("LLM_RETRY_MAX_WAIT_SECONDS", "16"))
LLM_JSON_REPAIR_RETRIES = int(os.getenv("LLM_JSON_REPAIR_RETRIES", "1"))
LLM_CONNECT_TIMEOUT_SECONDS = float(os.getenv("LLM_CONNECT_TIMEOUT_SECONDS", "8"))
LLM_READ_TIMEOUT_SECONDS = float(os.getenv("LLM_READ_TIMEOUT_SECONDS", "120"))
LLM_WRITE_TIMEOUT_SECONDS = float(os.getenv("LLM_WRITE_TIMEOUT_SECONDS", "30"))
LLM_POOL_TIMEOUT_SECONDS = float(os.getenv("LLM_POOL_TIMEOUT_SECONDS", "8"))
LLM_TRUST_ENV = _env_flag("LLM_TRUST_ENV", False)
LLM_USE_RESPONSES_API = _env_flag("LLM_USE_RESPONSES_API", False) or _env_flag("DASHSCOPE_USE_RESPONSES_API", False)
LLM_ENABLE_SEARCH = _env_flag("LLM_ENABLE_SEARCH", False) or _env_flag("DASHSCOPE_ENABLE_SEARCH", False)
LLM_FORCE_SEARCH = _env_flag("LLM_FORCE_SEARCH", False) or _env_flag("DASHSCOPE_FORCE_SEARCH", False)
LLM_ENABLE_THINKING = _env_optional_bool("LLM_ENABLE_THINKING")
LLM_REASONING_EFFORT = os.getenv("LLM_REASONING_EFFORT", "high").strip().lower() or "high"
LLM_STREAM = _env_flag("LLM_STREAM", False) or _env_flag("DASHSCOPE_STREAM", False)
LLM_SEARCH_STRATEGY = os.getenv("LLM_SEARCH_STRATEGY", "").strip()

# --- PubMed Configuration ---
PUBMED_EMAIL = os.getenv("PUBMED_EMAIL", "").strip()
PUBMED_API_KEY = os.getenv("PUBMED_API_KEY", "")

# --- Internal Database ---
INTERNAL_DB_URL = os.getenv(
    "INTERNAL_DB_URL",
    "https://www.evimed.com/api-evimed/FineScreenController/interface/paper",
)
EVIMED_EVIDENCE_URL = os.getenv(
    "EVIMED_EVIDENCE_URL",
    "https://www.evimed.com/api-evimed/medicine-api/ai-api/search/api/evidence",
)
# Read from EVIMED_API_KEY_FILE too: compose has mounted the platform key for
# this engine since 2026-08-27, and until 2026-09-28 nothing read it, so the
# background-evidence search always reported missing_evimed_api_key.
EVIMED_API_KEY, EVIMED_API_KEY_PROBLEM = read_secret("EVIMED_API_KEY")
EVIMED_EVIDENCE_MAX_REFERENCES = int(os.getenv("EVIMED_EVIDENCE_MAX_REFERENCES", "12"))

# --- Manuscript polish ---
MANUSCRIPT_POLISH_ENABLED = _env_flag("MANUSCRIPT_POLISH_ENABLED", False)
MANUSCRIPT_POLISH_USE_LLM = _env_flag("MANUSCRIPT_POLISH_USE_LLM", True)
MANUSCRIPT_POLISH_REWRITE_SCOPE = os.getenv("MANUSCRIPT_POLISH_REWRITE_SCOPE", "targeted").strip().lower()
MANUSCRIPT_POLISH_MAX_LLM_CHUNKS = int(os.getenv("MANUSCRIPT_POLISH_MAX_LLM_CHUNKS", "6"))
MANUSCRIPT_POLISH_PROOFREADER = os.getenv("MANUSCRIPT_POLISH_PROOFREADER", "").strip().lower()
LANGUAGETOOL_URL = os.getenv("LANGUAGETOOL_URL", "").strip().rstrip("/")
LANGUAGETOOL_TIMEOUT_SECONDS = float(os.getenv("LANGUAGETOOL_TIMEOUT_SECONDS", "8"))

# --- MinEru PDF Parser ---
MINERU_TOKEN = os.getenv("MINERU_TOKEN", "")

# --- Pipeline Parameters ---
MAX_SEARCH_RESULTS = int(os.getenv("MAX_SEARCH_RESULTS", "200"))
# Title/abstract screening budget (the relevance cap). With T de-duplicated
# records inside the protocol date range, the number screened is
#   B(T) = min(T, max(TA_SCREENING_FLOOR, ceil(TA_SCREENING_FRACTION * T)), TA_SCREENING_CEILING)
# so every record is screened up to the floor, and a larger topic screens its
# more relevant half, never fewer than the floor and never more than the
# ceiling. An explicit --max-papers lowers it further. PubMed retrieval reaches
# the ceiling so the ranking sees the topic. This replaced a fixed
# MAX_SEARCH_RESULTS=200 (no longer read by the retriever): on 2026-09-28 the
# ma-001 run screened 200 of 396 records and never retrieved 882 PubMed hits.
TA_SCREENING_FLOOR = max(1, int(os.getenv("TA_SCREENING_FLOOR", "400")))
TA_SCREENING_FRACTION = min(1.0, max(0.0, float(os.getenv("TA_SCREENING_FRACTION", "0.5"))))
TA_SCREENING_CEILING = max(1, int(os.getenv("TA_SCREENING_CEILING", "1000")))
TOP_K_PAPERS = int(os.getenv("TOP_K_PAPERS", "30"))
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "4"))
# Planning proposals per review, each checked by the compiler and by an
# independent scope assessment before any search. Was a fixed 3: on 2026-09-28
# a ma-001 run spent two on scope corrections and its third on a design label
# outside the vocabulary, and the review ended before searching (about 2 min
# per attempt). Every attempt is logged ("PICO proposal attempt N").
PLANNER_MAX_ATTEMPTS = max(1, int(os.getenv("PLANNER_MAX_ATTEMPTS", "4")))
MAX_CHECK_ROUNDS = 3  # Self-proving max iterations
TA_BATCH_SIZE = int(os.getenv("TA_BATCH_SIZE", "50"))
BATCH_SCREENING_THRESHOLD = int(os.getenv("BATCH_SCREENING_THRESHOLD", "200"))
LARGE_RESULT_WARNING = int(os.getenv("LARGE_RESULT_WARNING", "5000"))
LOW_SEARCH_RESULTS = int(os.getenv("LOW_SEARCH_RESULTS", "10"))
LOW_SCREENING_RESULTS = int(os.getenv("LOW_SCREENING_RESULTS", "5"))

# --- Output ---
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "output"))

# --- Sci-Hub ---
SCIHUB_ENABLED = _env_flag("SCIHUB_ENABLED", False)
SCIHUB_BASE_URL = os.getenv("SCIHUB_BASE_URL", "").strip()

# --- PDF intake / downloads ---
PDF_DOWNLOAD_MAX_BYTES = int(os.getenv("PDF_DOWNLOAD_MAX_BYTES", str(50 * 1024 * 1024)))
USER_PDF_MAX_BYTES = int(os.getenv("USER_PDF_MAX_BYTES", str(50 * 1024 * 1024)))
USER_PDF_TOTAL_MAX_BYTES = int(os.getenv("USER_PDF_TOTAL_MAX_BYTES", str(500 * 1024 * 1024)))
PDF_DOWNLOAD_ALLOWED_HOSTS = os.getenv("PDF_DOWNLOAD_ALLOWED_HOSTS", "").strip()
PDF_DOWNLOAD_ALLOW_INSECURE_HTTP = _env_flag("PDF_DOWNLOAD_ALLOW_INSECURE_HTTP", False)

# --- Automatic full-text retrieval (step 5) ---
# Bounds per paper: every full-text fetch (a PDF candidate, a landing page,
# the Europe PMC XML) counts as one attempt, and no new attempt starts once
# the paper's wall-clock budget is spent. With ~50 papers per review and
# FULLTEXT_MAX_WORKERS in parallel, the worst case stays within a few minutes.
FULLTEXT_MAX_ATTEMPTS_PER_PAPER = max(1, int(os.getenv("FULLTEXT_MAX_ATTEMPTS_PER_PAPER", "8")))
FULLTEXT_PAPER_DEADLINE_SECONDS = max(5.0, float(os.getenv("FULLTEXT_PAPER_DEADLINE_SECONDS", "45")))
FULLTEXT_MAX_WORKERS = max(1, int(os.getenv("FULLTEXT_MAX_WORKERS", "8")))
# Unpaywall identifies callers by a contact address, not a key. The deployment
# passes the operator's Unpaywall address as PUBMED_EMAIL, and that is the only
# variable read: a second name compose does not hand over is a route that is
# silently off in production (audit:hosted-compliance). With no address the
# Unpaywall route is skipped. The address is never logged.
UNPAYWALL_EMAIL = PUBMED_EMAIL
