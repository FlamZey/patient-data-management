import type { NextConfig } from "next";

// Baseline browser-side defenses, mirrored on the backend (see
// backend/app/main.py's add_security_headers) so both origins this app
// serves from carry the same set. Safe to send unconditionally even over
// plain HTTP in local dev -- a browser only honors Strict-Transport-Security
// on a connection that's already HTTPS, so it's a no-op until this is
// actually deployed behind one.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
