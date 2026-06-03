from .persistence import load_config, save_config
import sys

_cfg = load_config()
source_dsn: str = _cfg["source_dsn"]
source_repl_dsn: str = _cfg.get("source_repl_dsn", "")
dest_dsn: str = _cfg["dest_dsn"]
stats_refresh_interval: int = _cfg["stats_refresh_interval"]


def persist():
    mod = sys.modules[__name__]
    save_config({
        "source_dsn": mod.source_dsn,
        "source_repl_dsn": mod.source_repl_dsn,
        "dest_dsn": mod.dest_dsn,
        "stats_refresh_interval": mod.stats_refresh_interval,
    })
