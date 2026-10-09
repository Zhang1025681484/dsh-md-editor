/** Same-origin Monaco 0.52.2 assets. No public CDN. */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./parse.js";

const PLUGIN_DIR = nodePath.dirname(fileURLToPath(import.meta.url));

export const MONACO_ROUTE = "/api/md-editor/monaco";
export const MONACO_VS_DIR = nodePath.join(PLUGIN_DIR, "vendor", "monaco", "vs");

const FILE_PATTERN = /^vs(?:\/[A-Za-z0-9._-]+)+$/;

function invalid(message, status) {
  return Object.assign(new Error(message), { status });
}

export function monacoFileError(file) {
  if (typeof file !== "string" || file.length === 0) return "missing file";
  if (file.includes("\0") || file.includes("\\") || file.includes("?") || file.includes("#")) return "invalid file";
  if (file.startsWith("/") || nodePath.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return "invalid file";
  if (!FILE_PATTERN.test(file)) return "invalid file";
  if (file.split("/").some((part) => part === "" || part === "." || part === "..")) return "invalid file";
  return null;
}

function contentTypeFor(filePath) {
  switch (nodePath.extname(filePath).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".ttf":
      return "font/ttf";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export function rewriteMonacoCss(css, cssFile) {
  const base = String(cssFile || "").split("/").slice(0, -1);
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote, raw) => {
    const value = String(raw).trim();
    if (!value || /^(?:data:|https?:|blob:|#|\/)/i.test(value)) return full;
    const parts = base.slice();
    for (const piece of value.split("/")) {
      if (!piece || piece === ".") continue;
      if (piece === "..") parts.pop();
      else parts.push(piece);
    }
    if (!parts.length || parts[0] !== "vs" || parts.includes("..") || parts.includes("")) return full;
    return `url("/api/md-editor/monaco?file=${parts.join("/")}")`;
  });
}

async function locateFile(vsDir, relativeUnderVs) {
  const rootReal = await fs.realpath(vsDir);
  const parts = String(relativeUnderVs).split("/");
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === "." || part === "..") throw invalid("invalid file", 400);
    current = nodePath.join(current, part);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw invalid("invalid file", 400);
    const last = index === parts.length - 1;
    if (!last) {
      if (!info.isDirectory()) return null;
      continue;
    }
    if (!info.isFile()) return null;
    const real = await fs.realpath(current);
    if (!isPathInside(rootReal, real) || nodePath.resolve(real) !== nodePath.resolve(current)) {
      throw invalid("invalid file", 400);
    }
    return { path: real, stat: info };
  }
  return null;
}

export async function resolveMonacoFile(file, vsDir = MONACO_VS_DIR) {
  const reason = monacoFileError(file);
  if (reason) throw invalid(reason, 400);
  const relative = file.slice("vs/".length);
  let found = await locateFile(vsDir, relative);
  if (!found && !/\.(?:js|css|ttf|json)$/i.test(relative)) {
    const withJs = `${relative}.js`;
    if (monacoFileError(`vs/${withJs}`)) throw invalid("invalid file", 400);
    found = await locateFile(vsDir, withJs);
  }
  if (!found) throw invalid("not found", 404);
  return found;
}

function plain(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

export async function handleMonacoRequest(request, vsDir = MONACO_VS_DIR) {
  if (!request || request.method !== "GET") return plain(405, "method not allowed");
  let file;
  try {
    file = new URL(request.url).searchParams.get("file");
  } catch {
    return plain(400, "invalid file");
  }
  try {
    const found = await resolveMonacoFile(file, vsDir);
    const type = contentTypeFor(found.path);
    let body = await fs.readFile(found.path);
    if (type.startsWith("text/css")) {
      const rootReal = await fs.realpath(vsDir);
      const cssFile = `vs/${nodePath.relative(rootReal, found.path).split(nodePath.sep).join("/")}`;
      body = Buffer.from(rewriteMonacoCss(body.toString("utf8"), cssFile), "utf8");
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": type,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (error) {
    const status = error && (error.status === 400 || error.status === 404) ? error.status : 500;
    const message = status === 400 ? "invalid file" : status === 404 ? "not found" : "monaco unavailable";
    return plain(status, message);
  }
}
