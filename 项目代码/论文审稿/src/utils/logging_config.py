"""
Structured logging configuration for the review system
"""
import json
import logging
import sys
from datetime import datetime
from typing import Any, Dict
from pathlib import Path


class JSONFormatter(logging.Formatter):
    """
    Custom JSON formatter for structured logging.
    Outputs log records as JSON for easy parsing and monitoring.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON"""
        log_data: Dict[str, Any] = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Add standard fields
        if hasattr(record, "job_id"):
            log_data["job_id"] = record.job_id
        if hasattr(record, "agent_type"):
            log_data["agent_type"] = record.agent_type
        if hasattr(record, "task_id"):
            log_data["task_id"] = record.task_id
        if hasattr(record, "block_id"):
            log_data["block_id"] = record.block_id

        # Add duration if present
        if hasattr(record, "duration_ms"):
            log_data["duration_ms"] = record.duration_ms

        # Add LLM metrics if present
        if hasattr(record, "llm_model"):
            log_data["llm_model"] = record.llm_model
        if hasattr(record, "input_tokens"):
            log_data["input_tokens"] = record.input_tokens
        if hasattr(record, "output_tokens"):
            log_data["output_tokens"] = record.output_tokens

        # Add exception info if present
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        # Add any extra fields
        if hasattr(record, "extra_data"):
            log_data.update(record.extra_data)

        return json.dumps(log_data, ensure_ascii=False)


class ReviewLogger:
    """
    Contextual logger for the review system.
    Provides convenient methods for logging with context.
    """

    def __init__(self, name: str, job_id: str = None):
        """
        Initialize review logger.

        Args:
            name: Logger name (typically module or component name)
            job_id: Optional job ID for context
        """
        self.logger = logging.getLogger(name)
        self.job_id = job_id
        self.context: Dict[str, Any] = {}

    def set_context(self, **kwargs):
        """Set context fields that will be added to all log messages"""
        self.context.update(kwargs)

    def clear_context(self):
        """Clear all context fields"""
        self.context.clear()

    def _log(self, level: int, msg: str, **kwargs):
        """Internal log method that adds context"""
        # exc_info 不能放入 extra dict（Python 3.12+ 会抛异常），需单独传递
        exc_info = kwargs.pop("exc_info", None)
        extra = {**self.context, **kwargs}
        if self.job_id:
            extra["job_id"] = self.job_id

        self.logger.log(level, msg, extra=extra, exc_info=exc_info)

    def debug(self, msg: str, **kwargs):
        """Log debug message"""
        self._log(logging.DEBUG, msg, **kwargs)

    def info(self, msg: str, **kwargs):
        """Log info message"""
        self._log(logging.INFO, msg, **kwargs)

    def warning(self, msg: str, **kwargs):
        """Log warning message"""
        self._log(logging.WARNING, msg, **kwargs)

    def error(self, msg: str, **kwargs):
        """Log error message"""
        self._log(logging.ERROR, msg, **kwargs)

    def critical(self, msg: str, **kwargs):
        """Log critical message"""
        self._log(logging.CRITICAL, msg, **kwargs)

    def log_llm_call(
        self,
        agent_type: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        duration_ms: float,
        success: bool = True
    ):
        """Log an LLM API call with metrics"""
        self.info(
            f"LLM call {'succeeded' if success else 'failed'}",
            agent_type=agent_type,
            llm_model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            duration_ms=duration_ms,
            success=success
        )

    def log_agent_execution(
        self,
        agent_type: str,
        task_id: str,
        duration_ms: float,
        success: bool = True,
        error: str = None
    ):
        """Log agent execution"""
        extra = {
            "agent_type": agent_type,
            "task_id": task_id,
            "duration_ms": duration_ms,
            "success": success
        }
        if error:
            extra["error"] = error

        level = logging.INFO if success else logging.ERROR
        msg = f"Agent {agent_type} {'completed' if success else 'failed'} task {task_id}"
        self._log(level, msg, **extra)


def setup_logging(
    log_level: str = "INFO",
    log_file: str = None,
    json_format: bool = True
) -> logging.Logger:
    """
    Setup logging configuration for the entire application.

    Args:
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_file: Optional path to log file (logs to console if not provided)
        json_format: If True, use JSON formatter; otherwise use standard formatter

    Returns:
        Configured root logger
    """
    # Get root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, log_level.upper()))

    # Remove existing handlers
    root_logger.handlers.clear()

    # Setup formatter
    if json_format:
        formatter = JSONFormatter()
    else:
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(getattr(logging, log_level.upper()))
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    # File handler if specified
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.FileHandler(log_file, encoding='utf-8')
        file_handler.setLevel(getattr(logging, log_level.upper()))
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)

    return root_logger


def get_logger(name: str, job_id: str = None) -> ReviewLogger:
    """
    Get a contextual logger for a specific component.

    Args:
        name: Logger name (typically __name__)
        job_id: Optional job ID for context

    Returns:
        ReviewLogger instance
    """
    return ReviewLogger(name, job_id)
