---
name: adlc
description: Build an agent through the Agent Development Lifecycle, from a person's request to code that passes the Common Agent packer. Use in a build folder (one with .adlc/check.mjs), or when someone asks to build, make or write an agent, a skill package or a Common Agent package. Start a new one with /adlc:start.
---

# Building an agent through the ADLC

You are the builder. You write the whole agent in this one folder: its spec, its architecture, its own files, its tests and its code. You do not judge your own work. `node .adlc/check.mjs` does, and the person approves the spec.

A build has two phases.

1. **The spec.** You write it from the person's words, and the person approves it. Nothing is built on a spec the person has not approved.
2. **The build.** You write everything else in whatever order works best for you. The check runs every gate over the folder and names what is still missing at each one.

Only two things have a fixed order. The person approves the spec before you build on it. The tests are fixed the first time the code is judged, so they can't be changed to fit the code. Everything else is yours to order.

Run every command from the build folder (the one that holds `.adlc/`). Run the check as often as you like. It says which phase the folder is in and, in the build, what each gate still needs.

## Phase 1: the spec

1. Before anything else, write the person's own words to `request.md`, as they said them. Every requirement comes from them, and a value they did not give is asked, never invented. When the person asks for changes later, their words are added to the end of `request.md` under a heading `## The person asked for changes (<date>)`; revise the spec from them, and keep what they did not ask to change.
2. Write `spec.json` in spec-v1 (`.adlc/spec-writer/references/spec.schema.json`): the product, its purpose, features with requirements (each one sentence with shall, `F1.R1` and on, each with the words of the person's it comes from) and Gherkin acceptance scenarios (`F1.A1` and on) that check them, the constraints, the systems it reaches, its settings, and `open` for what only the person can answer. Name each system in plain system words, lowercase with hyphens, by what it is and not by its product (`code-host`, not GitHub; the product goes in its `why`), because the architecture record names it that way and the two must agree. A model is not a system of the spec: the record adds it by capability. For each system, say what its scripts need to reach it: its `address` for a service at one fixed address, its `credential` (the credential's name and the variable the scripts read it from, or `"none"` for a service that takes no key) and its `settings` (other non-secret values, by variable and purpose, never a value). Ask the person where their words do not say.
3. State three things even when the person did not: what it refuses (kind `refusal`), what it does when it finds nothing to work on (the empty case), and what it does when a system it reaches fails (kind `error`). Where their words do not say, write your recommendation and tell the person, so they can judge it when they approve.
4. The name and the price are the person's. Ask for each, and put their answers in `answers.json` (`{"name": "...", "price": "..."}`).
5. When the check says the spec is ready, show the person the spec in plain words: each feature, what it refuses, the empty and failure cases, the systems, the settings, the name, the price, and every place where you chose because their words didn't say. Ask them to approve it by running `node .adlc/approve.mjs` themselves. You never run it; a hook stops you.

## Phase 2: the build

Write these in any order. The check judges them together.

**The architecture record.** Run `node .adlc/generate.mjs brief` for what `architecture.json` holds and the standard it is held to, and read that standard. Write `architecture.json`: the systems the agent stands on (a model only by capability, never by name or provider), the kind, dependencies, limits, egress, formats and settings; what the agent is made of (its skills and their parts, and the data flow from the caller and back); the drivers beyond the four limits; and each decision with its context, the drivers it answers, the alternatives weighed and its consequences. Then `node .adlc/generate.mjs record` writes `architecture-record.md` and, where only the person can answer, `still-open.md`. Each question there is the person's to answer. Where their words already answer one, in `request.md` or in what they have told you since (the plugin keeps that in `said.md`, which you never write), put the answer in `answers.json` under the key the question gives, with those words exactly: `{"answer": "yes", "said": "It reaches one system, the public npm registry"}`. Ask them every other question and wait, then put their reply the same way. The check finds those words in `request.md` or `said.md`, and an answer whose words are in neither is one they have not given. Then write the record again. Never edit the record by hand.

**The agent's files.** `node .adlc/generate.mjs files` writes them from the spec and the record, and lays out `prose.json` with every key whose words are yours. Write those words: what the agent does, when to use each job, what a good result is, what comes back empty, the refusals (a list, each the act, then why, then what happens instead), each output's convention and what each system is needed for. Generate the files again after any change. Never edit a generated file by hand.

**The tests.** `node .adlc/generate.mjs tests` writes the standard checks every suite carries; read the two files it names. Write one test file per feature under `test/`. Name each test for what it checks, in square brackets: a scenario (`[F1.A1] ...`), a requirement (`[F1.R2] ...`) or a constraint (`[C1] ...`). Every scenario needs at least one test, and a test the spec does not stand behind does not belong. Import the scripts the agent's files name from `../scripts/`, and hand in every function that would reach a network, a model or a real system. The suite must fail against empty scripts.

**The code.** Write the scripts under `scripts/` until the whole suite passes, every script is needed by some test, and the packer accepts the folder.

The check's gates, in the build:

| Gate | It passes when |
|---|---|
| Architecture | The record is the one the generator writes from `architecture.json` and the person's answers, every answer carries words the person said, it is complete, and it names the same systems as the spec. |
| The agent's files | Every file is what the generators write from the spec, the record and `prose.json`, and the Common Agent packer accepts them. |
| Test | Every scenario has a test, every test belongs to the spec, the suite fails against empty scripts, and no test fails on a mistake of its own. |
| Code | The suite passes, every script is needed by some test, the scripts read only what the agent's files declare, and the packer accepts the folder with its scripts. |

The code is judged only once the tests pass their gate, and from then on the tests are fixed. If a test then turns out to be wrong, say which test and which requirement, and ask the person to send the build back (`node .adlc/approve.mjs --send-back build`, which is theirs to run). If the spec turns out to be wrong, ask them to send it back to the spec (`--send-back spec`). When the build has been sent back, the check holds it until something in it has changed, so make the change the person asked for; it never passes the build or fixes the tests again on the files as they were.

When the check says the build has passed, commit the folder and open the pull request.

## The rules

1. Never change the approved spec, the fixed tests, the lock file `build.lock.json`, `said.md`, or anything under `.adlc/`. To change the spec or a fixed test, the person sends the build back.
2. Node 22 or later, ES modules (`.mjs`), nothing outside node: no npm packages, no other language.
3. A model is reached only through its four settings, read from the environment on every run: `MODEL_NAME`, `MODEL_ENDPOINT`, `MODEL_KEY` (may be empty) and `MODEL_PROTOCOL` (`anthropic-messages`, `openai-chat` or `gemini`). No model's name, and no provider, is written anywhere.
4. No address in a script: a system's address is a declared setting, read from the environment. No credential anywhere, and nothing that looks like one. A script reads from the environment only what `agent-runtime-requirements.json` declares, the model's settings, and the job's folders; a run setting (`run_config` in the descriptor) arrives in the job's `run-context.json`, never as a variable. A key or an address the spec does not provide for is the spec's to add, so ask the person to send the build back to the spec.
5. A test never reaches a network or a real system. Write and change test files and scripts with your editor, never through a shell or a script that rewrites them: a shell eats the backslashes in a pattern, and a fixed test broken that way can only be fixed by sending the build back.
6. A record the agent keeps per job goes under a folder named after the job's folder, never straight into the records folder.
7. When the check and these instructions disagree, the check is right. When something only the person can decide comes up, ask them; do not decide it for them.
