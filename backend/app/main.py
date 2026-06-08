import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .routers import connections, analysis, replication, profiles, roles
from .db import close_pools


class _IgnoreClientDisconnect(logging.Filter):
    """Suppress noisy but harmless client-disconnect errors from uvicorn."""
    _IGNORED = (
        "connection was closed in the middle of operation",
        "An existing connection was forcibly closed",
        "ConnectionResetError",
        "ConnectionDoesNotExistError",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(s in msg for s in self._IGNORED)


logging.getLogger("uvicorn.error").addFilter(_IgnoreClientDisconnect())


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await close_pools()


app = FastAPI(title="PostgreSQL Logical Replication Manager", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(connections.router)
app.include_router(analysis.router)
app.include_router(replication.router)
app.include_router(profiles.router)
app.include_router(roles.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
