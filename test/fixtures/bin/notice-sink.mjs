// A stand-in notice command: appends the message it reads on stdin to the file named first.
import { appendFileSync } from "node:fs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
appendFileSync(process.argv[2], Buffer.concat(chunks).toString("utf8"));
