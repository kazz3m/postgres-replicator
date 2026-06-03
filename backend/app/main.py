from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .routers import connections, analysis, replication
from .db import close_pools


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


@app.get("/health")
async def health():
    return {"status": "ok"}
