#!/usr/bin/env python3
"""Real SSH regression coverage; run inside the SafeConnect fixture image."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

import asyncssh


class NoAuthentication(asyncssh.SSHServer):
    def begin_auth(self, _username):
        return False


class ProcessTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="safeconnect-regression-")
        root = Path(self.directory.name)
        allocations = root / "allocations.json"
        allocations.write_text(json.dumps({"allocations": [{
            "adDomain": "test", "adAccount": "test", "linuxAccount": "person_one",
            "targetAddress": "test", "password": "synthetic-test-value",
        }]}))
        spec = importlib.util.spec_from_file_location("fixture_server", Path(__file__).with_name("server.py"))
        self.server = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {
            "FAKE_SAFECONNECT_STATE_DIR": str(root),
            "FAKE_SAFECONNECT_ALLOCATIONS": str(allocations),
        }):
            spec.loader.exec_module(self.server)
        self.finished = asyncio.Queue()

        async def handle(process):
            try:
                await self.server.handle_process(process)
            finally:
                self.finished.put_nowait(None)

        self.listener = await asyncssh.create_server(
            NoAuthentication, "127.0.0.1", 0,
            server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
            process_factory=handle, encoding=None,
        )
        self.connection = await asyncssh.connect(
            "127.0.0.1", self.listener.get_port(), username="test\\test+person_one+test",
            known_hosts=None,
        )

    async def asyncTearDown(self):
        self.connection.close()
        await self.connection.wait_closed()
        self.listener.close()
        await self.listener.wait_closed()
        self.directory.cleanup()

    async def run_python(self, script):
        result = await asyncio.wait_for(self.connection.run(
            "python3 -c " + shlex.quote(script), input=b"", encoding=None,
        ), 3)
        await asyncio.wait_for(self.finished.get(), 3)
        return result

    async def test_both_pipe_eof_orders_preserve_large_output_and_exit_status(self):
        for closed, remaining, status in ((1, 2, 0), (2, 1, 0), (1, 2, 19), (2, 1, 19)):
            with self.subTest(closed=closed, status=status):
                result = await self.run_python(
                    "import os; "
                    f"os.close({closed}); "
                    f"os.write({remaining}, b'x' * (2 * 1024 * 1024)); "
                    f"os._exit({status})"
                )
                self.assertEqual(result.exit_status, status)
                self.assertEqual(result.stdout, b"x" * (2 * 1024 * 1024) if remaining == 1 else b"")
                self.assertEqual(result.stderr, b"x" * (2 * 1024 * 1024) if remaining == 2 else b"")

    async def test_input_is_streamed_before_eof_then_closed(self):
        script = "import sys; print('ready', flush=True); [print(line.strip().upper(), flush=True) for line in sys.stdin]"
        process = await self.connection.create_process(
            "python3 -u -c " + shlex.quote(script), encoding=None,
        )
        self.assertEqual(await asyncio.wait_for(process.stdout.readline(), 3), b"ready\n")
        process.stdin.write(b"hello\n")
        await process.stdin.drain()
        self.assertEqual(await asyncio.wait_for(process.stdout.readline(), 3), b"HELLO\n")
        process.stdin.write_eof()
        result = await asyncio.wait_for(process.wait(), 3)
        await asyncio.wait_for(self.finished.get(), 3)
        self.assertEqual(result.exit_status, 0)

    async def test_login_shell_still_accepts_input(self):
        process = await self.connection.create_process(encoding=None)
        process.stdin.write(b"printf 'login-shell-ok\\n'; exit 7\n")
        result = await asyncio.wait_for(process.wait(), 3)
        await asyncio.wait_for(self.finished.get(), 3)
        self.assertEqual(result.stdout, b"login-shell-ok\n")
        self.assertEqual(result.exit_status, 7)

    async def test_disconnect_reaps_command_and_stops_its_descendants(self):
        process = await self.connection.create_process("sleep 100 & printf '%s %s\\n' $$ $!; wait", encoding=None)
        pids = [int(value) for value in (await asyncio.wait_for(process.stdout.readline(), 3)).split()]
        process.close()
        await asyncio.wait_for(process.wait_closed(), 3)
        await asyncio.wait_for(self.finished.get(), 3)
        self.assertFalse(Path(f"/proc/{pids[0]}").exists())
        descendant = Path(f"/proc/{pids[1]}/stat")
        # Container PID 1 may defer reaping an orphan, but it must no longer run.
        self.assertTrue(not descendant.exists() or descendant.read_text().split()[2] == "Z")


if __name__ == "__main__":
    unittest.main()
