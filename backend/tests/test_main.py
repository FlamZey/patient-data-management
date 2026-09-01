# Baseline browser-side security headers (see app.main.add_security_headers),
# checked once here at the app level rather than per-router -- they apply to
# every response through one piece of middleware, so a single hit (an
# unauthenticated one, so this doesn't depend on any router's own auth setup)
# is enough to prove the middleware is wired in.
def test_every_response_carries_the_baseline_security_headers(client):
    response = client.get("/health")

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Strict-Transport-Security"] == "max-age=63072000; includeSubDomains"


# ...including an error response, which is what actually matters most --
# an attacker-facing 404/401/500 is exactly the response a browser-side
# defense needs to be present on, not just the happy path.
def test_a_404_still_carries_the_baseline_security_headers(client):
    response = client.get("/this-route-does-not-exist")

    assert response.status_code == 404
    assert response.headers["X-Frame-Options"] == "DENY"
