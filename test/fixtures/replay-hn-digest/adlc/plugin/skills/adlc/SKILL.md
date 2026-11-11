---
name: adlc
description: Build an agent through the Agent Development Lifecycle, from a person's request to code that passes the Common Agent packer. Use in a build folder (one with .adlc/check.mjs), or when someone asks to build, make or write an agent, a skill package or a Common Agent package. Start a new one with /adlc:start.
---

# Building an agent through the ADLC

You are the builder. You write the agent's spec, its architecture, its own files, its tests and its code, in this order, in this one folder. You do not judge your own work: `node .adlc/check.mjs` does, at every stage, and the person approves the spec. What a stage settles is pinned when it passes, so a later stage never moves it.

Run every command from the build folder (the one that holds `.adlc/`). After any change, run the check. It names the stage the folder is at and what is missing there, and nothing else. Do what it says; do not work ahead of it.

## The stages

| Stage | You write | Then |
|---|---|---|
| Requirements | `request.md`, `spec.json` | The person approves it. |
| Architecture | `architecture.json`, then `node .adlc/generate.mjs record` | The check pins the record. |
| The agent's files | `prose.json`, then `node .adlc/generate.mjs files` | The check pins them, once the packer accepts them. |
| Test | `node .adlc/generate.mjs tests`, then a test file per feature under `test/` | The check pins the suite. |
| Code | the scripts under `scripts/` | The check passes and you open the pull request. |

### Requirements

1. Before anything else, write the person's own words to `request.md`, as they said them. Every requirement comes from them, and a value they did not give is asked, never invented. When the person asks for changes later, their words are added to the end of `request.md` under a heading `## The person asked for changes (<date>)`; revise the spec from them, and keep what they did not ask to change.
2. Write `spec.json` in spec-v1 (`.adlc/spec-writer/references/spec.schema.json`): the product, its purpose, features with requirements (each one sentence with shall, `F1.R1` and on, each with the words of the person's it comes from) and Gherkin acceptance scenarios (`F1.A1` and on) that check them, the constraints, the systems it reaches, its settings, and `open` for what only the person can answer. Name each system in plain system words, lowercase with hyphens, by what it is and not by its product (`code-host`, not GitHub; the product goes in its `why`), because the architecture record names it that way and the two must agree. A model is not a system of the spec: the record adds it by capability. For each system, say what its scripts need to reach it: its `credential` (the credential's name and the variable the scripts read it from, or `"none"` for a service that takes no key) and its `settings` (each non-secret value such as its address, by variable and purpose, never a value). Ask the person where their words do not say.
3. State three things even when the person did not: what it refuses (kind `refusal`), what it does when it finds nothing to work on (the empty case), and what it does when a system it reaches fails (kind `error`). Where their words do not say, ask them.
4. The name and the price are the person's. Ask for each, and put their answers in `answers.json` (`{"name": "...", "price": "..."}`).
5. When the check says Requirements is ready, show the person the spec in plain words: each feature, what it refuses, the empty and failure cases, the systems, the settings, the name and the price. Ask them to approve it by running `node .adlc/approve.mjs` themselves. You never run it; a hook stops you.

### Architecture

1. Run `node .adlc/generate.mjs brief`. It prints what `architecture.json` holds and the standard it is held to. Read the standard it names.
2. Write `architecture.json`: the systems the agent stands on (a model only by capability, never by name or provider), the kind, dependencies, limits, egress, formats and settings; what the agent is made of (its skills and their parts, and the data flow from the caller and back); the drivers the statement gives beyond the four limits; and each decision with its context, the drivers it answers, the alternatives weighed and its consequences.
3. Run `node .adlc/generate.mjs record`. It writes `architecture-record.md` and, where only the person can answer, `still-open.md`. Ask them each question there, put their answers in `answers.json` under the key the question gives, and run it again.
4. Never edit the record by hand. Change `architecture.json` or the answers, and write it again.

### The agent's files

1. Run `node .adlc/generate.mjs files`. It writes the agent's files from the spec and the record, and lays out `prose.json` with every key whose words are yours.
2. Write the words in `prose.json`: what the agent does, when to use each job, what a good result is, what comes back empty, the refusals (a list, each the act, then why, then what happens instead), each output's convention and what each system is needed for. Run it again.
3. The check holds the files to the spec writer's rules and to the Common Agent packer, and says which words to change. Never edit a generated file by hand.

### Test

1. Run `node .adlc/generate.mjs tests`. It writes the standard checks every suite carries. Read the two files it names first.
2. Write one test file per feature under `test/`. Name each test for what it checks, in square brackets: a scenario (`[F1.A1] ...`), a requirement (`[F1.R2] ...`) or a constraint (`[C1] ...`). Every scenario needs at least one test, and a test the spec does not stand behind does not belong.
3. Import the scripts the agent's files name, from `../scripts/`, and hand in every function that would reach a network, a model or a real system. The check runs the suite against empty scripts, and your tests must fail there.

### Code

1. Write the scripts under `scripts/` until the check passes: the whole suite passes, each script is noticed when it is blanked, and the packer accepts the folder.
2. The tests are pinned. If one cannot pass without breaking the spec, stop, say which test and which requirement, and ask the person to send the build back (`node .adlc/approve.mjs --send-back test`, which is theirs to run).
3. When the check says every stage has passed, commit the folder and open the pull request.

## The rules

1. Never change a pinned file, the pin file `build.lock.json`, or anything under `.adlc/`. To change what an earlier stage settled, the person sends the build back to it.
2. Node 22 or later, ES modules (`.mjs`), nothing outside node: no npm packages, no other language.
3. A model is reached only through its four settings, read from the environment on every run: `MODEL_NAME`, `MODEL_ENDPOINT`, `MODEL_KEY` (may be empty) and `MODEL_PROTOCOL` (`anthropic-messages`, `openai-chat` or `gemini`). No model's name, and no provider, is written anywhere.
4. No address in a script: a system's address is a declared setting, read from the environment. No credential anywhere, and nothing that looks like one. A script reads from the environment only what `agent-runtime-requirements.json` declares, the model's settings, and the job's folders; a run setting (`run_config` in the descriptor) arrives in the job's `run-context.json`, never as a variable. A key or an address the spec does not provide for is the spec's to add, so ask the person to send the build back.
5. A test never reaches a network or a real system. Write and change test files and scripts with your editor, never through a shell or a script that rewrites them: a shell eats the backslashes in a pattern, and a pinned test broken that way can only be fixed by sending the build back.
6. A record the agent keeps per job goes under a folder named after the job's folder, never straight into the records folder.
7. When the check and these instructions disagree, the check is right. When something only the person can decide comes up, ask them; do not decide it for them.
