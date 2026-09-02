# Every response carries the baseline security headers from app.main.add_security_headers.
def test_every_response_carries_the_baseline_security_headers(client):
    """Checked once at the app level, via one unauthenticated hit, since the
    headers come from middleware that applies to every response regardless
    of router."""
    response = client.get("/health")

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Strict-Transport-Security"] == "max-age=63072000; includeSubDomains"


# A 404 still carries the baseline security headers.
def test_a_404_still_carries_the_baseline_security_headers(client):
    """An attacker-facing error response is exactly where a browser-side
    defense needs to be present, not just on the happy path."""
    response = client.get("/this-route-does-not-exist")

    assert response.status_code == 404
    assert response.headers["X-Frame-Options"] == "DENY"
