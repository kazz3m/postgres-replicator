import json
import os
import sys
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..crypto import encrypt_dsn, decrypt_dsn

def _default_data_path(env_var: str, filename: str) -> Path:
    env = os.environ.get(env_var)
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = Path(__file__).resolve().parent.parent.parent.parent
        return base / "data" / filename
    return Path("/data") / filename

PROFILES_PATH = _default_data_path("PROFILES_PATH", "profiles.json")

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


class ReplicationConfig(BaseModel):
    pub_name: str = "pg_sync_pub"
    sub_name: str = "pg_sync_sub"
    copy_data: bool = True
    last_applied: Optional[str] = None   # ISO timestamp of last Apply attempt
    last_status: Optional[str] = None    # "ok" | "error" | "partial"
    last_error: Optional[str] = None


class ProfileIn(BaseModel):
    name: str
    source_dsn: str
    source_repl_dsn: str = ""
    dest_dsn: str
    last_used: Optional[str] = None
    selected_tables: Optional[List[str]] = None
    selected_schemas: Optional[List[str]] = None
    replication_config: Optional[ReplicationConfig] = None


class Profile(ProfileIn):
    id: str
    created_at: str


_DSN_FIELDS = ("source_dsn", "source_repl_dsn", "dest_dsn")


def _decrypt_profile(p: dict) -> dict:
    return {**p, **{f: decrypt_dsn(p.get(f, "")) for f in _DSN_FIELDS}}


def _encrypt_profile(p: dict) -> dict:
    return {**p, **{f: encrypt_dsn(p.get(f, "")) for f in _DSN_FIELDS}}


def _read() -> List[dict]:
    if PROFILES_PATH.exists():
        try:
            data = json.loads(PROFILES_PATH.read_text())
            raw = data if isinstance(data, list) else []
            return [_decrypt_profile(p) for p in raw]
        except Exception:
            return []
    return []


def _write(profiles: List[dict]) -> None:
    PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    encrypted = [_encrypt_profile(p) for p in profiles]
    PROFILES_PATH.write_text(json.dumps(encrypted, indent=2))


@router.get("", response_model=List[Profile])
def list_profiles():
    profiles = sorted(
        _read(),
        key=lambda p: p.get("last_used") or p.get("created_at", ""),
        reverse=True,
    )
    return profiles


@router.post("", response_model=Profile, status_code=201)
def create_profile(body: ProfileIn):
    from datetime import datetime, timezone
    import uuid
    profiles = _read()
    profile = {
        "id": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        **body.model_dump(),
    }
    profiles.append(profile)
    _write(profiles)
    return profile


@router.put("/{profile_id}", response_model=Profile)
def update_profile(profile_id: str, body: ProfileIn):
    profiles = _read()
    for i, p in enumerate(profiles):
        if p["id"] == profile_id:
            profiles[i] = {**p, **body.model_dump(exclude_none=False)}
            _write(profiles)
            return profiles[i]
    raise HTTPException(404, f"Profile '{profile_id}' not found.")


@router.patch("/{profile_id}", response_model=Profile)
def patch_profile(profile_id: str, body: dict):
    profiles = _read()
    for i, p in enumerate(profiles):
        if p["id"] == profile_id:
            profiles[i] = {**p, **{k: v for k, v in body.items() if k not in ("id", "created_at")}}
            _write(profiles)
            return profiles[i]
    raise HTTPException(404, f"Profile '{profile_id}' not found.")


@router.delete("/{profile_id}", status_code=204)
def delete_profile(profile_id: str):
    profiles = _read()
    filtered = [p for p in profiles if p["id"] != profile_id]
    if len(filtered) == len(profiles):
        raise HTTPException(404, f"Profile '{profile_id}' not found.")
    _write(filtered)
