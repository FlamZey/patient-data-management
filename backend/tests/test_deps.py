import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.core.config import settings
from app.core.deps import get_current_user, require_permission
from app.core.security import create_access_token
from app.models import Permission, RolePermission


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def _grant(db_session, role, permission):
    db_session.add(RolePermission(role_id=role.id, permission_id=permission.id))
    db_session.commit()


class TestGetCurrentUser:
    def test_no_credentials_raises_401(self, db_session):
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=None, db=db_session)
        assert exc_info.value.status_code == 401

    def test_garbage_token_raises_401(self, db_session):
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer("not-a-real-token"), db=db_session)
        assert exc_info.value.status_code == 401

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

    def test_tampered_token_raises_401(self, db_session):
        token = create_access_token(uuid.uuid4())
        tampered = token[:-1] + ("A" if token[-1] != "A" else "B")
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(tampered), db=db_session)
        assert exc_info.value.status_code == 401

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

    def test_valid_token_for_unknown_user_raises_401(self, db_session):
        token = create_access_token(uuid.uuid4())
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(token), db=db_session)
        assert exc_info.value.status_code == 401

    def test_inactive_user_raises_403(self, db_session, inactive_user):
        token = create_access_token(inactive_user.id)
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(credentials=_bearer(token), db=db_session)
        assert exc_info.value.status_code == 403

    def test_active_user_is_returned(self, db_session, active_user):
        token = create_access_token(active_user.id)
        result = get_current_user(credentials=_bearer(token), db=db_session)
        assert result.id == active_user.id
        assert result.email == active_user.email


class TestRequirePermission:
    def test_user_with_permission_passes_through(self, db_session, active_user, role):
        permission = Permission(code="patient.view", resource="patient", action="view")
        db_session.add(permission)
        db_session.commit()
        _grant(db_session, role, permission)
        db_session.refresh(active_user)

        check = require_permission("patient.view")
        result = check(current_user=active_user)
        assert result is active_user

    def test_user_without_permission_raises_403(self, db_session, active_user, role):
        permission = Permission(code="patient.view", resource="patient", action="view")
        db_session.add(permission)
        db_session.commit()
        _grant(db_session, role, permission)
        db_session.refresh(active_user)

        check = require_permission("patient.edit")
        with pytest.raises(HTTPException) as exc_info:
            check(current_user=active_user)
        assert exc_info.value.status_code == 403

    def test_user_with_no_permissions_at_all_raises_403(self, active_user):
        check = require_permission("patient.view")
        with pytest.raises(HTTPException) as exc_info:
            check(current_user=active_user)
        assert exc_info.value.status_code == 403

    def test_permission_codes_are_checked_independently(self, db_session, active_user, role):
        view_permission = Permission(code="patient.view", resource="patient", action="view")
        edit_permission = Permission(code="patient.edit", resource="patient", action="edit")
        db_session.add_all([view_permission, edit_permission])
        db_session.commit()
        _grant(db_session, role, view_permission)
        db_session.refresh(active_user)

        assert require_permission("patient.view")(current_user=active_user) is active_user
        with pytest.raises(HTTPException) as exc_info:
            require_permission("patient.edit")(current_user=active_user)
        assert exc_info.value.status_code == 403
