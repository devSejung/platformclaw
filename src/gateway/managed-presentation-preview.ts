import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { resolveSandboxDockerConfig } from "../agents/sandbox/config.js";
import { DOCKER_SANDBOX_ENGINE, execContainerRaw } from "../agents/sandbox/container-engine.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const MAX_PRESENTATION_BYTES = 16 * 1024 * 1024;
const PREVIEW_DEADLINE_MS = 25_000;
const CONVERTER_UNAVAILABLE =
  "PowerPoint preview requires the rootless sandbox Docker service and an image with LibreOffice Impress. Download the original file instead.";
const CONVERSION_FAILED =
  "This PowerPoint file could not be previewed. Download the original file instead.";
let converting = false;

// No user path enters this script. Input, profile, logs and output exist only
// inside a disposable, networkless container; its stdout contains PDF bytes.
// Docker omits RLIMIT_AS from --ulimit; the shell applies it before parsing.
const CONVERT_PRESENTATION_SCRIPT = `set -eu
ulimit -v 2097152
command -v libreoffice >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 || exit 69
mkdir -p /work/profile/user
cat > /work/profile/user/registrymodifications.xcu <<'PROFILE'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>
PROFILE
cat > "/work/input.$1"
timeout --kill-after=1s 20s libreoffice -env:UserInstallation=file:///work/profile --headless --nologo --nodefault --norestore --convert-to pdf:impress_pdf_Export --outdir /work "/work/input.$1" > /work/conversion.log 2>&1
test -s /work/input.pdf
test "$(stat -c %s /work/input.pdf)" -le ${MAX_PRESENTATION_BYTES} || exit 65
cat /work/input.pdf`;

class PresentationPreviewError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function presentationExtension(contentType: string): "ppt" | "pptx" | undefined {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "application/vnd.ms-powerpoint") {
    return "ppt";
  }
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return "pptx";
  }
  return undefined;
}

export function isManagedPresentationContentType(contentType: string): boolean {
  return presentationExtension(contentType) !== undefined;
}

function converterImage(config: OpenClawConfig): string {
  return resolveSandboxDockerConfig({
    scope: "shared",
    globalDocker: config.agents?.defaults?.sandbox?.docker,
  }).image;
}

async function readPresentationSnapshot(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (size > MAX_PRESENTATION_BYTES) {
    throw new PresentationPreviewError(
      413,
      "PowerPoint preview exceeds 16 MiB. Download the original file instead.",
    );
  }
  const buffer = Buffer.alloc(MAX_PRESENTATION_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    signal.throwIfAborted();
    const result = await handle.read(buffer, length, buffer.length - length, length);
    if (result.bytesRead === 0) {
      break;
    }
    length += result.bytesRead;
  }
  if (length > MAX_PRESENTATION_BYTES) {
    throw new PresentationPreviewError(
      413,
      "PowerPoint preview exceeds 16 MiB. Download the original file instead.",
    );
  }
  return buffer.subarray(0, length);
}

/** Convert only the opened, transcript-owned snapshot; never reread a runtime path. */
export async function serveManagedPresentationPreview(params: {
  response: ServerResponse;
  method?: string;
  file: { handle: FileHandle; stat: { size: number } };
  contentType: string;
  getConfig: () => OpenClawConfig;
  revalidate: () => Promise<boolean>;
}): Promise<void> {
  const { response } = params;
  const controller = new AbortController();
  const expiresAt = Date.now() + PREVIEW_DEADLINE_MS;
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort();
  }, PREVIEW_DEADLINE_MS);
  const disconnect = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  response.once("close", disconnect);
  if (response.destroyed) {
    controller.abort();
  }
  let ownsConversion = false;
  let containerName: string | undefined;
  let pdf: Buffer | undefined;
  let failure: PresentationPreviewError | undefined;
  let authorized = true;
  try {
    const extension = presentationExtension(params.contentType);
    if (!extension) {
      throw new PresentationPreviewError(
        415,
        "Only PPT and PPTX files support PowerPoint preview.",
      );
    }
    if (converting) {
      throw new PresentationPreviewError(
        503,
        "Another PowerPoint preview is being prepared. Try again, or download the original file.",
      );
    }
    converting = true;
    ownsConversion = true;
    const input = await readPresentationSnapshot(
      params.file.handle,
      params.file.stat.size,
      controller.signal,
    );
    const image = converterImage(params.getConfig());
    const info = await execContainerRaw(
      DOCKER_SANDBOX_ENGINE,
      ["info", "--format", "{{json .SecurityOptions}}"],
      { signal: controller.signal, maxBufferBytes: 4096 },
    );
    const securityOptions: unknown = JSON.parse(info.stdout.toString("utf8"));
    if (!Array.isArray(securityOptions) || !securityOptions.includes("name=rootless")) {
      throw new PresentationPreviewError(503, CONVERTER_UNAVAILABLE);
    }
    authorized = await params.revalidate();
    if (!authorized) {
      return;
    }
    controller.signal.throwIfAborted();
    containerName = `openclaw-document-preview-${randomUUID()}`;
    // Rootless daemons without cgroup delegation ignore cgroup budgets. Kernel
    // rlimits and the converter's own wall deadline remain independent backstops.
    await execContainerRaw(
      DOCKER_SANDBOX_ENGINE,
      [
        "create",
        "--name",
        containerName,
        "--interactive",
        "--init",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--user",
        "65534:65534",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "768m",
        "--memory-swap",
        "768m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--ulimit",
        "fsize=33554432:33554432",
        "--ulimit",
        "nofile=256:256",
        "--ulimit",
        "core=0:0",
        "--ulimit",
        "nproc=64:64",
        "--ulimit",
        "cpu=20:21",
        "--tmpfs",
        "/work:rw,noexec,nosuid,size=128m,uid=65534,gid=65534,mode=0700",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=32m,mode=1777",
        "--env",
        "HOME=/work",
        "--env",
        "XDG_CACHE_HOME=/work/cache",
        "--workdir",
        "/work",
        "--entrypoint",
        "sh",
        "--",
        image,
        "-c",
        CONVERT_PRESENTATION_SCRIPT,
        "--",
        extension,
      ],
      { signal: controller.signal, maxBufferBytes: 4096 },
    );
    // Container creation yields. Current ownership and operator image selection
    // must still authorize processing before any authored bytes enter it.
    authorized = await params.revalidate();
    if (!authorized) {
      return;
    }
    controller.signal.throwIfAborted();
    if (converterImage(params.getConfig()) !== image) {
      throw new PresentationPreviewError(503, CONVERTER_UNAVAILABLE);
    }
    const result = await execContainerRaw(
      DOCKER_SANDBOX_ENGINE,
      ["start", "--attach", "--interactive", containerName],
      {
        input,
        signal: controller.signal,
        maxBufferBytes: MAX_PRESENTATION_BYTES + 1,
        allowFailure: true,
      },
    );
    if (result.code === 69) {
      throw new PresentationPreviewError(503, CONVERTER_UNAVAILABLE);
    }
    if (result.code === 124) {
      throw new PresentationPreviewError(
        504,
        "PowerPoint preview timed out. Try a smaller file, or download the original file.",
      );
    }
    if (result.code === 65 || result.stdout.length > MAX_PRESENTATION_BYTES) {
      throw new PresentationPreviewError(
        413,
        "PowerPoint preview exceeds 16 MiB. Download the original file instead.",
      );
    }
    if (result.code !== 0 || !result.stdout.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new PresentationPreviewError(422, CONVERSION_FAILED);
    }
    pdf = result.stdout;
  } catch (error) {
    failure =
      error instanceof PresentationPreviewError
        ? error
        : new PresentationPreviewError(
            deadlineExceeded ? 504 : 503,
            deadlineExceeded
              ? "PowerPoint preview timed out. Try a smaller file, or download the original file."
              : CONVERTER_UNAVAILABLE,
          );
  } finally {
    await params.file.handle.close().catch(() => {});
    if (containerName) {
      // Killing the CLI does not kill a daemon-owned container. Always remove
      // this operation's container, even after a timeout or client disconnect.
      try {
        await execContainerRaw(DOCKER_SANDBOX_ENGINE, ["rm", "--force", containerName], {
          signal: AbortSignal.timeout(3000),
          maxBufferBytes: 4096,
        });
      } catch {
        failure = new PresentationPreviewError(503, CONVERTER_UNAVAILABLE);
      }
    }
    if (ownsConversion) {
      converting = false;
    }
    clearTimeout(deadline);
    response.off("close", disconnect);
  }
  if (!authorized || response.destroyed || response.writableEnded) {
    return;
  }
  if (!(await params.revalidate()) || response.destroyed || response.writableEnded) {
    return;
  }
  if (deadlineExceeded || Date.now() >= expiresAt) {
    failure = new PresentationPreviewError(
      504,
      "PowerPoint preview timed out. Try a smaller file, or download the original file.",
    );
  }
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (failure || !pdf) {
    response.statusCode = failure?.statusCode ?? 422;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      params.method === "HEAD"
        ? undefined
        : JSON.stringify({ error: failure?.message ?? CONVERSION_FAILED }),
    );
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
  response.setHeader("Content-Length", pdf.length);
  response.end(params.method === "HEAD" ? undefined : pdf);
}
