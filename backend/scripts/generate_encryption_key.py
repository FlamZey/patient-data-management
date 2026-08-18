"""Prints a fresh base64-encoded 32-byte key for PATIENT_ENCRYPTION_KEYS.

Run this to provision a new key version or to rotate the active version:

    python scripts/generate_encryption_key.py

Add the printed value to PATIENT_ENCRYPTION_KEYS under a new version number,
then bump PATIENT_ENCRYPTION_ACTIVE_VERSION once ready to write with it.
Keep old versions in the map so previously encrypted fields stay decryptable.
"""

import base64
import secrets

if __name__ == "__main__":
    print(base64.b64encode(secrets.token_bytes(32)).decode("utf-8"))
