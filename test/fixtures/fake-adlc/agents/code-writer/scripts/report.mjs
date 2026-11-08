// A stand-in for report.mjs.
const { RECORDS } = process.env;
if (!RECORDS) { console.error("RECORDS is required"); process.exit(2); }
console.log(JSON.stringify({ ok: true, code: 0, reply: "Wrote scripts/count.mjs; the suite passes." }));
