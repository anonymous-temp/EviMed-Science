"""Minimal deployable HTTP service for EviMed-managed MetaAgent jobs."""
from typing import Any

from fastapi import FastAPI

from new_meta import evimed_adapter
from new_meta.core import job_slots
from new_meta.evimed_adapter import create_evimed_adapter_router


app = FastAPI(title="EviMed MetaAgent Adapter", docs_url=None, redoc_url=None)
app.include_router(create_evimed_adapter_router())


@app.get("/health")
def health() -> dict[str, Any]:
    # `ready` and `serving` are what the control plane's availability probe
    # reads from every engine's /health, and an engine that answers without
    # `ready: true` is labelled "not ready". This one answered without either
    # and read 受限 on production from the day the probe went live (2026-10-04)
    # while it ran jobs: the other five engines get the keys from the shared
    # specialist adapter, MetaAgent ships its own service. Here they are one
    # fact — the model route a job runs on is configured, the same test a
    # `start` applies. `status` stays "ok": the container healthcheck reads only
    # that this route answers, and web waits on that container.
    serving = evimed_adapter.model_ready()
    return {
        "status": "ok", "service": "evimed-meta-agent", "ready": serving, "serving": serving,
        # The deployment-wide specialist cap, from the one directory every engine
        # container shares: the limit, jobs holding a slot, jobs waiting for one.
        "specialistSlots": job_slots.snapshot(),
    }
