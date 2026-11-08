---
review: "security-review-v1"
package: "word-counter"
version: "0.1.0"
digest: "sha256:58775446ce7841129f101ce05abaae196b6fdb32d0525cb7ad006cf4a2d9d5f8"
verdict: "passed"
reviewed_at: "2026-11-08T21:29:08.322Z"
architecture_record: "absent"
spending_limit: "10 USD per day (the message)"
reaches:
  - system: "folder records"
    access: "write"
    reason: "every record the descriptor names"
  - system: "folder work"
    access: "write"
    reason: "inputs and drafts in progress"
spends:
  - ceiling: "the owner's spending limit"
    limit: "10 USD per day"
    reason: "set by the owner (the message)"
never_does:
  - act: "Counting anything that is not a sentence of text"
    reason: "If multiple sentences or non-text content are provided, it stops and returns an error explaining that only a single sentence is accepted."
  - act: "Processing binary files, images, or any media types other than plain text"
    reason: "It does not attempt to extract text from images or documents, and will immediately reject them."
  - act: "Guessing the word count of an empty or missing input"
    reason: "It does not provide a zero or a default value when no text is handed over, but instead stops and says what this agent takes."
  - act: "Accepting a credential value or a system address pasted into the text input"
    reason: "It reads the input strictly as a sentence to be counted and does not execute or connect to any provided address."
  - act: "Reaching an address no declared system covers"
    reason: "what it may reach is what its systems name, and nothing else was agreed"
  - act: "Holding a credential value in its files, its records or a reply"
    reason: "credentials are placed by name at install and read from the variable the package names, so a value in the package is one nobody can rotate"
  - act: "Starting a program other than its own runtime"
    reason: "it declares no binaries"
  - act: "Working on after it is stopped"
    reason: "an owner who stops an agent must be able to rely on it stopping"
no_reason_recorded: []
refused_for: []
warnings: []
---

# Security review: word-counter 0.1.0

Reviewed 2026-11-08T21:29:08.322Z, before the agent is installed and before any credential is bound to it. This review grants nothing and changes nothing: it says what the agent may reach, what it may spend and what it must never do, and the reason for each.

## Verdict

**Passed.** Every permission the package asks for has a recorded reason, its programs reach only what its declaration names, and its owner has set a spending limit.

## Reaches

| What | Access | Reason | Credential | Caller's material sent to it |
|---|---|---|---|---|
| folder records | write | every record the descriptor names | none | no |
| folder work | write | inputs and drafts in progress | none | no |

## Spends

| Ceiling | Limit | Reason | Held by |
|---|---|---|---|
| the owner's spending limit | 10 USD per day | set by the owner (the message) | the account: its monthly spending limit refuses a hold past it, and the agent's allowance (Common Agent EXT-8) refuses or asks the owner when a ceiling is spent |

## Never does

| Never | Reason | From | Held by |
|---|---|---|---|
| Counting anything that is not a sentence of text | If multiple sentences or non-text content are provided, it stops and returns an error explaining that only a single sentence is accepted. | the package's refusals | this package's own programs |
| Processing binary files, images, or any media types other than plain text | It does not attempt to extract text from images or documents, and will immediately reject them. | the package's refusals | this package's own programs |
| Guessing the word count of an empty or missing input | It does not provide a zero or a default value when no text is handed over, but instead stops and says what this agent takes. | the package's refusals | this package's own programs |
| Accepting a credential value or a system address pasted into the text input | It reads the input strictly as a sentence to be counted and does not execute or connect to any provided address. | the package's refusals | this package's own programs |
| Reaching an address no declared system covers | what it may reach is what its systems name, and nothing else was agreed | this review | nothing on a fleet host or Cloud Run today (the deployment record says egress open, enforced by none); a platform worker job's traffic is logged and allowed; a tenant agent in a customer's project is denied everything but the mesh. Until an allow-list is enforced, this package's own programs are what hold it |
| Holding a credential value in its files, its records or a reply | credentials are placed by name at install and read from the variable the package names, so a value in the package is one nobody can rotate | this review | the package maker and the deployment manager: a credential is a NAME, a value anywhere in the package or the instruction is refused, and the install places it from the owner's store into the one variable the package names |
| Starting a program other than its own runtime | it declares no binaries | this review | the host lays out only the declared binaries; nothing stops a script starting one already there |
| Working on after it is stopped | an owner who stops an agent must be able to rely on it stopping | this review | the kill switch: a pause or terminate cuts the agent's credential doors and its transport, the supervisor starts no new work and ends what is running, and brokered access lapses within ten minutes. A container in a customer's own cloud is not taken down, and a placed model key is not revoked |

## No reason recorded

Every permission the package asks for has a recorded reason.

## Programs

2 programs read; 6 test files left out, since tests are not the agent at work.

- No program reaches the network.

No script carries a network address literal (Common Agent 12.10).

## Parts

It brings in no code it did not write: no lockfile, no declared dependency.

## Accepted knowingly

Nothing this review lets through carries a risk it has to name.

## Reasons weighed

No model weighed the reasons, so each reason above is listed as the package states it and nobody has judged whether it accounts for the access.

## Not reviewed

- No architecture record was given, so nothing checks the package's systems against what the agent was designed to reach; the package's own declaration is the only statement of it.
- The programs were read as text and not run. An address a program builds from parts it computes is not seen here; the egress allow-list is what holds it.
