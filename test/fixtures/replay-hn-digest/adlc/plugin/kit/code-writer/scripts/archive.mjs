// Pack a folder into a gzip tar archive and unpack one, in node alone.
//
// The job folder is a mounted folder where the tar binary fails on
// timestamps, and a package may depend on nothing outside node, so the
// archive is written and read here. Packing is deterministic: entries are
// sorted by path, and every time, mode and owner is a fixed value, so the same
// folder gives the same bytes on any host and a digest of the archive means
// something. Unpacking refuses an entry that climbs out of the folder, that
// is absolute, or that is a link, because an archive that came from somebody
// else must not decide where a file lands. Every file is read and written as
// bytes.
//
//   needs: node >= 22
//   node archive.mjs pack <folder> <archive.tar.gz>
//   node archive.mjs unpack <archive.tar.gz> <folder>
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/** True for a path that stays inside the folder it is unpacked into: relative,
 *  with no `..` part and no drive letter. */
export function isSafePath(rel) {
  const p = String(rel ?? "").replace(/\\/g, "/");
  if (!p || p.includes("\0") || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split("/").includes("..");
}

const octal = (n, width) => n.toString(8).padStart(width - 1, "0") + "\0";

/** One 512 byte ustar header. `name` may need the prefix field. */
function header({ name, prefix = "", size, type, mode }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, "utf8");
  h.write(octal(mode, 8), 100, "latin1");
  h.write(octal(0, 8), 108, "latin1");
  h.write(octal(0, 8), 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(0, 12), 136, "latin1");
  h.fill(0x20, 148, 156);
  h.write(type, 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  h.write(prefix, 345, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}

const padTo = (buf) => (buf.length % BLOCK ? Buffer.concat([buf, Buffer.alloc(BLOCK - (buf.length % BLOCK))]) : buf);

/** Split a path into ustar's name and prefix, or null when it fits neither. */
function splitName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  return null;
}

/** A pax extended header carrying the whole path, for one too long to split. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, "utf8");
}

function entryBlocks(path, type, bytes) {
  const out = [];
  const split = splitName(path);
  let use = split;
  if (!split) {
    const data = paxRecord("path", path);
    out.push(header({ name: "PaxHeader", size: data.length, type: "x", mode: FILE_MODE }), padTo(data));
    use = { name: path.slice(0, 100), prefix: "" };
  }
  out.push(header({ name: use.name, prefix: use.prefix, size: type === "0" ? bytes.length : 0, type, mode: type === "5" ? DIR_MODE : FILE_MODE }));
  if (type === "0" && bytes.length) out.push(padTo(bytes));
  return out;
}

/** Every file and empty folder under a folder, as sorted posix paths. A folder
 *  that holds a file is not listed itself: unpacking makes it. */
function entriesOf(dir) {
  const out = [];
  const walk = (d, rel) => {
    const names = readdirSync(d).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (!names.length && rel) out.push({ path: rel, type: "5" });
    for (const n of names) {
      const at = join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(at);
      if (st.isDirectory()) walk(at, r);
      else if (st.isFile()) out.push({ path: r, type: "0", at });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

/** The archive of a folder, as bytes. */
export function packBytes(dir) {
  if (!existsSync(dir)) throw new Error(`there is no folder to pack at ${dir}`);
  const blocks = [];
  for (const e of entriesOf(dir)) blocks.push(...entryBlocks(e.path, e.type, e.type === "0" ? readFileSync(e.at) : null));
  blocks.push(Buffer.alloc(BLOCK * 2));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  // The header names the operating system that wrote it; fix it so the bytes
  // do not depend on the host. Its time field is already zero.
  gz[9] = 3;
  return gz;
}

/** Pack a folder into a gzip tar archive file. */
export function pack(dir, file) {
  const bytes = packBytes(dir);
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, bytes);
  return { files: entriesOf(dir).filter((e) => e.type === "0").length, bytes: bytes.length };
}

const text = (buf, from, to) => { const s = buf.subarray(from, to); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString("utf8"); };

/** The entries of an archive's bytes: {path, type, bytes}. Throws on an archive
 *  that is not a gzip tar, whose checksum fails, or that holds a link. */
export function entriesIn(gz) {
  let tar;
  try { tar = gunzipSync(gz); } catch (e) { throw new Error(`not a gzip archive: ${e.message}`); }
  const out = [];
  let pax = null;
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(text(h, 148, 156).trim() || "x", 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (!Number.isFinite(stored) || stored !== sum) throw new Error("not a tar archive: a header fails its checksum");
    const size = parseInt(text(h, 124, 136).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0 || at + BLOCK + size > tar.length) throw new Error("not a tar archive: an entry runs past the end");
    const type = String.fromCharCode(h[156] || 0x30);
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x" || type === "L") {
      let name = null;
      if (type === "L") name = text(body, 0, body.length);
      else {
        const s = body.toString("utf8");
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(s.startsWith("\n") ? s : `\n${s}`);
        if (m) name = m[1];
      }
      pax = name;
      continue;
    }
    if (type === "g") continue;
    const prefix = text(h, 345, 500);
    const own = text(h, 0, 100);
    const path = pax ?? (prefix ? `${prefix}/${own}` : own);
    pax = null;
    if (type === "0") out.push({ path, type: "file", bytes: Buffer.from(body) });
    else if (type === "5") out.push({ path, type: "dir", bytes: Buffer.alloc(0) });
    else throw new Error(`the archive holds an entry of kind ${JSON.stringify(type)} at ${path}, which is not a file or a folder`);
  }
  return out;
}

/** Unpack an archive file into a folder, byte for byte. Nothing is written
 *  until every entry has been checked, so a refused archive leaves no part. */
export function unpack(file, dir) {
  const entries = entriesIn(readFileSync(file));
  const root = resolve(dir);
  const planned = [];
  for (const e of entries) {
    const rel = e.path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (!rel || rel === ".") continue;
    if (!isSafePath(rel)) throw new Error(`the archive holds a path that leaves the folder: ${e.path}`);
    const to = resolve(root, rel);
    if (to !== root && !to.startsWith(root + sep)) throw new Error(`the archive holds a path that leaves the folder: ${e.path}`);
    planned.push({ to, e, rel });
  }
  mkdirSync(root, { recursive: true });
  for (const { to, e } of planned) {
    if (e.type === "dir") { mkdirSync(to, { recursive: true }); continue; }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, e.bytes);
  }
  return { files: planned.filter((p) => p.e.type === "file").map((p) => p.rel) };
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const [verb, a, b] = process.argv.slice(2);
  if (!["pack", "unpack"].includes(verb) || !a || !b) {
    console.error("usage: node archive.mjs pack <folder> <archive.tar.gz> | unpack <archive.tar.gz> <folder>; both paths are required");
    process.exit(2);
  }
  try {
    const r = verb === "pack" ? pack(a, b) : unpack(a, b);
    console.log(JSON.stringify({ ok: true, ...(verb === "pack" ? r : { files: r.files.length }) }));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
