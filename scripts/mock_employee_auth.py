#!/usr/bin/env python3
"""Local employee-auth mock for PlatformClaw browser login development."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit


DEFAULT_ACCOUNTS = [
    {
        "identifier": "person.one",
        "password": "test-password",
        "employeeId": "person.one",
        "accountId": "person.one",
        "subject": "ldap:person.one",
        "displayName": "Person One",
        "email": "person.one@example.test",
        "department": "Platform",
        "part": "Agent Platform",
        "confluenceSpace": "PLATFORM",
        "notes": "Local PlatformClaw test account",
        "groups": ["developers", "platform"],
        "attributes": {"title": "Engineer", "costCenters": ["A100"]},
    },
    {
        "identifier": "admin.user",
        "password": "test-password",
        "employeeId": "1002",
        "accountId": "admin.user",
        "subject": "ldap:admin.user",
        "displayName": "Admin User",
        "email": "admin.user@example.test",
        "department": "Platform",
        "part": "Operations",
        "groups": ["platform-admins"],
        "attributes": {"title": "Administrator"},
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PlatformClaw employee-auth mock")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--login-path", default="/login")
    parser.add_argument("--adsso-path", default="/adsso/login")
    parser.add_argument("--adsso-secret-file")
    parser.add_argument("--platformclaw-origin")
    parser.add_argument("--health-path", default="/healthz")
    parser.add_argument("--accounts-file")
    parser.add_argument("--bearer-token", default="")
    return parser.parse_args()


def optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def normalize_account(raw: dict[str, Any]) -> dict[str, Any]:
    identifier = optional_string(raw.get("identifier"))
    password = raw.get("password")
    employee_id = optional_string(raw.get("employeeId"))
    account_id = optional_string(raw.get("accountId"))
    if not identifier or not isinstance(password, str) or not password:
        raise ValueError("each mock account requires identifier and password")
    if not employee_id or not account_id:
        raise ValueError(f"mock account {identifier} requires employeeId and accountId")
    groups = raw.get("groups", [])
    attributes = raw.get("attributes", {})
    return {
        "identifier": identifier,
        "password": password,
        "employeeId": employee_id,
        "accountId": account_id,
        "subject": optional_string(raw.get("subject")) or f"ldap:{account_id}",
        "displayName": optional_string(raw.get("displayName") or raw.get("name")),
        "email": optional_string(raw.get("email")),
        "department": optional_string(raw.get("department")),
        "part": optional_string(raw.get("part")),
        "confluenceSpace": optional_string(raw.get("confluenceSpace")),
        "notes": optional_string(raw.get("notes") or raw.get("note")),
        "groups": groups if isinstance(groups, list) else [],
        "attributes": attributes if isinstance(attributes, dict) else {},
    }


def load_accounts(path: str | None) -> list[dict[str, Any]]:
    if not path:
        return [normalize_account(account) for account in DEFAULT_ACCOUNTS]
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    raw_accounts = payload.get("accounts") if isinstance(payload, dict) else payload
    if not isinstance(raw_accounts, list) or not raw_accounts:
        raise ValueError("accounts file must contain a non-empty accounts array")
    accounts = [normalize_account(account) for account in raw_accounts if isinstance(account, dict)]
    if not accounts:
        raise ValueError("accounts file contains no valid account records")
    return accounts


def public_profile(account: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in account.items()
        if key not in {"identifier", "password"} and value is not None
    }


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def build_adsso_token(account: dict[str, Any], secret: bytes) -> str:
    issued_at = int(time.time())
    account_id = account["accountId"]
    payload = {
        "contractVersion": 1,
        "kind": "sso",
        "issuer": "platformclaw-auth",
        "audience": "platformclaw",
        "authMethod": "saml",
        "employeeId": account_id,
        "name": account.get("displayName"),
        "email": account.get("email"),
        "department": account.get("department"),
        "part": account.get("part"),
        "confluenceSpace": account.get("confluenceSpace"),
        "agentId": account_id.replace(".", "_"),
        "sessionKey": f"agent:{account_id.replace('.', '_')}:main",
        "iat": issued_at,
        "exp": issued_at + 60,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret, payload_bytes, hashlib.sha256).digest()
    return f"{base64url(payload_bytes)}.{base64url(signature)}"


def build_handler(
    args: argparse.Namespace,
    accounts: list[dict[str, Any]],
    adsso_secret: bytes | None,
):
    accounts_by_identifier = {account["identifier"].lower(): account for account in accounts}

    class Handler(BaseHTTPRequestHandler):
        server_version = "PlatformClawEmployeeAuthMock/2.0"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def read_json(self) -> dict[str, Any] | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return None
            if length < 0 or length > 64 * 1024:
                return None
            try:
                value = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return None
            return value if isinstance(value, dict) else None

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == args.adsso_path and adsso_secret and args.platformclaw_origin:
                token = build_adsso_token(accounts[0], adsso_secret)
                callback = (
                    f"{args.platformclaw_origin.rstrip('/')}"
                    f"/employee/auth/sso-callback?token={quote(token, safe='')}"
                )
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", callback)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path != args.health_path:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "message": "not found"})
                return
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "service": "platformclaw-employee-auth-mock",
                    "loginPath": args.login_path,
                    "adssoPath": args.adsso_path if adsso_secret else None,
                    "accounts": [
                        {
                            "identifier": account["identifier"],
                            "employeeId": account["employeeId"],
                            "accountId": account["accountId"],
                        }
                        for account in accounts
                    ],
                },
            )

        def do_POST(self) -> None:
            if self.path != args.login_path:
                self.send_json(
                    HTTPStatus.NOT_FOUND,
                    {"authenticated": False, "message": "not found"},
                )
                return
            if args.bearer_token:
                expected = f"Bearer {args.bearer_token}"
                if self.headers.get("Authorization", "") != expected:
                    self.send_json(
                        HTTPStatus.UNAUTHORIZED,
                        {"authenticated": False, "message": "invalid bearer token"},
                    )
                    return
            payload = self.read_json()
            if payload is None:
                self.send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"authenticated": False, "message": "invalid JSON payload"},
                )
                return
            identifier = optional_string(payload.get("identifier") or payload.get("username"))
            password = payload.get("password")
            account = accounts_by_identifier.get((identifier or "").lower())
            if not account or password != account["password"]:
                self.send_json(
                    HTTPStatus.UNAUTHORIZED,
                    {"authenticated": False, "message": "invalid credentials"},
                )
                return
            self.send_json(
                HTTPStatus.OK,
                {"authenticated": True, **public_profile(account)},
            )

    return Handler


def main() -> int:
    args = parse_args()
    if bool(args.adsso_secret_file) != bool(args.platformclaw_origin):
        raise ValueError("--adsso-secret-file and --platformclaw-origin must be configured together")
    adsso_secret = (
        Path(args.adsso_secret_file).read_text(encoding="utf-8").strip().encode("utf-8")
        if args.adsso_secret_file
        else None
    )
    if adsso_secret is not None and len(adsso_secret) < 32:
        raise ValueError("ADSSO mock secret must contain at least 32 bytes")
    accounts = load_accounts(args.accounts_file)
    server = ThreadingHTTPServer(
        (args.bind, args.port), build_handler(args, accounts, adsso_secret)
    )
    actual_port = int(server.server_address[1])
    print(
        json.dumps(
            {
                "bind": args.bind,
                "port": actual_port,
                "loginUrl": f"http://{args.bind}:{actual_port}{args.login_path}",
                "adssoUrl": (
                    f"http://{args.bind}:{actual_port}{args.adsso_path}"
                    if adsso_secret
                    else None
                ),
                "healthUrl": f"http://{args.bind}:{actual_port}{args.health_path}",
                "environment": {
                    "PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL": (
                        f"http://{args.bind}:{actual_port}{args.login_path}"
                    ),
                    "PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL": (
                        f"http://{args.bind}:{actual_port}{args.adsso_path}"
                        if adsso_secret
                        else None
                    ),
                },
            }
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
