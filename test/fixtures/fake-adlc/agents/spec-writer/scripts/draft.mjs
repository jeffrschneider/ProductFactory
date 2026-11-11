// A stand-in for draft.mjs: a fixed draft, named from a "name:" line when there is one,
// else, for the Design given an architecture record, from the spec attached (spec-v1).
// It notes whether an architecture record came with the request, and the digest of the spec
// it was given then, so a test can see the Design was given both.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const { ASKED, RECORDS } = process.env;
if (!ASKED || !RECORDS) { console.error("ASKED and RECORDS are required"); process.exit(2); }
const asked = JSON.parse(readFileSync(ASKED, "utf8"));
if (!asked.model.MODEL_NAME || !asked.model.MODEL_ENDPOINT || !asked.model.MODEL_PROTOCOL) {
  console.log(JSON.stringify({ ok: false, code: 4, reply: "A model setting is missing." }));
  process.exit(4);
}
const texts = asked.files.map((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
const specText = texts.find((t) => { try { return JSON.parse(t)?.format === "spec-v1"; } catch { return false; } }) ?? "";
const spec = texts.map((t) => { try { const d = JSON.parse(t); return d?.format === "spec-v1" ? d : null; } catch { return null; } }).find(Boolean) ?? null;
const architecture = texts.some((t) => /^---\r?\nrecord: architecture-record-v1/.test(t));
const name = /^(?:changes:\s*)?name:\s*(.+)$/m.exec(asked.said)?.[1]?.trim() ?? (architecture ? spec?.product?.name : null) ?? null;
const revision = /^changes:/m.test(asked.said);
const version = /^version:\s*(.+)$/m.exec(asked.said)?.[1]?.trim() ?? (architecture ? spec?.product?.version : null) ?? null;
writeFileSync(join(RECORDS, "draft.json"), JSON.stringify({ name, revision, files: asked.files, ...(version ? { version } : {}), ...(architecture ? { architecture: createHash("sha256").update(specText).digest("hex").slice(0, 12) } : {}) }, null, 2));
writeFileSync(join(RECORDS, "blanks.json"), JSON.stringify(name ? [] : [{ key: "name", question: "What should this agent be called?" }]));
console.log(JSON.stringify({ ok: true, code: 0 }));
