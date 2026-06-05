"""
Symmetric encryption for DSN passwords stored on disk.

A Fernet key is generated once and saved to /data/secret.key (same volume as
config.json / profiles.json).  All DSN strings are encrypted before writing
and decrypted after reading.  The frontend always receives / sends plaintext
DSNs — encryption is purely at-rest on the server volume.

Fernet = AES-128-CBC + HMAC-SHA256, authenticated encryption.
"""

import os
import sys
from pathlib import Path
from cryptography.fernet import Fernet, InvalidToken

def _default_key_path() -> Path:
    """Return a sensible default for SECRET_KEY_PATH on any OS."""
    env = os.environ.get("SECRET_KEY_PATH")
    if env:
        return Path(env)
    # On Windows fall back to a 'data' directory next to the app package,
    # not the Linux-only /data path.
    if sys.platform == "win32":
        base = Path(__file__).resolve().parent.parent.parent  # repo root
        return base / "data" / "secret.key"
    return Path("/data/secret.key")

KEY_PATH = _default_key_path()


def _load_or_create_key() -> bytes:
    if KEY_PATH.exists():
        return KEY_PATH.read_bytes().strip()
    key = Fernet.generate_key()
    KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    KEY_PATH.write_bytes(key)
    # restrict permissions: owner read-only
    try:
        KEY_PATH.chmod(0o600)
    except Exception:
        pass
    return key


def _fernet() -> Fernet:
    return Fernet(_load_or_create_key())


def encrypt_dsn(dsn: str) -> str:
    """Return base64-encoded ciphertext, or '' for empty input."""
    if not dsn:
        return ""
    return _fernet().encrypt(dsn.encode()).decode()


def decrypt_dsn(value: str) -> str:
    """Decrypt ciphertext back to plaintext DSN.

    Returns the value unchanged if it looks like a plaintext DSN (migration
    path: files written before encryption was introduced still work).
    """
    if not value:
        return ""
    # Plain DSNs start with postgresql:// or postgres://
    if value.startswith(("postgresql://", "postgres://")):
        return value
    try:
        return _fernet().decrypt(value.encode()).decode()
    except (InvalidToken, Exception):
        # Corrupt / wrong key — return as-is so the UI can show the error
        return value
