const TAR_BLOCK_SIZE = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_MODE_OFFSET = 100;
const TAR_MODE_LENGTH = 8;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;

function readTarString(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block
    .subarray(offset, end >= offset && end < offset + length ? end : offset + length)
    .toString("utf8")
    .trim();
}

function readTarOctal(block, offset, length) {
  const value = readTarString(block, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function writeTarOctal(block, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  block.write(encoded, offset, length, "ascii");
}

function tarPath(block) {
  const name = readTarString(block, TAR_NAME_OFFSET, TAR_NAME_LENGTH);
  const prefix = readTarString(block, TAR_PREFIX_OFFSET, TAR_PREFIX_LENGTH);
  const path = prefix ? `${prefix}/${name}` : name;
  return path.replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
}

function updateTarChecksum(block) {
  block.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  block.write(encoded, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_LENGTH, "ascii");
}

export function patchTarModes(archive, modes) {
  const patched = Buffer.from(archive);
  const remaining = new Set(modes.keys());

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= patched.length;) {
    const block = patched.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (block.every((byte) => byte === 0)) break;

    const path = tarPath(block);
    const mode = modes.get(path);
    if (mode !== undefined) {
      writeTarOctal(block, TAR_MODE_OFFSET, TAR_MODE_LENGTH, mode);
      updateTarChecksum(block);
      remaining.delete(path);
    }

    const size = readTarOctal(block, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH);
    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  if (remaining.size > 0) {
    throw new Error(`Tar archive is missing mode targets: ${[...remaining].join(", ")}`);
  }
  return patched;
}
