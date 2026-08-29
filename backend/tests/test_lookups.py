from app.models import Location, Role, Team


class TestListRoles:
    # No auth header returns 401.
    def test_no_auth_header_returns_401(self, client):
        resp = client.get("/roles")
        assert resp.status_code == 401

    # Returns active roles only.
    def test_returns_active_roles_only(self, client, db_session, active_user, role, auth_headers):
        inactive_role = Role(name="retired", display_name="Retired", is_active=False)
        db_session.add(inactive_role)
        db_session.commit()

        resp = client.get("/roles", headers=auth_headers(active_user))
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
    def test_returns_active_locations_only(self, client, db_session, active_user, location, auth_headers):
        inactive_location = Location(code="ZZ", name="Nowhere", is_active=False)
        db_session.add(inactive_location)
        db_session.commit()

        resp = client.get("/locations", headers=auth_headers(active_user))
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
    def test_returns_active_teams_only(self, client, db_session, active_user, auth_headers):
        active_team = Team(code="AR", name="Accounts Receivable")
        inactive_team = Team(code="ZZ", name="Defunct Team", is_active=False)
        db_session.add_all([active_team, inactive_team])
        db_session.commit()

        resp = client.get("/teams", headers=auth_headers(active_user))
        assert resp.status_code == 200
        codes = {row["code"] for row in resp.json()}
        assert "AR" in codes
        assert "ZZ" not in codes
