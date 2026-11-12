// A stand-in for the Common Agent packer (common-agent-pack): the same two
// command lines and the same JSON. It refuses a source whose skill does not
// carry its script, so the tests see that the build entry was followed.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const a = process.argv.slice(2);
if (a[0] === "validate") {
  const ok = existsSync(a[1]) && readFileSync(a[1], "utf8").startsWith("stand-in package");
  console.log(JSON.stringify({ ok, act: "validate", target: a[1], issues: ok ? [] : ["not a package"], warnings: [] }, null, 2));
  process.exit(ok ? 0 : 1);
}
const src = a[0];
const out = a[a.indexOf("--out") + 1];
for (const f of ["agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json"]) {
  if (!existsSync(join(src, f))) { console.error(`${src} holds no ${f}`); process.exit(1); }
}
const plugin = JSON.parse(readFileSync(join(src, "plugin.json"), "utf8"));
// Each script a skill's build entry names is carried in that skill, as the packer requires.
const skills = plugin.extensions?.["net.agentdoc.package"]?.build?.skills ?? { count: { scripts: ["scripts/count.mjs"] } };
for (const [slug, s] of Object.entries(skills)) {
  for (const script of s.scripts ?? []) {
    const want = join("skills", slug, "scripts", basename(script));
    if (!existsSync(join(src, want))) { console.error(`${want.split("\\").join("/")} is missing`); process.exit(1); }
  }
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${plugin.name}-${plugin.version}.tar.gz`), `stand-in package of ${basename(src)}\n`);
writeFileSync(join(out, `${plugin.name}-build.json`), JSON.stringify({ name: plugin.name, version: plugin.version, signed: false }));
console.log(JSON.stringify({ ok: true, act: "build", name: plugin.name, version: plugin.version, sha256: "0".repeat(64), warnings: [] }, null, 2));
