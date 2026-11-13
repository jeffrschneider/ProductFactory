// The architecture record (lib/architecture.mjs): one builder writes it in the
// build folder, and its parts read into the lifecycle API's
// ArchitectureSummary (0.4.12). No test reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "../standards/lifecycle-api-check.mjs";
import { architectureSummary, questionsOf, readRecord } from "../lib/architecture.mjs";

const fixture = (p) => readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), "utf8");

test("an architecture record reads into the lifecycle API's ArchitectureSummary, every part from the record", () => {
  const text = fixture("architecture/architecture-record.md");
  const s = architectureSummary(text);
  assert.deepEqual(validate("ArchitectureSummary", s), []);
  assert.deepEqual(s.systems, ["files", "text-reasoning"]);
  // A binding still asked is left out; the rest give the product and who provided it.
  assert.deepEqual(s.bindings.files, { dev: { product: "local folder", provided_by: "customer" }, test: { product: "local folder", provided_by: "customer" } });
  assert.deepEqual(s.bindings["text-reasoning"].production, { product: "platform", provided_by: "platform" });
  assert.deepEqual(s.dependencies, [{ name: "page-reader", why: "It fetches the page and hands back its text" }]);
  assert.equal(s.kind, "plugin-on-harness");
  assert.equal(s.limits.cost, "at most 2 USD a day. The statement's owner said so.");
  assert.deepEqual(Object.keys(s.limits), ["cost", "speed", "data", "trust"]);
  assert.deepEqual(s.decisions[1], { decided: "Bind text-reasoning to platform in dev, test and production", why: "The organization chose no product for text-reasoning, so the platform's default fills each.", options: ["A model provider of the organization's own."], follows: "The install places the model in the four model settings." });
  assert.equal(s.decisions[0].options, undefined);
  // Egress per environment: whether its target enforces an allowlist, and the destinations beyond the derived set.
  assert.deepEqual(s.egress.map((e) => [e.environment, e.enforced]), [["dev", false], ["test", false], ["production", true]]);
  assert.deepEqual(s.egress[2].destinations, [{ what: "the page's own host", why: "because the page's address arrives with each request" }]);
  assert.equal(s.questions, 1);
  assert.deepEqual(questionsOf(text), [{ key: "binding-files-production", question: "Which product holds the files in production?" }]);
  assert.equal(readRecord(text).done, false);
  // Not a record, or a kind the API does not name: no summary of parts.
  assert.equal(architectureSummary("# Notes\n"), null);
  assert.equal(architectureSummary(text.replace("kind: plugin-on-harness", "kind: not settled")), null);
});
