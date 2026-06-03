import json
import os
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("CONFIG_PATH", "/data/config.json"))

_defaults = {
    "source_dsn": "",
    "source_repl_dsn": "",
    "dest_dsn": "",
    "stats_refresh_interval": 10,
}


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH) as f:
                data = json.load(f)
                return {**_defaults, **data}
        except Exception:
            pass
    return dict(_defaults)


def save_config(data: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    # The DSN contains the password, but this file lives on a local volume
    # (not in the repo), so the full DSN is persisted as-is.
    with open(CONFIG_PATH, "w") as f:
        json.dump(data, f, indent=2)
