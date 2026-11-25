from __future__ import annotations

import logging
import sys

import structlog


def configure_logging(app_env: str = "development") -> None:
    """Configure structured logging with request context propagation."""
    is_prod = app_env.lower() == "production"
    processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer() if is_prod else structlog.dev.ConsoleRenderer(),
    ]

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=logging.INFO,
        force=True,
    )
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "owly_rag") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
