"""Minimal deployable HTTP service for EviMed-managed MetaAgent jobs."""
from fastapi import FastAPI

from new_meta.evimed_adapter import create_evimed_adapter_router


app = FastAPI(title="EviMed MetaAgent Adapter", docs_url=None, redoc_url=None)
app.include_router(create_evimed_adapter_router())


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "evimed-meta-agent"}
