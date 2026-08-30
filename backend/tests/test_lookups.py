import pytest

from app.models import Location, Role, Team


@pytest.fixture
def lookup_headers(location, make_role, make_user, auth_headers):
    """These lookups back the user-management dropdowns and column filters,
    so they require user.view -- being merely authenticated is no longer
    enough (see TestLookupPermissions below)."""
    role = make_role("lookup-reader", ["user.view"])
    return auth_headers(make_user(role, location, email="lookup-reader@example.com"))


class TestListRoles:
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.get("/roles")
        assert resp.status_code == 401

    # Returns active roles only.
    def test_returns_active_roles_only(self, client, db_session, role, lookup_headers):
        inactive_role = Role(name="retired", display_name="Retired", is_active=False)
        db_session.add(inactive_role)
        db_session.commit()

        resp = client.get("/roles", headers=lookup_headers)
        assert resp.status_code == 200
        names = {row["name"] for row in resp.json()}
        assert role.name in names
        assert "retired" not in names


class TestListLocations:
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.get("/locations")
        assert resp.status_code == 401

    # Returns active locations only.
    def test_returns_active_locations_only(self, client, db_session, location, lookup_headers):
        inactive_location = Location(code="ZZ", name="Nowhere", is_active=False)
        db_session.add(inactive_location)
        db_session.commit()

        resp = client.get("/locations", headers=lookup_headers)
        assert resp.status_code == 200
        codes = {row["code"] for row in resp.json()}
        assert location.code in codes
        assert "ZZ" not in codes


class TestListTeams:
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.get("/teams")
        assert resp.status_code == 401

    # Returns active teams only.
    def test_returns_active_teams_only(self, client, db_session, lookup_headers):
        active_team = Team(code="AR", name="Accounts Receivable")
        inactive_team = Team(code="ZZ", name="Defunct Team", is_active=False)
        db_session.add_all([active_team, inactive_team])
        db_session.commit()

        resp = client.get("/teams", headers=lookup_headers)
        assert resp.status_code == 200
        codes = {row["code"] for row in resp.json()}
        assert "AR" in codes
        assert "ZZ" not in codes


class TestLookupPermissions:
    """These endpoints used to require only authentication, which let an
    account holding no permissions at all enumerate the org structure and --
    via /roles' embedded permission list -- the entire authorization model."""

    @pytest.mark.parametrize("path", ["/roles", "/locations", "/teams"])
    # Authenticated but without user.view returns 403.
    def test_authenticated_without_user_view_gets_403(self, client, path, active_user, auth_headers):
        resp = client.get(path, headers=auth_headers(active_user))
        assert resp.status_code == 403

    # Roles lookup no longer exposes each role's permission grants.
    def test_roles_lookup_omits_permission_grants(self, client, db_session, lookup_headers, make_role):
        make_role("privileged", ["user.view", "user.delete", "role.assign"])

        resp = client.get("/roles", headers=lookup_headers)
        assert resp.status_code == 200
        assert resp.json(), "expected at least one role in the lookup"
        for row in resp.json():
            assert "permissions" not in row
