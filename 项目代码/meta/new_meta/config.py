"""Global configuration for MetaAgent."""

import os
from pathlib import Path
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


def _env_optional_bool(name: str) -> Optional[bool]:
    value = os.getenv(name)
    if value is None:
        return None
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


LLM_API_KEY = os.getenv("LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL") or os.getenv("DASHSCOPE_BASE_URL", "https://api.openai.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL") or os.getenv("DASHSCOPE_MODEL", "gpt-4o")
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", os.getenv("LLM_MAX_TOKENS_DEFAULT", "8192")))
LLM_MAX_TOKENS_PLANNING = int(os.getenv("LLM_MAX_TOKENS_PLANNING", "4096"))
LLM_MAX_TOKENS_SCREENING = int(os.getenv("LLM_MAX_TOKENS_SCREENING", "8192"))
LLM_MAX_TOKENS_EXTRACTION = int(os.getenv("LLM_MAX_TOKENS_EXTRACTION", "16384"))
LLM_MAX_TOKENS_WRITING = int(os.getenv("LLM_MAX_TOKENS_WRITING", "32768"))
LLM_MAX_TOKENS_GRADE = int(os.getenv("LLM_MAX_TOKENS_GRADE", "8192"))
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
EVIMED_API_KEY = os.getenv("EVIMED_API_KEY", "")
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
TOP_K_PAPERS = int(os.getenv("TOP_K_PAPERS", "30"))
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "4"))
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
