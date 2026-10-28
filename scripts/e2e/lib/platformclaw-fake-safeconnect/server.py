#!/usr/bin/env python3
"""Deterministic SSH boundary fixture for PlatformClaw SafeConnect E2E."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import pwd
import signal
from pathlib import Path
from typing import Any

import asyncssh


STATE_DIR = Path(os.environ.get("FAKE_SAFECONNECT_STATE_DIR", "/state"))
ALLOCATIONS_PATH = Path(
    os.environ.get("FAKE_SAFECONNECT_ALLOCATIONS", "/fixture/allocations.json")
)
HOST_KEY_PATH = STATE_DIR / "ssh_host_ed25519_key"
HOST_KEY_METADATA_PATH = STATE_DIR / "host-key.json"
BOUNDARY_LOG_PATH = STATE_DIR / "boundary.jsonl"
AUTH_BEHAVIOR_PATH = STATE_DIR / "auth-behavior.json"


def append_event(event: str, **details: Any) -> None:
    payload = {"event": event, **details}
    with BOUNDARY_LOG_PATH.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")


def parse_composite_username(username: str) -> tuple[str, str, str, str] | None:
    domain, separator, remainder = username.partition("\\")
    fields = remainder.split("+")
    if not separator or not domain or len(fields) != 3 or not all(fields):
        return None
    return domain, fields[0], fields[1], fields[2]


def load_allocations() -> dict[str, dict[str, str]]:
    value = json.loads(ALLOCATIONS_PATH.read_text(encoding="utf-8"))
    allocations = value.get("allocations") if isinstance(value, dict) else None
    if not isinstance(allocations, list):
        raise RuntimeError("fixture allocations must be an array")
    result: dict[str, dict[str, str]] = {}
    for raw in allocations:
        if not isinstance(raw, dict):
            raise RuntimeError("fixture allocation must be an object")
        fields = {
            name: raw.get(name)
            for name in ("adDomain", "adAccount", "linuxAccount", "targetAddress", "password")
        }
        if not all(isinstance(item, str) and item for item in fields.values()):
            raise RuntimeError("fixture allocation fields must be non-empty strings")
        username = (
            f"{fields['adDomain']}\\{fields['adAccount']}+"
            f"{fields['linuxAccount']}+{fields['targetAddress']}"
        )
        result[username] = fields  # type: ignore[assignment]
    return result


ALLOCATIONS = load_allocations()


def authentication_behavior(username: str) -> dict[str, Any]:
    """Mutable synthetic fixture input, never a production authentication surface."""
    if not AUTH_BEHAVIOR_PATH.exists():
        return {}
    value = json.loads(AUTH_BEHAVIOR_PATH.read_text(encoding="utf-8"))
    behavior = value.get(username, {}) if isinstance(value, dict) else None
    if not isinstance(behavior, dict):
        raise RuntimeError("fixture authentication behavior must be an object")
    return behavior


class FakeSafeConnectServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        self._rejected_responses = 0
        parsed = parse_composite_username(username)
        append_event(
            "authentication_started",
            username=username,
            usernameFormatValid=parsed is not None,
        )
        return True

    def kbdint_auth_supported(self) -> bool:
        return True

    @staticmethod
    def _password_challenge() -> tuple[str, str, str, list[tuple[str, bool]]]:
        return "SSH Direct Connect", "", "en-US", [("Password:", False)]

    def get_kbdint_challenge(
        self, username: str, _lang: str, _submethods: str
    ) -> tuple[str, str, str, list[tuple[str, bool]]]:
        return self._password_challenge()

    def validate_kbdint_response(
        self, username: str, responses: list[str]
    ) -> bool | tuple[str, str, str, list[tuple[str, bool]]]:
        allocation = ALLOCATIONS.get(username)
        behavior = authentication_behavior(username)
        accepted = (
            allocation is not None
            and len(responses) == 1
            and hmac.compare_digest(responses[0], behavior.get("password", allocation["password"]))
        )
        append_event("authentication_finished", username=username, accepted=accepted)
        if accepted:
            return True
        self._rejected_responses += 1
        if behavior.get("finalRejection") is True:
            return False
        return self._password_challenge() if self._rejected_responses == 1 else False


async def handle_process(process: asyncssh.SSHServerProcess[bytes]) -> None:
    username = process.get_extra_info("username")
    allocation = ALLOCATIONS.get(username)
    command = process.command
    if allocation is None or (command is not None and not isinstance(command, str)):
        append_event("command_rejected", username=username, reason="invalid_session")
        process.exit(126)
        return

    linux_account = allocation["linuxAccount"]
    account = pwd.getpwnam(linux_account)
    shell = account.pw_shell or "/bin/bash"
    if command:
        encoded_command = command.encode("utf-8")
        append_event(
            "command_started",
            username=username,
            linuxAccount=linux_account,
            commandBytes=len(encoded_command),
            commandSha256=hashlib.sha256(encoded_command).hexdigest(),
        )
        forced_exit = authentication_behavior(username).get("commandExit")
        if forced_exit is not None:
            if not isinstance(forced_exit, int) or not 0 <= forced_exit <= 255:
                raise RuntimeError("fixture command exit must be an integer from 0 to 255")
            process.stderr.write(b"fixture@remote: Permission denied (keyboard-interactive).\n")
            append_event("command_finished", username=username, linuxAccount=linux_account, exitStatus=forced_exit)
            process.exit(forced_exit)
            return
        argv = ["/bin/bash", "-c", command]
    else:
        # Real sshd starts the account login shell when no command is supplied.
        # Keep the fixture interactive so browser-terminal proof exercises that path.
        append_event("login_shell_started", username=username, linuxAccount=linux_account)
        argv = [shell, "-il"]
    child = await asyncio.create_subprocess_exec(
        *argv,
        cwd=account.pw_dir,
        env={
            "HOME": account.pw_dir,
            "LANG": "C.UTF-8",
            "LOGNAME": linux_account,
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "SHELL": shell,
            "TERM": process.get_terminal_type() or "xterm-256color",
            "USER": linux_account,
        },
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        user=account.pw_uid,
        group=account.pw_gid,
        extra_groups=(),
        start_new_session=True,
    )
    assert child.stdin is not None and child.stdout is not None and child.stderr is not None

    async def forward_input() -> None:
        try:
            while chunk := await process.stdin.read(64 * 1024):
                child.stdin.write(chunk)
                await child.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # The command may finish before its client finishes sending input.
        finally:
            child.stdin.close()

    async def forward_output(
        source: asyncio.StreamReader, destination: asyncssh.SSHWriter[bytes]
    ) -> None:
        while chunk := await source.read(64 * 1024):
            destination.write(chunk)
            await destination.drain()

    input_task = asyncio.create_task(forward_input())
    # Per-pipe EOF must not become SSH-channel EOF: OpenSSH multiplexed clients
    # otherwise return 255 before receiving the command's actual exit status.
    completion = asyncio.gather(
        forward_output(child.stdout, process.stdout),
        forward_output(child.stderr, process.stderr),
        child.wait(),
    )
    disconnected = asyncio.create_task(process.wait_closed())
    completed = False
    try:
        done, _ = await asyncio.wait(
            (completion, disconnected), return_when=asyncio.FIRST_COMPLETED
        )
        if completion not in done:
            return
        await completion
        completed = True
        return_code = child.returncode
        assert return_code is not None
        append_event(
            "command_finished",
            username=username,
            linuxAccount=linux_account,
            exitStatus=return_code,
        )
        if return_code < 0:
            process.exit_with_signal(signal.Signals(-return_code).name.removeprefix("SIG"))
        else:
            process.exit(return_code)
    finally:
        if not completed:
            # The fixture lacks CAP_KILL. Signal the whole command group as its
            # account so disconnected shells cannot leave descendants running.
            cleanup = await asyncio.create_subprocess_exec(
                "/bin/bash", "-c", 'kill -KILL -- "-$1"', "cleanup", str(child.pid),
                user=account.pw_uid, group=account.pw_gid, extra_groups=(),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await cleanup.wait()
            await child.wait()
        for task in (input_task, completion, disconnected):
            task.cancel()
        await asyncio.gather(input_task, completion, disconnected, return_exceptions=True)


def prepare_host_key() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not HOST_KEY_PATH.exists():
        key = asyncssh.generate_private_key("ssh-ed25519")
        key.write_private_key(HOST_KEY_PATH)
        os.chmod(HOST_KEY_PATH, 0o600)
    key = asyncssh.read_private_key(HOST_KEY_PATH)
    algorithm, public_key, *_ = key.export_public_key("openssh").decode("ascii").split()
    HOST_KEY_METADATA_PATH.write_text(
        json.dumps(
            {
                "algorithm": algorithm,
                "publicKey": public_key,
                "fingerprint": key.get_fingerprint("sha256"),
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    BOUNDARY_LOG_PATH.touch()


async def main() -> None:
    prepare_host_key()
    await asyncssh.create_server(
        FakeSafeConnectServer,
        "0.0.0.0",
        44422,
        server_host_keys=[str(HOST_KEY_PATH)],
        process_factory=handle_process,
        encoding=None,
        password_auth=False,
        public_key_auth=False,
        kbdint_auth=True,
    )
    append_event("server_ready", port=44422)
    await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
