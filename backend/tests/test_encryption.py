import base64

import pytest

from app.core import encryption
from app.core.config import settings


def test_encrypt_decrypt_roundtrip():
    plaintext = "123-45-6789"
    token = encryption.encrypt_field(plaintext)
    assert token != plaintext
    assert encryption.decrypt_field(token) == plaintext


def test_encrypt_uses_fresh_nonce_each_call():
    token_a = encryption.encrypt_field("same value")
    token_b = encryption.encrypt_field("same value")
    assert token_a != token_b


def test_tampered_ciphertext_raises():
    token = encryption.encrypt_field("sensitive data")
    version_part, nonce_part, ciphertext_part = token.split(":", 2)
    ciphertext = bytearray(base64.b64decode(ciphertext_part))
    ciphertext[0] ^= 0xFF
    tampered = f"{version_part}:{nonce_part}:{base64.b64encode(bytes(ciphertext)).decode('utf-8')}"
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field(tampered)


def test_unicode_content_roundtrip():
    plaintext = "José García — ، 你好"
    token = encryption.encrypt_field(plaintext)
    assert encryption.decrypt_field(token) == plaintext


def test_empty_string_roundtrip():
    token = encryption.encrypt_field("")
    assert encryption.decrypt_field(token) == ""


def test_decrypt_with_rotated_out_key_version_still_works(monkeypatch):
    old_version = settings.PATIENT_ENCRYPTION_ACTIVE_VERSION
    old_key = settings.PATIENT_ENCRYPTION_KEYS[old_version]

    token = encryption.encrypt_field("archived value")

    new_version = old_version + 1
    monkeypatch.setitem(
        settings.PATIENT_ENCRYPTION_KEYS,
        new_version,
        base64.b64encode(b"1" * 32).decode("utf-8"),
    )
    monkeypatch.setattr(settings, "PATIENT_ENCRYPTION_ACTIVE_VERSION", new_version)

    assert settings.PATIENT_ENCRYPTION_KEYS[old_version] == old_key
    assert encryption.decrypt_field(token) == "archived value"

    new_token = encryption.encrypt_field("fresh value")
    assert new_token.startswith(f"v{new_version}:")
    assert encryption.decrypt_field(new_token) == "fresh value"


def test_unknown_key_version_raises():
    token = encryption.encrypt_field("value")
    version_part, nonce_part, ciphertext_part = token.split(":", 2)
    bogus_token = f"v9999:{nonce_part}:{ciphertext_part}"
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field(bogus_token)


def test_malformed_token_raises():
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field("not-a-valid-token")
