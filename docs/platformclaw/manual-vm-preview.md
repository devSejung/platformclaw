---
summary: "Exercise the complete PlatformClaw VM setup flow locally with Docker and Fake SafeConnect"
read_when:
  - Manually testing VM registration, credentials, connection checks, and execution switching
  - Preparing a PlatformClaw build for enterprise VM validation
title: "Manual VM preview"
---

# Manual VM preview

Use the manual VM preview before taking PlatformClaw into the enterprise
network. It runs the real Docker runtime, browser UI, credential encryption and
broker, SSH backend, rootless sandbox daemon, and a deterministic Fake
SafeConnect service. Only employee authentication and the external SafeConnect
boundary are synthetic.

The preview does not pre-register a VM. This deliberately preserves the same
administrator and employee steps that must be checked in the enterprise
environment.

## Start on Windows

Start Docker Desktop in Linux-container mode. From a PowerShell window in the
repository, run:

```powershell
.\scripts\platformclaw-vm-preview.ps1
```

Choose **Start or resume**. The launcher builds images for the exact current Git
commit when they are missing, starts the stack, opens the login page, and prints
all disposable fixture values. The first image build can take a while; later
starts reuse images only when their immutable Docker image IDs match the clean
commit manifest recorded by this launcher.

The launcher refuses a dirty source checkout so an accidental local edit or a
cached dirty image cannot be mistaken for the merged build. Use the separate
Windows main preview for an intentional short UI development loop.

Use another browser profile or sign out between the two roles:

| Role          | Account      | Password        |
| ------------- | ------------ | --------------- |
| Administrator | `admin.user` | `test-password` |
| Employee      | `person.one` | `test-password` |

## Manual scenario

1. Sign in once as `person.one`, then sign out. This provisions the employee's
   personal Agent.
2. Sign in as `admin.user` and open **VM administration** from the profile
   menu.
3. Register the endpoint and host key printed by the launcher.
4. Register target VM `10.0.0.10`.
5. Sign out and sign in as `person.one`.
6. Open **Work location**, select the registered VM, keep the default Linux
   account `person.one`, and enter the printed Fake AD password. The allocation
   is created only after the connection test succeeds.
7. Change the work location to **Personal VM**.
8. If a model provider is configured, start a chat and ask the Agent to run
   `whoami`, `pwd`, create and read `relative-proof.txt`, then create and read
   `~/home-proof.txt`. Confirm the relative file is under the remote workspace
   and the home proof is directly under the remote home. The remote home is
   `/users/person_one`; the remote workspace is
   `/users/person_one/.platformclaw/workspace`. The connection test and target
   switch themselves do not require a model provider.
9. Ask the Agent to remember a harmless unique marker. Confirm memory search
   returns it from the Agent corpus and that no matching `memory/*.md` file was
   created in the VM workspace or VM home. Trigger a conversation long enough
   for pre-compaction maintenance when practical and repeat the same ownership
   check.
10. Run several more short commands. Filter Gateway logs for
    `platformclaw_ssh_master` and `platformclaw_ssh_lease`; exactly one master
    authentication should be followed by `reused=true` lease events.
11. Change back to the PlatformClaw managed environment and confirm the location
    badge changes without an automatic file sync.

Also check one intentional failure: enter any wrong AD password first. The UI
must reject it without switching execution location. No real employee account,
password, hostname, or internal address is used by this preview.

The save-time connection probe is a fresh one-shot authentication because the
new credential is not trusted until this check passes. TCP setup keeps its
five-second limit; authentication plus the remote identity command has a
15-second overall limit. Gateway logs
`platformclaw_vm_connection_test_timing` for diagnosing slow enterprise paths.

## Stop, inspect, and reset

```powershell
# Stop containers but preserve registrations and encrypted fixture credentials.
.\scripts\platformclaw-vm-preview.ps1 -Action Stop

# Resume the same state.
.\scripts\platformclaw-vm-preview.ps1 -Action Start

# Inspect service state or recent logs.
.\scripts\platformclaw-vm-preview.ps1 -Action Status
.\scripts\platformclaw-vm-preview.ps1 -Action Logs

# Remove containers, volumes, credentials, registrations, and workspaces.
.\scripts\platformclaw-vm-preview.ps1 -Action Reset
```

The launcher binds the browser service to `127.0.0.1` only. Disposable state is
kept outside the repository under
`%LOCALAPPDATA%\PlatformClaw\vm-preview`. Linux Docker remains the final runtime
authority; this fake boundary proves the product flow, not enterprise network
reachability or the approved production host key.
