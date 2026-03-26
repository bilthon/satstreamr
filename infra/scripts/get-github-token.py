#!/usr/bin/env python3
"""
Generate a GitHub App installation access token.
Usage: python3 get-github-token.py <app_id> <installation_id> <private_key_path>
Prints the token to stdout.
"""
import base64
import json
import sys
import time
import urllib.request
import urllib.error

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(app_id: int, private_key_pem: bytes) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": app_id}).encode())
    signing_input = f"{header}.{payload}".encode()

    private_key = serialization.load_pem_private_key(private_key_pem, password=None)
    signature = b64url(private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256()))
    return f"{header}.{payload}.{signature}"


def get_installation_token(app_id: int, installation_id: int, private_key_path: str) -> str:
    with open(private_key_path, "rb") as f:
        private_key_pem = f.read()

    jwt_token = make_jwt(app_id, private_key_pem)

    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {jwt_token}",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "satstreamr-bot/1.0",
        },
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data["token"]


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <app_id> <installation_id> <private_key_path>", file=sys.stderr)
        sys.exit(1)
    app_id = int(sys.argv[1])
    installation_id = int(sys.argv[2])
    private_key_path = sys.argv[3]
    print(get_installation_token(app_id, installation_id, private_key_path))
