// A ustar archive, written in node alone: how the reviewers are handed the
// package (the agent's files, the suite and the scripts) as one .tar.gz.
// Ported from AgentMesh's ustar writer (services/src/conversions/ustar.ts).

import { gzipSync } from "node:zlib";

/** files: [{ path, bytes }] in the order given. Returns the tar's bytes. */
export function writeTar(files) {
  const blocks = [];
  for (const f of files) {
    const bytes = Buffer.from(f.bytes);
    const h = Buffer.alloc(512);
    let name = f.path;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf("/", 155);
      if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for ustar: ${f.path}`);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h[156] = "0".charCodeAt(0);
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(h, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The same, gzipped. */
export const writeTarGz = (files) => gzipSync(writeTar(files));
