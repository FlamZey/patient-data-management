import base64
import json
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from starlette.testclient import TestClient

from app.core.config import settings
from app.core.limiter import limiter
from app.routers import auth as auth_router
from app.core.security import create_access_token, decode_access_token, generate_refresh_token, hash_refresh_token
from app.main import app
from app.models import LoginLockout, RefreshToken
from tests.conftest import TEST_PASSWORD, TestingSessionLocal

# TestClient's default mock peer address -- what request.client.host reports
# for every call through the shared `client` fixture, and so what every
# LoginLockout row created in these tests is keyed on.
TESTCLIENT_IP = "testclient"


def _get_lockout(db_session, user, ip: str = TESTCLIENT_IP) -> LoginLockout | None:
    return (
        db_session.query(LoginLockout)
        .filter(LoginLockout.user_id == user.id, LoginLockout.ip_address == ip)
        .one_or_none()
    )


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
    # Success returns token and sets cookie.
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

    # Wrong password returns 401.
    def test_wrong_password_returns_401(self, client, active_user):
        resp = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid email or password"

    # Nonexistent email matches wrong password response.
    def test_nonexistent_email_matches_wrong_password_response(self, client, active_user):
        by_email = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
        by_password = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert by_email.status_code == by_password.status_code == 401
        assert by_email.json() == by_password.json()

    # ...and costs the same to produce. Matching the response body is only half
    # of not disclosing whether an account exists: skipping bcrypt for an
    # unknown email answered ~40x faster, so the timing alone classified any
    # address. Asserted as "a password verification happened" rather than as a
    # wall-clock comparison, which would be flaky under a loaded CI runner --
    # the hash is the ~200ms, so running it is what closes the gap.
    def test_nonexistent_email_still_verifies_a_password(self, client, active_user, monkeypatch):
        calls = []
        real_verify = auth_router.verify_password

        def counting_verify(plain: str, hashed: str) -> bool:
            calls.append(hashed)
            return real_verify(plain, hashed)

        monkeypatch.setattr(auth_router, "verify_password", counting_verify)

        resp = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})

        assert resp.status_code == 401
        assert len(calls) == 1, "unknown email short-circuited past the password check"
        assert calls[0] == auth_router._ABSENT_USER_PASSWORD_HASH

    # Fifth failure locks the account for this IP.
    def test_fifth_failure_locks_account(self, client, db_session, active_user):
        for _ in range(4):
            resp = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
            assert resp.status_code == 401

        resp = client.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert resp.status_code == 423

        lockout = _get_lockout(db_session, active_user)
        assert lockout is not None
        assert lockout.failed_login_count == 5
        assert lockout.locked_until is not None
        assert lockout.locked_until > datetime.now(timezone.utc)

    # Locked account rejects correct password too, from the locked-out IP.
    def test_locked_account_rejects_correct_password_too(self, client, db_session, active_user):
        db_session.add(
            LoginLockout(
                user_id=active_user.id,
                ip_address=TESTCLIENT_IP,
                failed_login_count=5,
                locked_until=datetime.now(timezone.utc) + timedelta(minutes=15),
            )
        )
        db_session.commit()

        resp = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 423

    # Expired lock allows login again.
    def test_expired_lock_allows_login_again(self, client, db_session, active_user):
        db_session.add(
            LoginLockout(
                user_id=active_user.id,
                ip_address=TESTCLIENT_IP,
                failed_login_count=5,
                locked_until=datetime.now(timezone.utc) - timedelta(minutes=1),
            )
        )
        db_session.commit()

        resp = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 200

        lockout = _get_lockout(db_session, active_user)
        assert lockout.failed_login_count == 0
        assert lockout.locked_until is None

    # Lockout is scoped to (account, IP), not the whole account -- the actual
    # point of this design: someone else's wrong guesses against your email,
    # from their own network, must never lock you out of your own login.
    # Uses a second TestClient with a different mock peer address rather than
    # a header (this app deliberately doesn't trust X-Forwarded-For -- see
    # limiter.py -- so a header wouldn't move the needle here anyway).
    def test_lockout_is_scoped_to_the_source_ip_not_the_whole_account(self, client, db_session, active_user):
        attacker = TestClient(app, client=("203.0.113.9", 12345))

        for _ in range(5):
            resp = attacker.post("/auth/login", json={"email": active_user.email, "password": "wrong-password"})
        assert resp.status_code == 423

        # The account is locked for the attacker's IP...
        attacker_lockout = _get_lockout(db_session, active_user, ip="203.0.113.9")
        assert attacker_lockout.locked_until is not None

        # ...but the real owner, from their own IP, was never touched by any
        # of that and logs in normally.
        resp = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 200
        assert _get_lockout(db_session, active_user, ip=TESTCLIENT_IP) is None

        # The attacker's own lockout is untouched by the owner's unrelated
        # success -- isolation runs both directions, not just one.
        db_session.refresh(attacker_lockout)
        assert attacker_lockout.locked_until is not None

    # Forces the exact race _record_login_failure's IntegrityError retry
    # exists for, deterministically rather than via real thread timing: a
    # second, independent session (TestingSessionLocal, not db_session --
    # a genuinely separate connection, the same way two concurrent requests
    # would each get their own session via get_db in production) inserts the
    # first-ever row for this (user, ip) pair in the gap between login()'s
    # own lookup (which would have found nothing) and its own insert
    # attempt. Reproduced live against the real server with 8 truly
    # concurrent requests before this fix existed: 6 of 8 came back 500.
    def test_record_login_failure_recovers_from_a_concurrent_insert(self, db_session, active_user):
        other_session = TestingSessionLocal()
        try:
            other_session.add(LoginLockout(user_id=active_user.id, ip_address="203.0.113.50", failed_login_count=1))
            other_session.commit()

            just_locked = auth_router._record_login_failure(
                db_session, active_user, "203.0.113.50", None, datetime.now(timezone.utc)
            )
            db_session.commit()

            assert just_locked is False
            lockout = _get_lockout(db_session, active_user, ip="203.0.113.50")
            # 1 from the other session, +1 from this call -- not overwritten,
            # not lost, not a crash.
            assert lockout.failed_login_count == 2
        finally:
            other_session.close()

    # Inactive user with correct password returns 403.
    def test_inactive_user_with_correct_password_returns_403(self, client, db_session, inactive_user):
        resp = client.post("/auth/login", json={"email": inactive_user.email, "password": TEST_PASSWORD})
        assert resp.status_code == 403
        assert resp.json()["detail"] == "User account is not active"
        assert "refresh_token" not in resp.cookies

        # A correct-password attempt on an inactive account never gets
        # anywhere near the failure path -- no lockout row should exist at all.
        assert _get_lockout(db_session, inactive_user) is None

    # Inactive user with wrong password still returns 401.
    def test_inactive_user_with_wrong_password_still_returns_401(self, client, inactive_user):
        """Status is only revealed once credentials are proven correct --
        a wrong password against an inactive account looks identical to a
        wrong password against an active one."""
        resp = client.post("/auth/login", json={"email": inactive_user.email, "password": "wrong-password"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid email or password"

    # Rate limited after ten requests per minute.
    def test_rate_limited_after_ten_requests_per_minute(self, client):
        for _ in range(10):
            resp = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
            assert resp.status_code == 401
        resp = client.post("/auth/login", json={"email": "nobody@example.com", "password": "whatever123"})
        assert resp.status_code == 429


class TestRefresh:
    # No cookie returns 401.
    def test_no_cookie_returns_401(self, client):
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    # Garbage cookie returns 401.
    def test_garbage_cookie_returns_401(self, client):
        client.cookies.set("refresh_token", "not-a-real-token")
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    # Expired token returns 401.
    def test_expired_token_returns_401(self, client, db_session, active_user):
        raw, _ = _issue_refresh_token(db_session, active_user, expires_in=timedelta(days=-1))
        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    # Revoked token returns 401.
    def test_revoked_token_returns_401(self, client, db_session, active_user):
        raw, _ = _issue_refresh_token(db_session, active_user, revoked=True)
        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    # Suspended account's token returns 401.
    def test_suspended_account_token_returns_401(self, client, db_session, inactive_user):
        """A refresh token stays valid on its own terms after its owner is
        suspended -- it isn't expired and nothing explicitly revoked it. Without
        rechecking the account here, a suspended user keeps rotating the cookie
        and minting access tokens indefinitely: get_current_user rejects each
        one, but the session never actually ends."""
        raw, _ = _issue_refresh_token(db_session, inactive_user)
        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    # Refusing a suspended account's token also revokes it, without rotating.
    def test_suspended_account_token_is_revoked_without_rotation(self, client, db_session, inactive_user):
        """Revoked rather than merely refused, so the cookie is dead even if the
        account is reactivated later.

        `revoked_at` alone would prove nothing -- a *successful* refresh also
        revokes the old token as part of rotation. What separates the two is
        `replaced_by` (set only by rotation) and whether a replacement row was
        issued at all."""
        raw, row = _issue_refresh_token(db_session, inactive_user)
        client.cookies.set("refresh_token", raw)
        client.post("/auth/refresh")

        db_session.refresh(row)
        assert row.revoked_at is not None
        assert row.replaced_by is None
        issued = db_session.query(RefreshToken).filter(RefreshToken.user_id == inactive_user.id).count()
        assert issued == 1, "a refused refresh must not mint a replacement token"

    # Deleting a user cascades their refresh tokens away.
    def test_deleting_a_user_cascades_their_refresh_tokens(self, client, db_session, active_user):
        """refresh_tokens.user_id is ON DELETE CASCADE, so a deleted account's
        tokens go with it and the lookup simply finds nothing. This is why
        /auth/refresh's own `user is None` branch is defensive rather than
        reachable through normal deletion."""
        raw, _ = _issue_refresh_token(db_session, active_user)
        user_id = active_user.id
        db_session.delete(active_user)
        db_session.commit()

        assert db_session.query(RefreshToken).filter(RefreshToken.user_id == user_id).count() == 0

        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/refresh")
        assert resp.status_code == 401

    # Valid token rotates and issues new access token.
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
    # No cookie still returns 204.
    def test_no_cookie_still_returns_204(self, client):
        resp = client.post("/auth/logout")
        assert resp.status_code == 204

    # Valid cookie revokes row and clears cookie.
    def test_valid_cookie_revokes_row_and_clears_cookie(self, client, db_session, active_user):
        raw, row = _issue_refresh_token(db_session, active_user)

        client.cookies.set("refresh_token", raw)
        resp = client.post("/auth/logout")
        assert resp.status_code == 204
        assert "Max-Age=0" in resp.headers.get("set-cookie", "")

        db_session.refresh(row)
        assert row.revoked_at is not None

    # Logout then refresh fails.
    def test_logout_then_refresh_fails(self, client, db_session, active_user):
        raw, _ = _issue_refresh_token(db_session, active_user)

        client.cookies.set("refresh_token", raw)
        logout_resp = client.post("/auth/logout")
        assert logout_resp.status_code == 204

        client.cookies.set("refresh_token", raw)
        refresh_resp = client.post("/auth/refresh")
        assert refresh_resp.status_code == 401

    # Unmatched cookie still returns 204.
    def test_unmatched_cookie_still_returns_204(self, client):
        client.cookies.set("refresh_token", "not-a-real-token")
        resp = client.post("/auth/logout")
        assert resp.status_code == 204

    # Double logout is a no op.
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
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.get("/auth/me")
        assert resp.status_code == 401

    # Expired token returns 401.
    def test_expired_token_returns_401(self, client):
        now = datetime.now(timezone.utc)
        expired = jwt.encode(
            {"sub": str(uuid.uuid4()), "iat": now - timedelta(minutes=20), "exp": now - timedelta(minutes=5)},
            settings.SECRET_KEY,
            algorithm=settings.ALGORITHM,
        )
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {expired}"})
        assert resp.status_code == 401

    # Valid token for deleted or unknown user returns 401.
    def test_valid_token_for_deleted_or_unknown_user_returns_401(self, client):
        token = create_access_token(uuid.uuid4())
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 401

    # Inactive user returns 403.
    def test_inactive_user_returns_403(self, client, inactive_user):
        token = create_access_token(inactive_user.id)
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403

    # Active user returns profile.
    def test_active_user_returns_profile(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["email"] == active_user.email
        assert body["role"]["name"] == "user"
        assert body["location"]["code"] == "US"
        assert "password_hash" not in body


class TestUpdateMe:
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.patch("/auth/me", json={"first_name": "New", "last_name": "Name"})
        assert resp.status_code == 401

    # Updates first and last name.
    def test_updates_first_and_last_name(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.patch(
            "/auth/me",
            json={"first_name": "Updated", "last_name": "Person"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["first_name"] == "Updated"
        assert body["last_name"] == "Person"

    # Cannot change fields outside the schema.
    def test_cannot_change_fields_outside_the_schema(self, client, active_user):
        """SelfProfileUpdate has no email/role/status field, so passing them
        is silently ignored (Pydantic drops unrecognized fields) instead of
        letting a user escalate their own access through this endpoint."""
        token = create_access_token(active_user.id)
        resp = client.patch(
            "/auth/me",
            json={
                "first_name": "Updated",
                "last_name": "Person",
                "email": "escalated@example.com",
                "status": "suspended",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["email"] == active_user.email
        assert body["status"] == "active"


class TestChangePassword:
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.post(
            "/auth/me/password", json={"current_password": TEST_PASSWORD, "new_password": "NewPass123!"}
        )
        assert resp.status_code == 401

    # Wrong current password returns 401.
    def test_wrong_current_password_returns_401(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.post(
            "/auth/me/password",
            json={"current_password": "wrong-password", "new_password": "NewPass123!"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    # Weak new password returns 422.
    @pytest.mark.parametrize("new_password", ["short", "NoSpecialChar1", "Aa1!" + "a" * 69])
    def test_weak_new_password_returns_422(self, client, active_user, new_password):
        token = create_access_token(active_user.id)
        resp = client.post(
            "/auth/me/password",
            json={"current_password": TEST_PASSWORD, "new_password": new_password},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422

    # Impossibly long current_password is rejected -- same 72-byte rule as everywhere else.
    def test_extremely_long_current_password_returns_422(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.post(
            "/auth/me/password",
            json={"current_password": "x" * 100_000, "new_password": "NewPass123!"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422

    # New password same as current returns 400.
    def test_new_password_same_as_current_returns_400(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.post(
            "/auth/me/password",
            json={"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 400

    # Success lets login with new password and rejects old.
    def test_success_lets_login_with_new_password_and_rejects_old(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.post(
            "/auth/me/password",
            json={"current_password": TEST_PASSWORD, "new_password": "NewPass123!"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 204

        new_login = client.post("/auth/login", json={"email": active_user.email, "password": "NewPass123!"})
        assert new_login.status_code == 200

        old_login = client.post("/auth/login", json={"email": active_user.email, "password": TEST_PASSWORD})
        assert old_login.status_code == 401

    # Success revokes existing refresh tokens.
    def test_success_revokes_existing_refresh_tokens(self, client, db_session, active_user):
        raw, row = _issue_refresh_token(db_session, active_user)
        token = create_access_token(active_user.id)

        resp = client.post(
            "/auth/me/password",
            json={"current_password": TEST_PASSWORD, "new_password": "NewPass123!"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 204

        db_session.refresh(row)
        assert row.revoked_at is not None

        client.cookies.set("refresh_token", raw)
        refresh_resp = client.post("/auth/refresh")
        assert refresh_resp.status_code == 401

    # Success clears refresh cookie.
    def test_success_clears_refresh_cookie(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.post(
            "/auth/me/password",
            json={"current_password": TEST_PASSWORD, "new_password": "NewPass123!"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert "Max-Age=0" in resp.headers.get("set-cookie", "")


class TestAuthAdversarial:
    """Bad-actor-shaped requests against the auth endpoints: tampered
    tokens, malformed bodies, SQLi-shaped input, refresh-token reuse."""

    # Tampered bearer token on me returns 401 not a 500.
    def test_tampered_token_on_me_returns_401(self, client, active_user):
        token = create_access_token(active_user.id)
        tampered = token[:-4] + ("A" if token[-4] != "A" else "B") + token[-3:]
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {tampered}"})
        assert resp.status_code == 401

    # None algorithm token is rejected not trusted.
    def test_none_algorithm_token_is_rejected(self, client, active_user):
        """Classic JWT alg-confusion payload: an unsigned token with
        alg=none and a valid-looking sub claim. decode_access_token pins
        algorithms=[settings.ALGORITHM] (HS256), so this must never be
        accepted as authentic."""
        header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).rstrip(b"=")
        payload = base64.urlsafe_b64encode(json.dumps({"sub": str(active_user.id)}).encode()).rstrip(b"=")
        forged = f"{header.decode()}.{payload.decode()}."
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {forged}"})
        assert resp.status_code == 401

    # Reusing a refresh token after it has been rotated returns 401.
    def test_reused_old_refresh_token_after_rotation_fails(self, client, db_session, active_user):
        raw, _ = _issue_refresh_token(db_session, active_user)

        client.cookies.set("refresh_token", raw)
        first = client.post("/auth/refresh")
        assert first.status_code == 200

        client.cookies.set("refresh_token", raw)
        replay = client.post("/auth/refresh")
        assert replay.status_code == 401

    # Malformed json body to login returns 422 not a 500.
    def test_malformed_json_body_to_login_returns_422(self, client):
        resp = client.post(
            "/auth/login", headers={"Content-Type": "application/json"}, content="{not valid json"
        )
        assert resp.status_code == 422

    # Missing password field on login returns 422.
    def test_missing_password_field_on_login_returns_422(self, client, active_user):
        resp = client.post("/auth/login", json={"email": active_user.email})
        assert resp.status_code == 422

    # Sql injection shaped email on login returns 422 not 401.
    def test_sql_injection_shaped_email_on_login_returns_422(self, client):
        """EmailStr validation rejects this before any DB query runs --
        Pydantic's format check, not a WHERE clause, is what stops it."""
        resp = client.post("/auth/login", json={"email": "' OR '1'='1", "password": "whatever123"})
        assert resp.status_code == 422

    # Password over the 72-byte limit is rejected before it's ever checked.
    def test_extremely_long_password_on_login_returns_422(self, client, active_user):
        resp = client.post("/auth/login", json={"email": active_user.email, "password": "x" * 100_000})
        assert resp.status_code == 422

    # Exactly 72 bytes is still accepted -- boundary is "more", not "72 or more".
    def test_password_at_exactly_72_bytes_on_login_still_checks_normally(self, client, active_user):
        password = "x" * 72
        assert len(password.encode("utf-8")) == 72
        resp = client.post("/auth/login", json={"email": active_user.email, "password": password})
        assert resp.status_code == 401  # reached the real check; just the wrong password

    # Unicode and emoji in updated profile name round trips unchanged.
    def test_unicode_and_emoji_profile_name_round_trips(self, client, active_user):
        token = create_access_token(active_user.id)
        resp = client.patch(
            "/auth/me",
            json={"first_name": "Zoë 🎉 名前", "last_name": "Müller-Østergård"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["first_name"] == "Zoë 🎉 名前"
        assert body["last_name"] == "Müller-Østergård"
