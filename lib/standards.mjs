// The open standards Product Factory reads, as copies in standards/ (refreshed
// by scripts/vendor.mjs from CommonAgent/adlc):
//
//   stages.json                      the 24 stages, their roles and the evidence formats
//   lifecycle-document.schema.json   the lifecycle document, version 0.1
//   lifecycle-api.schema.json        the lifecycle API, version 0.4.3

import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../standards/${name}`, import.meta.url), "utf8"));

export const STAGES_DOC = read("stages.json");
export const DOCUMENT_SCHEMA = read("lifecycle-document.schema.json");
export const API_SCHEMA = read("lifecycle-api.schema.json");
export const STAGE_IDS = STAGES_DOC.stages.map((s) => s.id);
export const stageById = new Map(STAGES_DOC.stages.map((s) => [s.id, s]));
export const roleById = new Map(STAGES_DOC.roles.map((r) => [r.id, r]));
