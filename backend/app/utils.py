import re


def mask_dsn(dsn: str) -> str:
    """Mask the password component of a PostgreSQL DSN before exposing it."""
    return re.sub(r'(:)[^:@]+(@)', r'\1***\2', dsn)
