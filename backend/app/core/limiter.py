"""Shared rate limiter instance for the application."""

from slowapi import Limiter
from slowapi.util import get_remote_address

# TODO once behind a proxy or running >1 process (not true today):
# keys by direct TCP peer, so a proxy makes everyone share one bucket; and
# counts live in this process's memory, so multiple workers/replicas each
# get their own limit. Fix: --proxy-headers --forwarded-allow-ips=<proxy>,
# plus storage_uri=<redis>.
limiter = Limiter(key_func=get_remote_address)
