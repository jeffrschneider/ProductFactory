// The open standards Product Factory reads, as copies in standards/ (refreshed
// by scripts/vendor.mjs from CommonAgent/adlc):
//
//   stages.json                      the 25 stages (Reverse engineering is 0), their roles, the evidence formats and the starting points
//   lifecycle-document.schema.json   the lifecycle document, version 0.1
//   lifecycle-api.schema.json        the lifecycle API, version 0.4.10 (from 0.4.8 Requirements hands back the spec; from 0.4.9 a stage's
//                                    holder lists its skills; from 0.4.10 each feature of a version is made in a run of its own)

import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(`../standards/${name}`, import.meta.url), "utf8"));

export const STAGES_DOC = read("stages.json");
/** The one pin of the ADLC (standards/ADLC.json): the commit the copies here came from, which the adlc checkout must be at. */
export const ADLC_PIN = read("ADLC.json");
export const DOCUMENT_SCHEMA = read("lifecycle-document.schema.json");
export const API_SCHEMA = read("lifecycle-api.schema.json");
export const STAGE_IDS = STAGES_DOC.stages.map((s) => s.id);
export const stageById = new Map(STAGES_DOC.stages.map((s) => [s.id, s]));
export const roleById = new Map(STAGES_DOC.roles.map((r) => [r.id, r]));
