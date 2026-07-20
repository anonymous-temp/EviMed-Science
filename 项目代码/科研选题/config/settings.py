"""系统配置管理 - DeepSeek V4 双模型路由。"""
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List, Optional
import os


class Settings(BaseSettings):
    """科研选题服务配置。"""

    # 应用基础配置
    APP_NAME: str = "科研选题智能分析Agent"
    APP_VERSION: str = "5.1.0"
    DEBUG: bool = Field(default=False, env="DEBUG")

    # API配置
    API_HOST: str = Field(default="0.0.0.0", env="API_HOST")
    API_PORT: int = Field(default=8000, env="API_PORT")
    API_WORKERS: int = 4

    # DeepSeek V4 配置：轻量任务走 Flash，复杂分析和报告走 Pro。
    LLM_PROVIDER: str = Field(default="deepseek", env="LLM_PROVIDER")
    DEEPSEEK_API_KEY: Optional[str] = Field(default=None, env="DEEPSEEK_API_KEY")
    DEEPSEEK_BASE_URL: str = Field(default="https://api.deepseek.com", env="DEEPSEEK_BASE_URL")
    DEEPSEEK_FLASH_MODEL: str = Field(default="deepseek-v4-flash", env="DEEPSEEK_FLASH_MODEL")
    DEEPSEEK_PRO_MODEL: str = Field(default="deepseek-v4-pro", env="DEEPSEEK_PRO_MODEL")
    DEEPSEEK_FLASH_TIMEOUT_SECONDS: int = Field(default=60, env="DEEPSEEK_FLASH_TIMEOUT_SECONDS")
    # Keep the client deadline slightly above the server gateway deadline so
    # callers receive the gateway's structured timeout instead of racing it.
    DEEPSEEK_PRO_TIMEOUT_SECONDS: int = Field(default=330, env="DEEPSEEK_PRO_TIMEOUT_SECONDS")
    DEEPSEEK_PRO_REASONING_RESERVE_TOKENS: int = Field(
        default=4096, env="DEEPSEEK_PRO_REASONING_RESERVE_TOKENS"
    )
    DEEPSEEK_MAX_OUTPUT_TOKENS: int = Field(default=384000, env="DEEPSEEK_MAX_OUTPUT_TOKENS")
    LLM_MAX_CONCURRENT: int = Field(default=2, env="LLM_MAX_CONCURRENT")

    # PubMed NCBI API Key（可选，有key时频率限制从3次/秒提升到10次/秒）
    NCBI_API_KEY: Optional[str] = Field(default=None, env="NCBI_API_KEY")

    # The OpenAI SDK retry loop is disabled below; this is the one bounded
    # retry budget for transient provider failures.
    LLM_MAX_RETRIES: int = Field(default=2, env="LLM_MAX_RETRIES")
    LLM_TIMEOUT_SECONDS: int = 300
    LLM_TEMPERATURE: float = 0.3  # 稍微提高温度以获得更深入的分析
    LLM_MAX_TOKENS: int = 4000

    # 数据库配置
    MONGODB_URL: str = Field(default="mongodb://localhost:27017", env="MONGODB_URL")
    MONGODB_DB_NAME: str = Field(default="research_agent", env="MONGODB_DB_NAME")

    # Redis配置
    REDIS_URL: str = Field(default="redis://localhost:6379/0", env="REDIS_URL")
    REDIS_CACHE_TTL: int = 3600

    # Elasticsearch配置
    ES_HOST: str = Field(default="localhost", env="ES_HOST")
    ES_PORT: int = Field(default=9200, env="ES_PORT")
    ES_INDEX_NAME: str = Field(default="research_papers", env="ES_INDEX_NAME")
    ES_USERNAME: Optional[str] = Field(default=None, env="ES_USERNAME")
    ES_PASSWORD: Optional[str] = Field(default=None, env="ES_PASSWORD")

    # Celery配置
    CELERY_BROKER_URL: str = Field(default="redis://localhost:6379/1", env="CELERY_BROKER_URL")
    CELERY_RESULT_BACKEND: str = Field(default="redis://localhost:6379/2", env="CELERY_RESULT_BACKEND")
    CELERY_TASK_TIME_LIMIT: int = 600
    CELERY_WORKER_CONCURRENCY: int = 4

    # 业务规则配置
    MIN_LITERATURE_FOR_BIBLIOMETRICS: int = 20
    MIN_LITERATURE_FOR_EVIDENCE_DIAGNOSIS: int = 50
    MIN_LITERATURE_FOR_EVIDENCE_MAP: int = 30
    MIN_LITERATURE_FOR_GAPS: int = 5
    MIN_CLINICAL_RATIO_FOR_UNCERTAINTY: float = 0.1
    MIN_YEAR_SPAN_FOR_TRENDS: int = 5

    # 报告配置
    REPORT_LANGUAGE: str = "zh"
    REPORT_MAX_LENGTH: int = 50000

    # 检索配置
    MAX_SEARCH_RESULTS: int = 1000
    SEARCH_TIMEOUT_SECONDS: int = 30
    PUBMED_MAX_CONCURRENT: int = 3  # PubMed并发请求数限制
    # A module may consume both bounded Pro attempts plus parsing/chart time.
    # This outer deadline must not race the inner model deadline.
    MODULE_TIMEOUT_SECONDS: int = Field(default=700, env="MODULE_TIMEOUT_SECONDS")

    # Java WebSocket 网关配置（Python作为客户端连接Java）
    # JAVA_WS_URL: str = Field(default="ws://192.168.20.252:2066/ws/ws", env="JAVA_WS_URL")
    # JAVA_TOKEN_URL: str = Field(default="http://192.168.20.252:2066/api-evimed/ai-agent/token?clientType=research-topic-selection", env="JAVA_TOKEN_URL")
    JAVA_WS_URL: str = Field(default="wss://evidence-factory.evimed.com/ws/ws", env="JAVA_WS_URL")
    JAVA_TOKEN_URL: str = Field(default="https://evidence-factory.evimed.com/api-evimed/ai-agent/token?clientType=research-topic-selection", env="JAVA_TOKEN_URL")

    # 阿里云 OSS 配置（必须通过环境变量或 .env 文件配置，不允许硬编码）
    OSS_ACCESS_KEY_ID: Optional[str] = Field(default=None, env="OSS_ACCESS_KEY_ID")
    OSS_ACCESS_KEY_SECRET: Optional[str] = Field(default=None, env="OSS_ACCESS_KEY_SECRET")
    OSS_ENDPOINT: str = Field(default="https://oss-cn-beijing.aliyuncs.com", env="OSS_ENDPOINT")
    OSS_BUCKET_NAME: str = Field(default="project-beijing-a4hznzutlh", env="OSS_BUCKET_NAME")
    OSS_PUBLIC_BASE_URL: str = Field(default="https://image.evimed.com/oss", env="OSS_PUBLIC_BASE_URL")

    # # Hermes Memory 记忆系统配置
    # HERMES_MEMORY_URL: str = Field(default="http://localhost:5000", env="HERMES_MEMORY_URL")
    # HERMES_MEMORY_ENABLED: bool = Field(default=True, env="HERMES_MEMORY_ENABLED")

    # API安全配置
    ALLOWED_ORIGINS: List[str] = Field(default=["http://localhost:3000", "http://localhost:8080"], env="ALLOWED_ORIGINS")
    API_RATE_LIMIT_PER_MINUTE: int = 10  # 每分钟最大请求数

    # 日志配置
    LOG_LEVEL: str = Field(default="INFO", env="LOG_LEVEL")
    LOG_FORMAT: str = "json"

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "allow"  # 允许额外的配置项


# 全局配置实例
settings = Settings()


def setup_logging():
    """配置全局日志"""
    import logging
    import sys

    level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)

    if settings.LOG_FORMAT == "json":
        fmt = '{"time":"%(asctime)s","level":"%(levelname)s","module":"%(name)s","message":"%(message)s","file":"%(filename)s:%(lineno)d"}'
    else:
        fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s (%(filename)s:%(lineno)d)"

    # 配置根日志记录器
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # 清除现有的处理器
    root_logger.handlers.clear()

    # 仅控制台输出，不写文件
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_formatter = logging.Formatter(fmt, datefmt="%Y-%m-%d %H:%M:%S")
    console_handler.setFormatter(console_formatter)
    root_logger.addHandler(console_handler)

    # 降低第三方库的日志级别
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)

    logging.info(f"日志系统已初始化 - 级别: {settings.LOG_LEVEL}, 仅控制台输出")
