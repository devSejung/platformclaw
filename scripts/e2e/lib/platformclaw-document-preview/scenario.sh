#!/usr/bin/env bash
# Sourced by the existing runtime smoke after its rootless daemon loads the built image.

echo "==> Converting real PPT and PPTX with the packaged sandbox image"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T \
  --env "PREVIEW_SANDBOX_IMAGE=$PLATFORMCLAW_SANDBOX_IMAGE" \
  openclaw-gateway bash -seu -o pipefail <<'PRESENTATION_SMOKE'
docker info --format '{{json .SecurityOptions}}' | python3 -c '
import json, sys
if "name=rootless" not in json.load(sys.stdin):
    raise RuntimeError("Presentation smoke requires the runtime rootless Docker daemon")
'
preview_container="platformclaw-smoke-presentation-$RANDOM"
trap 'docker rm --force "$preview_container" >/dev/null 2>&1 || true' EXIT
converter_script="$(cat <<'CONVERTER'
set -eu
ulimit -v 2097152
test "$(id -u)" = 65534
command -v libreoffice >/dev/null
fc-match -f '%{family}' 'Noto Sans CJK KR' | grep -Fq 'Noto Sans CJK KR'
mkdir -p /work/profile/user /work/ppt /work/pptx
cat > /work/profile/user/registrymodifications.xcu <<'PROFILE'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>
PROFILE
cat > /work/source.fodp
convert() {
  timeout --kill-after=1s 20s libreoffice -env:UserInstallation=file:///work/profile \
    --headless --nologo --nodefault --norestore --convert-to "$1" --outdir "$2" "$3" \
    >> /work/conversion.log 2>&1 || { cat /work/conversion.log >&2; return 1; }
}
convert 'ppt:MS PowerPoint 97' /work /work/source.fodp
convert 'pptx:Impress MS PowerPoint 2007 XML' /work /work/source.fodp
convert pdf:impress_pdf_Export /work/ppt /work/source.ppt
convert pdf:impress_pdf_Export /work/pptx /work/source.pptx
python3 - <<'PY'
import json, os, pathlib, subprocess, zipfile
from pypdf import PdfReader

root = pathlib.Path("/work")
if not (root / "source.ppt").read_bytes().startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
    raise RuntimeError("Packaged Impress did not produce a legacy CFB PowerPoint file")
if not zipfile.is_zipfile(root / "source.pptx"):
    raise RuntimeError("Packaged Impress did not produce an OOXML PowerPoint file")
pages = {}
for format in ("ppt", "pptx"):
    file = root / format / "source.pdf"
    if not file.read_bytes().startswith(b"%PDF-"):
        raise RuntimeError(f"{format} conversion did not produce PDF bytes")
    reader = PdfReader(file)
    if len(reader.pages) != 2:
        raise RuntimeError(f"{format} preview lost a slide")
    for number, page in enumerate(reader.pages, 1):
        text = "".join(page.extract_text().split())
        if f"Ownedpresentationslide{number}" not in text or "한글슬라이드미리보기" not in text:
            raise RuntimeError(f"{format} preview lost English or Korean slide text")
    pages[format] = len(reader.pages)
print(json.dumps({"presentationPreview": "passed", "uid": os.getuid(), "pages": pages,
    "converter": subprocess.check_output(["libreoffice", "--version"], text=True).strip()}))
PY
CONVERTER
)"
# Match the production converter's independent process limits even when the
# nested rootless daemon cannot delegate cgroup memory/CPU controllers.
docker create --name "$preview_container" --interactive --init --pull never \
  --network none --read-only --user 65534:65534 --cap-drop ALL \
  --security-opt no-new-privileges --memory 768m --memory-swap 768m --cpus 1 --pids-limit 64 \
  --ulimit fsize=33554432:33554432 --ulimit nofile=256:256 --ulimit core=0:0 \
  --ulimit nproc=64:64 --ulimit cpu=20:21 \
  --tmpfs /work:rw,noexec,nosuid,size=128m,uid=65534,gid=65534,mode=0700 \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m,mode=1777 \
  --env HOME=/work --env XDG_CACHE_HOME=/work/cache --workdir /work --entrypoint sh \
  -- "$PREVIEW_SANDBOX_IMAGE" -c "$converter_script" >/dev/null
# Four conversions each have the same 20-second wall deadline as production;
# this outer deadline also bounds daemon/CLI failures across the complete proof.
cat <<'FODP' | timeout --kill-after=2s 90s docker start --attach --interactive "$preview_container"
<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:font-face-decls><style:font-face style:name="Latin" svg:font-family="Liberation Sans"/><style:font-face style:name="Korean" svg:font-family="Noto Sans CJK KR"/></office:font-face-decls>
<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape"/></style:page-layout><style:style style:name="P1" style:family="paragraph"><style:text-properties style:font-name="Latin" fo:font-size="24pt" style:font-name-asian="Korean" style:font-size-asian="24pt"/></style:style></office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
<office:body><office:presentation>
<draw:page draw:name="Slide 1" draw:master-page-name="Default"><draw:frame svg:x="2cm" svg:y="3cm" svg:width="24cm" svg:height="10cm"><draw:text-box><text:p text:style-name="P1">Owned presentation slide 1</text:p><text:p text:style-name="P1">한글 슬라이드 미리보기</text:p></draw:text-box></draw:frame></draw:page>
<draw:page draw:name="Slide 2" draw:master-page-name="Default"><draw:frame svg:x="2cm" svg:y="3cm" svg:width="24cm" svg:height="10cm"><draw:text-box><text:p text:style-name="P1">Owned presentation slide 2</text:p><text:p text:style-name="P1">한글 슬라이드 미리보기</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document>
FODP
PRESENTATION_SMOKE
