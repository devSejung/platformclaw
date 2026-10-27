"""Regression coverage for directory fields crossing the local auth mock."""

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "mock_employee_auth.py"
SPEC = importlib.util.spec_from_file_location("mock_employee_auth", SCRIPT)
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)

ORG = {
    "version": 1,
    "source": "aicm",
    "updatedAt": "2026-10-20T01:00:00Z",
    "team": "Engineering",
    "group": {"id": "platform", "name": "Platform"},
    "part": {"id": "runtime", "name": "Runtime"},
}
SECRET = b"local-mock-regression-secret-32-bytes"


class EmployeeAuthMockTest(unittest.TestCase):
    def account(self, **fields):
        return auth.normalize_account({**auth.DEFAULT_ACCOUNTS[0], **fields})

    def login(self, account):
        args = argparse.Namespace(
            login_path="/login", adsso_path="/adsso/login", health_path="/healthz",
            bearer_token="", platformclaw_origin=None,
        )
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), auth.build_handler(args, [account], None)
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            body = json.dumps({
                "identifier": account["identifier"], "password": account["password"]
            })
            connection.request("POST", "/login", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            return json.loads(response.read())
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

    def sso_payload(self, account):
        with patch.object(auth.time, "time", return_value=1_700_000_000):
            token = auth.build_adsso_token(account, SECRET)
        encoded, signature = token.split(".")
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        actual = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        expected = hmac.new(SECRET, payload, hashlib.sha256).digest()
        self.assertTrue(hmac.compare_digest(actual, expected))
        return json.loads(payload)

    def test_password_http_preserves_explicit_directory_fields_without_credentials(self):
        for is_test in (False, True):
            with self.subTest(isTestAccount=is_test):
                response = self.login(self.account(org=ORG, isTestAccount=is_test))
                self.assertTrue(response["authenticated"])
                self.assertEqual(response["org"], ORG)
                self.assertIs(response["isTestAccount"], is_test)
                self.assertNotIn("identifier", response)
                self.assertNotIn("password", response)

    def test_signed_sso_preserves_explicit_directory_fields(self):
        for is_test in (False, True):
            with self.subTest(isTestAccount=is_test):
                payload = self.sso_payload(self.account(org=ORG, isTestAccount=is_test))
                self.assertEqual(payload["org"], ORG)
                self.assertIs(payload["isTestAccount"], is_test)
                self.assertNotIn("password", payload)

    def test_legacy_profiles_do_not_fabricate_organization_or_test_flag(self):
        for account in auth.load_accounts(None):
            for profile in (auth.public_profile(account), self.sso_payload(account)):
                self.assertNotIn("org", profile)
                self.assertNotIn("isTestAccount", profile)
                self.assertEqual(profile["department"], account["department"])
                self.assertEqual(profile["part"], account["part"])

    def test_explicit_invalid_org_remains_for_canonical_downstream_validation(self):
        for org in (None, "invalid", {**ORG, "source": "untrusted"}):
            with self.subTest(org=org):
                account = self.account(org=org)
                self.assertEqual(account["org"], org)
                self.assertEqual(self.sso_payload(account)["org"], org)


if __name__ == "__main__":
    unittest.main()
