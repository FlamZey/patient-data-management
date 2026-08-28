"""Prints a fresh random string for SECRET_KEY.

Run this to generate a value for local setup or to rotate the active secret:

    python scripts/generate_secret_key.py

Add the printed value to SECRET_KEY in .env. Rotating it invalidates every
outstanding JWT (access and refresh), signing all holders out.
"""

import secrets

if __name__ == "__main__":
    print(secrets.token_urlsafe(32))
