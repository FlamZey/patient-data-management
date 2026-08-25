"""Field-level AES-256-GCM encryption for patient PHI."""

import base64
import secrets
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

NONCE_SIZE_BYTES = 12


class DecryptionError(Exception):
    """Raised when a token is malformed, tampered with, or uses an unknown key version."""


@lru_cache(maxsize=None)
def _cipher_for_version(version: int) -> AESGCM:
    """Cached because encrypt_field/decrypt_field call this per field, per row --
    a bulk upload of thousands of rows would otherwise re-decode the same static
    key from settings and reconstruct an identical AESGCM object on every single
    call. The key never changes at runtime (it's process config, only updated by
    a restart), so caching by version is safe -- a version genuinely not found
    raises and is never cached, so a config fix takes effect without a restart."""
    try:
        encoded_key = settings.PATIENT_ENCRYPTION_KEYS[version]
    except KeyError:
        raise DecryptionError(f"Unknown encryption key version: {version}") from None
    return AESGCM(base64.b64decode(encoded_key))


def encrypt_field(plaintext: str) -> str:
    """Encrypts with the active key version. Returns "v{version}:{nonce}:{ciphertext}",
    with nonce and ciphertext base64-encoded. Uses a fresh random nonce every call."""
    version = settings.PATIENT_ENCRYPTION_ACTIVE_VERSION
    cipher = _cipher_for_version(version)
    nonce = secrets.token_bytes(NONCE_SIZE_BYTES)
    ciphertext = cipher.encrypt(nonce, plaintext.encode("utf-8"), None)
    return (
        f"v{version}:"
        f"{base64.b64encode(nonce).decode('utf-8')}:"
        f"{base64.b64encode(ciphertext).decode('utf-8')}"
    )


def decrypt_field(token: str) -> str:
    """Parses the version prefix and decrypts with that version's key, so data
    encrypted under a since-rotated-out key stays readable. Raises DecryptionError
    on a malformed token, an unknown key version, or a failed auth tag check
    (tampered/corrupted ciphertext)."""
    try:
        version_part, nonce_part, ciphertext_part = token.split(":", 2)
        if not version_part.startswith("v"):
            raise ValueError
        version = int(version_part[1:])
        nonce = base64.b64decode(nonce_part)
        ciphertext = base64.b64decode(ciphertext_part)
    except ValueError:
        raise DecryptionError("Malformed encrypted field token") from None

    cipher = _cipher_for_version(version)
    try:
        plaintext = cipher.decrypt(nonce, ciphertext, None)
    except InvalidTag:
        raise DecryptionError("Failed to decrypt field: authentication tag mismatch") from None
    return plaintext.decode("utf-8")
