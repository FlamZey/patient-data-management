"""Shared rate limiter instance for the application."""

from slowapi import Limiter
from slowapi.util import get_remote_address

# TODO once behind a proxy or running >1 process: keys by direct TCP peer (a
# proxy makes everyone share one bucket), and limits live in this process's
# memory (each worker gets its own). Fix: --proxy-headers
# --forwarded-allow-ips=<proxy>, plus storage_uri=<redis>.
limiter = Limiter(key_func=get_remote_address)
