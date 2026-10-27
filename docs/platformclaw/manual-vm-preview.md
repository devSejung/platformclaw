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
2. Sign in as `admin.user` and open **Settings > Administration > VM administration**.
3. Register the endpoint and host key printed by the launcher.
4. Register three target VMs: `10.0.0.10`, `10.0.0.20`, and `10.0.0.30`.
5. Sign out and sign in as `person.one`.
6. Open **Work location**, select the registered VM, keep the default Linux
   account `person.one`, and enter the printed Fake AD password. The allocation
   is created only after the connection test succeeds.
7. Confirm the verified VM becomes the current location. Register VM2 and VM3
   using the fixture values below; each registration activates the verified VM
   without visiting Basic. All three cards remain in **Work location**.
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

### Verify saved VM switching

The synthetic employee `person.one` can register these independent Linux homes:

| VM  | Target      | Linux account    | Fixture AD password                             |
| --- | ----------- | ---------------- | ----------------------------------------------- |
| VM1 | `10.0.0.10` | `person_one`     | `platformclaw-safeconnect-fixture-password`     |
| VM2 | `10.0.0.20` | `person_one_vm2` | `platformclaw-safeconnect-fixture-vm2-password` |
| VM3 | `10.0.0.30` | `person_one_vm3` | `platformclaw-safeconnect-fixture-vm3-password` |

After registration, switch VM1 → VM2 → VM3 → VM1, then Basic → VM2. Confirm
the progress animation names its actual source and destination, and only the
confirmed server target receives the current-location badge. Reload and sign in
again; all saved cards must remain. Save distinct Coding Agent settings per VM
and confirm they return with that VM. Switching does not copy workspace files.

While VM1 is active, reconnect VM2 with an intentionally wrong password: VM1
must stay active and usable. Also try a switch during an Agent run, a queued
turn or its preparation, a cron run, and a turn using a warm ACP session. These
cases must block switching; checking only a visible chat run is insufficient.
During a pending switch, try starting new work and confirm it receives a retry
error. Verify a stale revision and a duplicate request cannot activate a second
target. After a successful switch, the old browser terminal closes and the next
ACP process belongs to the new VM.

Create a pending Skill Workshop proposal on VM1, switch to VM2, and confirm that
VM2 cannot evaluate, revise, or apply the VM1 proposal. Return to VM1 and exercise
that same proposal. Its durable registration binding must survive the new
runtime allocation, while SSH still uses the new allocation and credential
revisions. Also attempt a switch during Workshop SSH access or apply: its
workspace coordinator must exclude the switch, and a stale access handle must
fail visibly. Neither case may write to Basic or a different VM.

As administrator, rename the enabled SafeConnect endpoint. Refresh both the
administration and Work location pages; the new label must appear while its
approved fingerprint and running Agent remain unchanged. Revoke an inactive
saved connection and confirm the active VM is untouched and the removed
connection does not return after refresh. Check dark mode, long VM labels,
keyboard navigation, and the system reduced-motion preference.

Saved registrations use additive tables without a control schema version bump.
When testing an upgrade with a disposable existing database, confirm the live
allocation imports once with its original durable target ID and that removed
registrations remain absent after reopening. An older build supporting the same
base schema can read the current runtime projection but cannot manage inactive saved connections; select Basic
and retain the matching database/key backup before a rollback test. These are
verification scenarios, not a claim that this preview has passed them.

## Verify uploaded attachments

For an embedded Agent using a VM, workspace-staged inbound files are prepared
through the filesystem bridge belonging to that run's selected execution target
before the Agent starts. The Gateway and VM keep the same workspace-relative
path, such as `media/inbound/<stored-file-name>`. Their absolute workspace roots
do not have to match. This is attachment publication, not workspace mirroring:
existing project files and Agent edits on the VM are not overwritten.

Test the following with disposable files and a configured model provider:

1. Select a text-only primary model and configure a separate `imageModel`.
   Attach a PNG, then ask the Agent to inspect it with the `image` tool. Check
   that the file exists under the VM workspace and the tool returns an analysis.
   The Gateway reads the image bytes through the VM bridge and sends those bytes
   to the image provider; the provider never opens the VM path directly.
2. Attach a CSV, a small PDF, and a binary fixture in the same turn. Read the CSV
   and inspect the other files using appropriate VM tools. Compare the binary
   checksum with the uploaded fixture, including files with spaces or non-ASCII
   characters in their names. The publication step is independent of file type;
   it does not make every format a valid image-model input.
3. Repeat with a native-vision primary model and a mixed image/document turn.
   Inline vision input remains available, and the image's managed file identity
   also reaches workspace staging for subsequent file-tool calls.
4. Submit different payloads with the same displayed filename in queued turns.
   Each turn must keep its own bytes and recorded path. When a stored name
   actually collides with different content, Gateway staging chooses an isolated
   `openclaw-staged-<id>` subdirectory instead of replacing the earlier snapshot.
5. Edit an already published file on the VM, then retry the same staged input.
   The existing regular VM file must be reused rather than reset to the Gateway
   original. A directory or unsafe path at the destination must fail closed.
6. Interrupt a publication or make the VM destination unwritable. The run must
   report a sandbox provisioning error before model execution; model fallback
   must not disguise a transfer failure. Restore access and retry. Files already
   published successfully must remain intact.

The existing inbound workspace-staging limit is **5 MiB per file**. This is
separate from upload and model-specific limits; files not admitted to workspace
staging do not become VM files through this mechanism. Switching execution
locations does not migrate a session's entire attachment history or workspace.
The current run's staged inputs are checked against its actual target, so a
publication on a previous VM is not treated as proof that another VM has them.

## Verify generated downloads and work location changes

Use disposable files in both **Basic workspace** and **My development VM**:

1. Ask the Agent to create a small report in its working directory and attach it.
   Download the file card and compare the bytes with the report on that target.
2. Repeat with a file created under shell `$TMPDIR`, then with an account-owned
   regular file under `/tmp`. Use the ordinary read, write, and edit tools on
   both temporary paths. A symlink, hardlink, another UID's file, or a file
   over the configured attachment limit must fail visibly.
3. Submit a queued turn, then try changing **Work location**. The change must be
   refused until that turn finishes or is cancelled. Retry the change afterward.
4. Create a differently valued report with the same filename on the other target.
   Ask for a new attachment. New downloads must contain the new target's bytes;
   the earlier attachment must still contain the original copy.
5. Reload the conversation and download both attachments again. The Agent's next
   turn must name the current location, workspace, and temporary directory.
6. Sign out and sign in as a different fixture employee in the same browser.
   A network request for the first employee's media URL must be denied, and the
   app must use download URLs scoped to the new login. Include an image cached
   by an older version: the app must not reuse its cache key after the login
   changes. Cache clearing is best effort on supported secure browser contexts;
   it cannot guarantee erasure of bytes already displayed or decoded.

These checks exercise Fake SafeConnect and Linux file ownership. They do not
establish enterprise-network reachability or validate production credentials.

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
