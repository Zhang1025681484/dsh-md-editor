/** Path containment and text-file policy for bianji. No credentials. */

import * as nodePath from "node:path";

export const API_PATH = "/api/bianji";
export const TEXT_BYTE_LIMIT = 1_500_000;
export const LIST_ENTRY_LIMIT = 2_000;

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "wav", "ogg", "webm",
  "wasm", "node", "dylib", "so", "dll", "exe",
  "class", "jar", "pyc", "pyo",
]);

export function isPathInside(root, candidate) {
  const rel = nodePath.relative(root, candidate);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel);
}

export function extensionOf(filePath) {
  const base = nodePath.basename(filePath);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isBinaryPath(filePath) {
  return BINARY_EXTENSIONS.has(extensionOf(filePath));
}

export function looksBinary(buffer) {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

export function decodeText(buffer) {
  if (looksBinary(buffer)) throw Object.assign(new Error("binary file"), { code: "FS_NOT_TEXT" });
  try {
    // ignoreBOM retains U+FEFF in the editable text, so saving preserves its bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw Object.assign(new Error("invalid UTF-8 text"), { code: "FS_NOT_TEXT" });
  }
}
