# [IN] deploy.env / .env / environment variables
# [OUT] Config dataclass with all settings
# [POS] src/bibliometric/config.py - loaded by all modules

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


@dataclass
class Config:
    """Global configuration for bibliometric analysis."""

    # PubMed API
    ncbi_api_key: str = ""
    ncbi_email: str = ""
    rate_limit: float = 3.0
    batch_size: int = 500       # 每批获取记录数（从200提升到500，减少API调用次数）
    max_retries: int = 3
    retry_delay: float = 1.0

    # DeepSeek V4 API
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_flash_model: str = "deepseek-v4-flash"
    deepseek_pro_model: str = "deepseek-v4-pro"
    deepseek_pro_reasoning_reserve_tokens: int = 4096
    deepseek_max_output_tokens: int = 384000
    deepseek_pro_timeout_seconds: float = 300.0
    llm_max_tokens: int = 12000

    # Retrieval
    max_records: int = 1000     # 默认最多检索1000篇（从2000降低，大幅缩短检索时间）

    # Network analysis node limits
    network_max_nodes_keyword: int = 50
    network_max_nodes_author: int = 30
    network_max_nodes_institution: int = 20
    network_max_nodes_country: int = 10

    # ROR institution disambiguation
    ror_top_n: int = 50

    # Output
    output_dir: Path = field(default_factory=lambda: Path("./output"))

    def __post_init__(self):
        self.output_dir = Path(self.output_dir)
        if self.ncbi_api_key:
            self.rate_limit = 10.0


def load_config(
    api_key: str = "",
    email: str = "",
    output_dir: str = "",
) -> Config:
    """Load config from deploy.env / .env and CLI overrides."""
    root = Path(__file__).resolve().parents[2]
    env_file = root / ".env"
    deploy_env = root / "deploy.env"
    if env_file.exists():
        load_dotenv(env_file, override=False)
    if deploy_env.exists():
        load_dotenv(deploy_env, override=False)
    return Config(
        ncbi_api_key=api_key or os.getenv("NCBI_API_KEY", ""),
        ncbi_email=email or os.getenv("NCBI_EMAIL", ""),
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY", ""),
        deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        deepseek_flash_model=os.getenv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash"),
        deepseek_pro_model=os.getenv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
        deepseek_pro_reasoning_reserve_tokens=int(
            os.getenv("DEEPSEEK_PRO_REASONING_RESERVE_TOKENS", "4096")
        ),
        deepseek_max_output_tokens=int(
            os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "384000")
        ),
        deepseek_pro_timeout_seconds=float(
            os.getenv("DEEPSEEK_PRO_TIMEOUT_SECONDS", "300")
        ),
        llm_max_tokens=int(os.getenv("LLM_MAX_TOKENS", "12000")),
        max_records=int(os.getenv("MAX_RECORDS", "1000")),
        network_max_nodes_keyword=int(os.getenv("NETWORK_MAX_NODES_KEYWORD", "50")),
        network_max_nodes_author=int(os.getenv("NETWORK_MAX_NODES_AUTHOR", "30")),
        network_max_nodes_institution=int(os.getenv("NETWORK_MAX_NODES_INSTITUTION", "20")),
        network_max_nodes_country=int(os.getenv("NETWORK_MAX_NODES_COUNTRY", "10")),
        ror_top_n=int(os.getenv("ROR_TOP_N", "50")),
        output_dir=Path(output_dir or os.getenv("OUTPUT_DIR", "./output")),
    )
