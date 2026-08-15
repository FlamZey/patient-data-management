import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.core.config import settings
from app.core.limiter import limiter
from app.core.security import create_access_token, decode_access_token, generate_refresh_token, hash_refresh_token
from app.models import RefreshToken
from tests.conftest import TEST_PASSWORD


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    limiter.reset()
    yield


def _issue_refresh_token(db_session, user, *, expires_in=timedelta(days=7), revoked=False):
    raw = generate_refresh_token()
    row = RefreshToken(
        user_id=user.id,
        token_hash=hash_refresh_token(raw),
        expires_at=datetime.now(timezone.utc) + expires_in,
        revoked_at=datetime.now(timezone.utc) if revoked else None,
    )
    db_session.add(row)
    db_session.commit()
    return raw, row


class TestLogin:
    def test_success_returns_token_and_sets_cookie(self, client, active_user):
        resp = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 200
        body = resp.json()
        assert body["token_type"] == "bearer"
        assert body["expires_in"] == settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
        assert "access_token" in body
        assert "refresh_token" in resp.cookies

        payload = decode_access_token(body["access_token"])
        assert payload["sub"] == str(active_user.id)

    def test_wrong_password_returns_401(self, client, active_user):
        resp = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid email or password"

    def test_nonexistent_email_matches_wrong_password_response(self, client, active_user):
        by_email = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
        by_password = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert by_email.status_code == by_password.status_code == 401
        assert by_email.json() == by_password.json()

    def test_fifth_failure_locks_account(self, client, db_session, active_user):
        for _ in range(4):
            resp = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
            assert resp.status_code == 401

        resp = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert resp.status_code == 423

        db_session.refresh(active_user)
        assert active_user.failed_login_count == 5
        assert active_user.locked_until is not None
        assert active_user.locked_until > datetime.now(timezone.utc)

    def test_locked_account_rejects_correct_password_too(self, client, db_session, active_user):
        active_user.failed_login_count = 5
        active_user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=15)
        db_session.commit()

        resp = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 423

    def test_expired_lock_allows_login_again(self, client, db_session, active_user):
        active_user.failed_login_count = 5
        active_user.locked_until = datetime.now(timezone.utc) - timedelta(minutes=1)
        db_session.commit()

        resp = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 200

        db_session.refresh(active_user)
        assert active_user.failed_login_count == 0

    def test_inactive_user_with_correct_password_returns_403(self, client, db_session, inactive_user):
        resp = client.post("/auth/login", json={"email": inactive_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 403
        assert resp.json()["detail"] == "User account is not active"
        assert "refresh_token" not in resp.cookies

        db_session.refresh(inactive_user)
        assert inactive_user.failed_login_count == 0

    def test_inactive_user_with_wrong_password_still_returns_401(self, client, inactive_user):
        """Status is only revealed once credentials are proven correct --
        a wrong password against an inactive account looks identical to a
        wrong password against an active one."""
        resp = client.post("/auth/login", json={"email": inactive_user.email, "password": "wrong-password"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid email or password"

    def test_rate_limited_after_ten_requests_per_minute(self, client):
        for _ in range(10):
            resp = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
            assert resp.status_code == 401
        resp = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
        assert resp.status_code == 429


class TestRefresh:
    def test_no_cookie_returns_401(self, client):
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    def test_garbage_cookie_returns_401(self, client):
        client.cookies.set("refresh_token", "not-a-real-token")
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    def test_expired_token_returns_401(self, client, db_session, active_user):
        raw, _ = _issue_refresh_token(db_session, active_user, expires_in=timedelta(days=-1))
        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    def test_revoked_token_returns_401(self, client, db_session, active_user):
        raw, _ = _issue_refresh_token(db_session, active_user, revoked=True)
        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    def test_valid_token_rotates_and_issues_new_access_token(self, client, db_session, active_user):
        raw, old_row = _issue_refresh_token(db_session, active_user)

        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 200

        payload = decode_access_token(resp.json()["access_token"])
        assert payload["sub"] == str(active_user.id)

        new_raw = resp.cookies.get("refresh_token")
        assert new_raw is not None
        assert new_raw != raw

        db_session.refresh(old_row)
        assert old_row.revoked_at is not None
        assert old_row.replaced_by is not None


class TestLogout:
    def test_no_cookie_still_returns_204(self, client):
        resp = client.post("/auth/logout")
        assert resp.status_code == 204

    def test_valid_cookie_revokes_row_and_clears_cookie(self, client, db_session, active_user):
        raw, row = _issue_refresh_token(db_session, active_user)

        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/logout")
        assert resp.status_code == 204
        assert "Max-Age=0" in resp.headers.get("set-cookie", "")

        db_session.refresh(row)
        assert row.revoked_at is not None

    def test_unmatched_cookie_still_returns_204(self, client):
        client.cookies.set("refresh_token", "not-a-real-token")
        resp = client.post("/auth/logout")
        assert resp.status_code == 204

    def test_double_logout_is_a_no_op(self, client, db_session, active_user):
        raw, row = _issue_refresh_token(db_session, active_user)

        client.cookies.set("refresh_token", raw)
        first = client.post("/auth/logout")
        assert first.status_code == 204

        db_session.refresh(row)
        first_revoked_at = row.revoked_at
        assert first_revoked_at is not None

        client.cookies.set("refresh_token", raw)
        second = client.post("/auth/logout")
        assert second.status_code == 204

        db_session.refresh(row)
        assert row.revoked_at == first_revoked_at


class TestMe:
    def test_no_auth_header_returns_401(self, client):
        resp = client.get("/auth/me")
        assert resp.status_code == 401

    def test_expired_token_returns_401(self, client):
        now = datetime.now(timezone.utc)
        expired = jwt.encode(
            {"sub": str(uuid.uuid4()), "iat": now - timedelta(minutes=20), "exp": now - timedelta(minutes=5)},
            settings.SECRET_KEY,
            algorithm=settings.ALGORITHM,
        )
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {expired}"})
        assert resp.status_code == 401

    def test_valid_token_for_deleted_or_unknown_user_returns_401(self, client):
        token = create_access_token(uuid.uuid4())
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 401

    def test_inactive_user_returns_403(self, client, inactive_user):
        token = create_access_token(inactive_user.id)
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403

    def test_active_user_returns_profile(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["email"] == active_user.email
        assert body["role"]["name"] == "user"
        assert body["location"]["code"] == "US"
        assert "password_hash" not in body
