import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildRemoteCommand,
  buildSshSandboxArgv,
  resolvePreferredOpenClawTmpDir,
  sanitizeEnvVars,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const SKILL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const SKILL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/** Private script constant also gives Linux-focused tests the exact production encoder. */
export const VM_REMOTE_SKILL_EXPORT_PYTHON = String.raw`
import contextlib
import fcntl
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile

MAX_ARCHIVE = 500 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_ENTRY = 250 * 1024 * 1024
MAX_MARKDOWN = 256 * 1024
MAX_FILES = 100
MAX_DEPTH = 16
CHUNK = 64 * 1024
EXCLUDED_DIRS = {
    '.git', '.hg', '.svn', '.clawhub', '.clawdhub', '.openclaw', '.ssh',
    'node_modules', '__pycache__',
}
EXCLUDED_FILES = {
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'authorized_keys',
    'known_hosts', 'credentials', 'credentials.json', 'secrets', 'secrets.json',
}
EXCLUDED_SUFFIXES = (
    '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt', '.cer',
    '.cert', '.der',
)
DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
FILE_FLAGS = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)


def excluded(name, directory):
    lowered = name.lower()
    return (
        (directory and lowered in EXCLUDED_DIRS)
        or (not directory and (
            lowered == '.env'
            or lowered.startswith('.env.')
            or lowered in EXCLUDED_FILES
            or lowered.endswith(EXCLUDED_SUFFIXES)
        ))
    )


def checked_name(name):
    try:
        name.encode('utf-8', 'strict')
    except UnicodeError:
        raise ValueError('skill path is not valid UTF-8')
    if not name or name in ('.', '..') or '/' in name or '\\' in name or ':' in name:
        raise ValueError('skill contains an unsafe path')


def versioned_markdown(content, version):
    if len(content) > MAX_MARKDOWN:
        raise ValueError('SKILL.md exceeds the 256 KiB limit')
    try:
        source = content.decode('utf-8', 'strict')
    except UnicodeError:
        raise ValueError('SKILL.md is not valid UTF-8')
    match = re.match(r'^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)', source, re.S)
    if match is None:
        raise ValueError('SKILL.md must contain YAML frontmatter')
    frontmatter = match.group(1)
    declarations = list(re.finditer(r'^version[ \t]*:.*$', frontmatter, re.M))
    if len(declarations) > 1:
        raise ValueError('SKILL.md contains duplicate versions')
    replacement = 'version: ' + json.dumps(version)
    if declarations:
        item = declarations[0]
        frontmatter = frontmatter[:item.start()] + replacement + frontmatter[item.end():]
    else:
        frontmatter = frontmatter + '\n' + replacement
    rebuilt = ('---\n' + frontmatter + '\n---\n' + source[match.end():]).encode('utf-8')
    if len(rebuilt) > MAX_MARKDOWN:
        raise ValueError('SKILL.md exceeds the 256 KiB limit')
    return rebuilt


def same_entry(left, right):
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_nlink == right.st_nlink
        and left.st_size == right.st_size
        and left.st_mtime_ns == right.st_mtime_ns
    )


def main():
    workspace, slug, version = sys.argv[1:4]
    if not os.path.isabs(workspace) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', slug):
        raise ValueError('skill workspace or slug is invalid')
    archive_path = None
    count = 0
    expanded = 0
    saw_markdown = False
    try:
        with contextlib.ExitStack() as stack:
            workspace_fd = os.open(workspace, DIRECTORY_FLAGS)
            stack.callback(os.close, workspace_fd)
            skills_fd = os.open('skills', DIRECTORY_FLAGS, dir_fd=workspace_fd)
            stack.callback(os.close, skills_fd)
            # Workshop updates and install/remove take the same directory's exclusive flock.
            fcntl.flock(skills_fd, fcntl.LOCK_SH)
            root_fd = os.open(slug, DIRECTORY_FLAGS, dir_fd=skills_fd)
            stack.callback(os.close, root_fd)
            archive = tempfile.NamedTemporaryFile(
                mode='w+b', prefix='platformclaw-skill-export-', suffix='.zip', delete=False,
            )
            archive_path = archive.name
            stack.callback(archive.close)

            def visit(directory_fd, prefix, depth, destination):
                nonlocal count, expanded, saw_markdown
                if depth > MAX_DEPTH:
                    raise ValueError('skill directory exceeds the maximum depth')
                with os.scandir(directory_fd) as iterator:
                    entries = sorted(iterator, key=lambda item: item.name)
                for entry in entries:
                    checked_name(entry.name)
                    entry_stat = entry.stat(follow_symlinks=False)
                    is_directory = stat.S_ISDIR(entry_stat.st_mode)
                    if excluded(entry.name, is_directory):
                        continue
                    relative = prefix + entry.name
                    if stat.S_ISLNK(entry_stat.st_mode):
                        raise ValueError('skill contains a symbolic link')
                    if is_directory:
                        child_fd = os.open(entry.name, DIRECTORY_FLAGS, dir_fd=directory_fd)
                        try:
                            opened = os.fstat(child_fd)
                            if opened.st_dev != entry_stat.st_dev or opened.st_ino != entry_stat.st_ino:
                                raise ValueError('skill directory changed during export')
                            visit(child_fd, relative + '/', depth + 1, destination)
                        finally:
                            os.close(child_fd)
                        continue
                    if not stat.S_ISREG(entry_stat.st_mode) or entry_stat.st_nlink != 1:
                        raise ValueError('skill contains an unsupported or hard-linked file')
                    if entry_stat.st_size > MAX_ENTRY:
                        raise ValueError('skill file exceeds the 250 MiB limit')
                    if relative == 'SKILL.md' and entry_stat.st_size > MAX_MARKDOWN:
                        raise ValueError('SKILL.md exceeds the 256 KiB limit')
                    count += 1
                    if count > MAX_FILES:
                        raise ValueError('skill exceeds the 100-file limit')
                    file_fd = os.open(entry.name, FILE_FLAGS, dir_fd=directory_fd)
                    try:
                        opened = os.fstat(file_fd)
                        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or not same_entry(entry_stat, opened):
                            raise ValueError('skill file changed during export')
                        information = zipfile.ZipInfo(relative)
                        information.create_system = 3
                        information.external_attr = (stat.S_IFREG | (opened.st_mode & 0o777)) << 16
                        information.compress_type = zipfile.ZIP_DEFLATED
                        if relative == 'SKILL.md':
                            with os.fdopen(file_fd, 'rb', closefd=False) as source:
                                content = versioned_markdown(source.read(MAX_MARKDOWN + 1), version)
                            expanded += len(content)
                            destination.writestr(information, content)
                            saw_markdown = True
                        else:
                            with os.fdopen(file_fd, 'rb', closefd=False) as source:
                                with destination.open(information, 'w', force_zip64=False) as output:
                                    while True:
                                        chunk = source.read(CHUNK)
                                        if not chunk:
                                            break
                                        expanded += len(chunk)
                                        if expanded > MAX_EXPANDED:
                                            raise ValueError('skill exceeds the 1 GiB expanded limit')
                                        output.write(chunk)
                                        if archive.tell() > MAX_ARCHIVE:
                                            raise ValueError('skill ZIP exceeds the 500 MiB limit')
                        if expanded > MAX_EXPANDED:
                            raise ValueError('skill exceeds the 1 GiB expanded limit')
                        if not same_entry(opened, os.fstat(file_fd)):
                            raise ValueError('skill file changed during export')
                        if archive.tell() > MAX_ARCHIVE:
                            raise ValueError('skill ZIP exceeds the 500 MiB limit')
                    finally:
                        os.close(file_fd)

            with zipfile.ZipFile(archive, mode='w', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as destination:
                visit(root_fd, '', 0, destination)
                if not saw_markdown:
                    raise ValueError('skill is missing SKILL.md')
            archive.flush()
            archive_size = archive.tell()
            if archive_size < 22 or archive_size > MAX_ARCHIVE:
                raise ValueError('skill ZIP exceeds the 500 MiB limit')
            # Release the remote workspace lock before the potentially slow SSH byte transfer.
            fcntl.flock(skills_fd, fcntl.LOCK_UN)
            archive.seek(0)
            shutil.copyfileobj(archive, sys.stdout.buffer, length=CHUNK)
            sys.stdout.buffer.flush()
    finally:
        if archive_path is not None:
            try:
                os.unlink(archive_path)
            except FileNotFoundError:
                pass


try:
    main()
except Exception as error:
    print('VM skill export failed: ' + str(error), file=sys.stderr)
    sys.exit(65)
`;

type SpawnSkillExportProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

type RemoteSkillExportIo = {
  createSession(target: AssignedVmTargetSnapshot): Promise<SshSandboxSession>;
  disposeSession(session: SshSandboxSession): Promise<void>;
  spawnProcess?: SpawnSkillExportProcess;
  tempRoot?: string;
};

export type VmRemoteSkillExportArchive = {
  path: string;
  size: number;
  cleanup(): Promise<void>;
};

/** Streams a pinned VM skill into a private Gateway-owned ZIP without buffering its contents. */
export class VmRemoteSkillExportService {
  constructor(private readonly io: RemoteSkillExportIo) {}

  async export(params: {
    target: AssignedVmTargetSnapshot;
    slug: string;
    version: string;
    signal?: AbortSignal;
  }): Promise<VmRemoteSkillExportArchive> {
    if (!SKILL_KEY_PATTERN.test(params.slug) || params.slug.length > 128) {
      throw new Error("VM skill export slug is invalid");
    }
    if (!SKILL_VERSION_PATTERN.test(params.version) || params.version.length > 128) {
      throw new Error("VM skill export version is invalid");
    }
    if (
      !path.posix.isAbsolute(params.target.remoteWorkspaceDir) ||
      path.posix.normalize(params.target.remoteWorkspaceDir) !== params.target.remoteWorkspaceDir
    ) {
      throw new Error("VM skill export workspace is invalid");
    }
    params.signal?.throwIfAborted();

    const session = await this.io.createSession(params.target);
    let directory: string | undefined;
    let sessionDisposed = false;
    try {
      directory = await mkdtemp(
        path.join(
          this.io.tempRoot ?? resolvePreferredOpenClawTmpDir(),
          "platformclaw-vm-skill-export-",
        ),
      );
      const archivePath = path.join(directory, "archive.zip");
      const remoteCommand = buildRemoteCommand([
        "python3",
        "-c",
        VM_REMOTE_SKILL_EXPORT_PYTHON,
        params.target.remoteWorkspaceDir,
        params.slug,
        params.version,
      ]);
      const argv = buildSshSandboxArgv({ session, remoteCommand });
      const [command, ...args] = argv;
      if (!command) {
        throw new Error("VM skill export SSH command is unavailable");
      }
      const child = (this.io.spawnProcess ?? spawn)(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizeEnvVars(process.env).allowed,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        throw new Error("VM skill export SSH streams are unavailable");
      }
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      child.stderr.on("data", (raw: Buffer | string) => {
        if (stderrBytes >= MAX_STDERR_BYTES) {
          return;
        }
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const retained = bytes.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderr.push(retained);
        stderrBytes += retained.byteLength;
      });

      let receivedBytes = 0;
      const bounded = new Transform({
        transform(raw: Buffer | string, _encoding, callback) {
          const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          receivedBytes += bytes.byteLength;
          if (receivedBytes > MAX_ARCHIVE_BYTES) {
            callback(new Error("VM skill ZIP exceeds the 500 MiB limit"));
            return;
          }
          callback(null, bytes);
        },
      });
      const completed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, exitSignal) => {
          if (code === 0 && !exitSignal) {
            resolve();
            return;
          }
          reject(
            new Error(
              Buffer.concat(stderr, stderrBytes).toString("utf8").trim() ||
                `VM skill export failed (${exitSignal ?? code ?? "unknown"})`,
            ),
          );
        });
      });
      const output = createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
      const transferred = pipeline(child.stdout, bounded, output);
      try {
        await Promise.all([completed, transferred]);
      } catch (error) {
        child.kill("SIGKILL");
        child.stdout.destroy();
        output.destroy();
        await Promise.allSettled([completed, transferred]);
        throw error;
      }
      if (receivedBytes < 22) {
        throw new Error("VM skill export returned an invalid ZIP archive");
      }
      const archiveStat = await stat(archivePath);
      if (!archiveStat.isFile() || archiveStat.size !== receivedBytes) {
        throw new Error("VM skill export archive changed during transfer");
      }
      sessionDisposed = true;
      await this.io.disposeSession(session);
      const ownedDirectory = directory;
      return {
        path: archivePath,
        size: receivedBytes,
        cleanup: async () => await rm(ownedDirectory, { recursive: true, force: true }),
      };
    } catch (error) {
      if (!sessionDisposed) {
        await this.io.disposeSession(session).catch(() => undefined);
      }
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }
}
