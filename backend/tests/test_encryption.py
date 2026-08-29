import base64

import pytest

from app.core import encryption
from app.core.config import settings


# Encrypt decrypt roundtrip.
def test_encrypt_decrypt_roundtrip():
    plaintext = "123-45-6789"
    token = encryption.encrypt_field(plaintext)
    assert token != plaintext
    assert encryption.decrypt_field(token) == plaintext


# Encrypt uses fresh nonce each call.
def test_encrypt_uses_fresh_nonce_each_call():
    token_a = encryption.encrypt_field("same value")
    token_b = encryption.encrypt_field("same value")
    assert token_a != token_b


# Tampered ciphertext raises.
def test_tampered_ciphertext_raises():
    token = encryption.encrypt_field("sensitive data")
    version_part, nonce_part, ciphertext_part = token.split(":", 2)
    ciphertext = bytearray(base64.b64decode(ciphertext_part))
    ciphertext[0] ^= 0xFF
    tampered = f"{version_part}:{nonce_part}:{base64.b64encode(bytes(ciphertext)).decode('utf-8')}"
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field(tampered)


# Unicode content roundtrip.
def test_unicode_content_roundtrip():
    plaintext = "José García — ، 你好"
    token = encryption.encrypt_field(plaintext)
    assert encryption.decrypt_field(token) == plaintext


# Empty string roundtrip.
def test_empty_string_roundtrip():
    token = encryption.encrypt_field("")
    assert encryption.decrypt_field(token) == ""


# Decrypt with rotated out key version still works.
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


# Unknown key version raises.
def test_unknown_key_version_raises():
    token = encryption.encrypt_field("value")
    version_part, nonce_part, ciphertext_part = token.split(":", 2)
    bogus_token = f"v9999:{nonce_part}:{ciphertext_part}"
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field(bogus_token)


# Malformed token raises.
def test_malformed_token_raises():
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field("not-a-valid-token")


# Tampered nonce raises.
def test_tampered_nonce_raises():
    token = encryption.encrypt_field("sensitive data")
    version_part, nonce_part, ciphertext_part = token.split(":", 2)
    nonce = bytearray(base64.b64decode(nonce_part))
    nonce[0] ^= 0xFF
    tampered = f"{version_part}:{base64.b64encode(bytes(nonce)).decode('utf-8')}:{ciphertext_part}"
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field(tampered)


# Truncated token missing a segment raises instead of crashing.
def test_truncated_token_missing_segment_raises():
    with pytest.raises(encryption.DecryptionError):
        encryption.decrypt_field("v1:onlyonesegment")


# Emoji content roundtrip.
def test_emoji_content_roundtrip():
    plaintext = "🎉🏥💊 patient note"
    token = encryption.encrypt_field(plaintext)
    assert encryption.decrypt_field(token) == plaintext


# Very long string roundtrip.
def test_very_long_string_roundtrip():
    plaintext = "A" * 500_000
    token = encryption.encrypt_field(plaintext)
    assert encryption.decrypt_field(token) == plaintext
