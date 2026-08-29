import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.core.config import settings
from app.core.deps import get_current_user, require_permission
from app.core.security import create_access_token


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


class TestGetCurrentUser:
    # No credentials raises 401.
    def test_no_credentials_raises_401(self, db_session):
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=None, db=db_session)
        assert exc_info.value.status_code == 401

    # Expired token raises 401.
    def test_expired_token_raises_401(self, db_session):
        now = datetime.now(timezone.utc)
        expired = jwt.encode(
            {"sub": str(uuid.uuid4()), "iat": now - timedelta(minutes=20), "exp": now - timedelta(minutes=5)},
            settings.SECRET_KEY,
            algorithm=settings.ALGORITHM,
        )
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(expired), db=db_session)
        assert exc_info.value.status_code == 401

    # Tampered token raises 401.
    def test_tampered_token_raises_401(self, db_session):
        """Flips a character 4 from the end, not the very last one -- see
        test_security.test_decode_tampered_token_raises for why flipping only
        the last base64url character can be a flaky no-op."""
        token = create_access_token(uuid.uuid4())
        tampered = token[:-4] + ("A" if token[-4] != "A" else "B") + token[-3:]
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(tampered), db=db_session)
        assert exc_info.value.status_code == 401

    # Malformed sub claim raises 401.
    def test_malformed_sub_claim_raises_401(self, db_session):
        now = datetime.now(timezone.utc)
        token = jwt.encode(
            {"sub": "not-a-uuid", "iat": now, "exp": now + timedelta(minutes=15)},
            settings.SECRET_KEY,
            algorithm=settings.ALGORITHM,
        )
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(token), db=db_session)
        assert exc_info.value.status_code == 401

    # Missing sub claim raises 401.
    def test_missing_sub_claim_raises_401(self, db_session):
        now = datetime.now(timezone.utc)
        token = jwt.encode(
            {"iat": now, "exp": now + timedelta(minutes=15)},
            settings.SECRET_KEY,
            algorithm=settings.ALGORITHM,
        )
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(token), db=db_session)
        assert exc_info.value.status_code == 401

    # Valid token for unknown user raises 401.
    def test_valid_token_for_unknown_user_raises_401(self, db_session):
        token = create_access_token(uuid.uuid4())
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(token), db=db_session)
        assert exc_info.value.status_code == 401

    # Inactive user raises 403.
    def test_inactive_user_raises_403(self, db_session, inactive_user):
        token = create_access_token(inactive_user.id)
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(token), db=db_session)
        assert exc_info.value.status_code == 403

    # Active user is returned.
    def test_active_user_is_returned(self, db_session, active_user):
        token = create_access_token(active_user.id)
        result = get_current_user(credentials=_bearer(token), db=db_session)
        assert result.id == active_user.id
        assert result.email == active_user.email


class TestRequirePermission:
    # User with permission passes through.
    def test_user_with_permission_passes_through(self, location, make_role, make_user):
        role = make_role("has-patient-view", ["patient.view"])
        user = make_user(role, location, email="has-view@example.com")

        check = require_permission("patient.view")
        result = check(current_user=user)
        assert result is user

    # User without permission raises 403.
    def test_user_without_permission_raises_403(self, location, make_role, make_user):
        role = make_role("view-only", ["patient.view"])
        user = make_user(role, location, email="view-only@example.com")

        check = require_permission("patient.edit")
        with pytest.raises(HTTPException) as exc_info:
            check(current_user=user)
        assert exc_info.value.status_code == 403

