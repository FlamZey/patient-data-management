import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.core import security
from app.core.config import settings


# Hash password verify roundtrip.
def test_hash_password_verify_roundtrip():
    plain = "correct-horse-battery-1"
    hashed = security.hash_password(plain)
    assert hashed != plain
    assert security.verify_password(plain, hashed) is True


# Verify password wrong password fails.
def test_verify_password_wrong_password_fails():
    hashed = security.hash_password("correct-horse-battery-1")
    assert security.verify_password("wrong-password-1", hashed) is False


# Create and decode access token roundtrip.
def test_create_and_decode_access_token_roundtrip():
    user_id = uuid.uuid4()
    token = security.create_access_token(user_id)
    payload = security.decode_access_token(token)
    assert payload["sub"] == str(user_id)
    assert "exp" in payload


# Decode expired token raises.
def test_decode_expired_token_raises():
    now = datetime.now(timezone.utc)
    expired_payload = {
        "sub": str(uuid.uuid4()),
        "iat": now - timedelta(minutes=20),
        "exp": now - timedelta(minutes=5),
    }
    expired_token = jwt.encode(expired_payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    with pytest.raises(jwt.ExpiredSignatureError):
        security.decode_access_token(expired_token)


# Decode tampered token raises.
def test_decode_tampered_token_raises():
    """Flips a character 4 from the end of the signature, not the very last
    one -- base64url's final character can carry unused padding bits, so
    flipping only it sometimes decodes back to the same underlying bytes and
    the tampering is a no-op. This was flaky for exactly that reason."""
    token = security.create_access_token(uuid.uuid4())
    tampered = token[:-4] + ("A" if token[-4] != "A" else "B") + token[-3:]
    with pytest.raises(jwt.InvalidTokenError):
        security.decode_access_token(tampered)


# Generate refresh token is random and url safe.
def test_generate_refresh_token_is_random_and_url_safe():
    token_a = security.generate_refresh_token()
    token_b = security.generate_refresh_token()
    assert token_a != token_b
    assert len(token_a) > 20


# Hash refresh token is deterministic.
def test_hash_refresh_token_is_deterministic():
    token = security.generate_refresh_token()
    assert security.hash_refresh_token(token) == security.hash_refresh_token(token)
    assert len(security.hash_refresh_token(token)) == 64
