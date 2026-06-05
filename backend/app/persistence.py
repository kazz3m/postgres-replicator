import json
import os
from pathlib import Path
from .crypto import encrypt_dsn, decrypt_dsn

CONFIG_PATH = Path(os.environ.get("CONFIG_PATH", "/data/config.json"))

_defaults = {
    "source_dsn": "",
    "source_repl_dsn": "",
    "dest_dsn": "",
    "stats_refresh_interval": 10,
}

_DSN_FIELDS = ("source_dsn", "source_repl_dsn", "dest_dsn")


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH) as f:
                data = json.load(f)
            merged = {**_defaults, **data}
            for field in _DSN_FIELDS:
                merged[field] = decrypt_dsn(merged.get(field, ""))
            return merged
        except Exception:
            pass
    return dict(_defaults)


def save_config(data: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    to_write = dict(data)
    for field in _DSN_FIELDS:
        to_write[field] = encrypt_dsn(to_write.get(field, ""))
    with open(CONFIG_PATH, "w") as f:
        json.dump(to_write, f, indent=2)
