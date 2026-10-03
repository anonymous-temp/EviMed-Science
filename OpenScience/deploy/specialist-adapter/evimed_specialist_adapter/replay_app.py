"""The fixed numerical replay service, without model credentials."""
from fastapi import FastAPI

from . import deterministic_replay
from .replay_service import install_replay_routes
from .service import workspace_for_claims

app = FastAPI(title="EviMed Deterministic Result Replay", docs_url=None, redoc_url=None)
jobs = install_replay_routes(app, workspace_for_claims)


@app.get("/health")
def health():
    methods = []
    for method in deterministic_replay.METHODS:
        try:
            deterministic_replay.manifest(method)
            methods.append(method)
        except deterministic_replay.ReplayError:
            pass
    return {"ready": len(methods) == len(deterministic_replay.METHODS), "methods": methods}
