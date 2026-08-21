import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.core.security import create_access_token, hash_password
from app.database import Base, get_db
from app.main import app
from app.models import Location, Permission, Role, RolePermission, User

TEST_DATABASE_URL = "postgresql://user:password@db:5432/test_appdb"
TEST_PASSWORD = "ValidPass123!"

engine = create_engine(TEST_DATABASE_URL)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="function")
def db_session():
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def client(db_session):
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def role(db_session):
    role = Role(name="user", display_name="User")
    db_session.add(role)
    db_session.commit()
    return role


@pytest.fixture
def location(db_session):
    location = Location(code="US", name="United States")
    db_session.add(location)
    db_session.commit()
    return location


@pytest.fixture
def active_user(db_session, role, location):
    user = User(
        email="active@example.com",
        username="active-user",
        password_hash=hash_password(TEST_PASSWORD),
        first_name="Active",
        last_name="User",
        role_id=role.id,
        location_id=location.id,
        status="active",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def make_role(db_session):
    """Factory fixture: make_role(name, permission_codes=()) -> Role,
    creating/reusing Permission rows and granting them via RolePermission."""

    def _make_role(name, permission_codes=()):
        role = Role(name=name, display_name=name.title())
        db_session.add(role)
        db_session.flush()

        for code in permission_codes:
            resource, action = code.split(".", 1)
            permission = db_session.query(Permission).filter(Permission.code == code).one_or_none()
            if permission is None:
                permission = Permission(code=code, resource=resource, action=action)
                db_session.add(permission)
                db_session.flush()
            db_session.add(RolePermission(role_id=role.id, permission_id=permission.id))

        db_session.commit()
        return role

    return _make_role


@pytest.fixture
def make_user(db_session):
    """Factory fixture: make_user(role, location, email=...) -> active User."""

    def _make_user(role, location, *, email):
        user = User(
            email=email,
            username=email.split("@")[0],
            password_hash=hash_password(TEST_PASSWORD),
            first_name="Test",
            last_name="User",
            role_id=role.id,
            location_id=location.id,
            status="active",
        )
        db_session.add(user)
        db_session.commit()
        db_session.refresh(user)
        return user

    return _make_user


@pytest.fixture
def auth_headers():
    def _auth_headers(user):
        return {"Authorization": f"Bearer {create_access_token(user.id)}"}

    return _auth_headers


@pytest.fixture
def inactive_user(db_session, role, location):
    user = User(
        email="inactive@example.com",
        username="inactive-user",
        password_hash=hash_password(TEST_PASSWORD),
        first_name="Inactive",
        last_name="User",
        role_id=role.id,
        location_id=location.id,
        status="suspended",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user