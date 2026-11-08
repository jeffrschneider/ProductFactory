# Product Factory

A product factory on the [agentic development lifecycle](https://agenticdevelopment.ai):
it runs your own lifecycle, and you bring everything around it. Your coding
harness, your model, your role holders. The specification is [SPEC.md](SPEC.md).

This is milestone 1: one build of one agent runs end to end on one computer,
with only open-source pieces. [BUILD.md](BUILD.md) lists the milestones after it.

## What milestone 1 does

`npx product-factory` starts a small service on `127.0.0.1`. It answers the
lifecycle API (version 0.3) that the [adlc console](https://github.com/CommonAgent/adlc-console)
reads, so the console shows your builds and lets you act at your gates. It
keeps everything in files: the lifecycle document and one folder per build.

A build follows the lifecycle in effect when it started, and runs these stages:

| Stage | Who holds it | What happens |
|---|---|---|
| Requirements | the reference spec writer | It writes the agent's own files from your words, and names what it could not settle. |
| | you, in the console | You approve the spec, or ask for changes and it is revised. |
| Test | the reference test writer | It writes the suite from the spec alone. |
| Code | your coding harness | The build folder is laid out with `AGENTS.md`, and your harness writes the scripts in it. The suite runs after each round; if it fails, the harness gets another round, up to the number you set. |
| | you, in the console | You give your OK on the code. |
| Package | the Common Agent packer | The agent's files and the scripts are packed as an Agent Package and validated. |

A stage your lifecycle leaves out reads "not used". Stages milestone 1 does
not run read "not offered", and say so in plain words: the stages between
Requirements and Package that it does not run yet (Architecture, Impact,
Source, Review, Security review), and Deploy and everything after it, which a
later milestone hands to the runtime you bring.

## What milestone 1 does not do

No board, no analytics, no tracker or repository host, no teams or accounts,
no deploy, no try-it, and agents only (no processes or general software).
There is no pull request: the build folder is a folder on this computer, and
its path is in the Code stage's log. The package's build record is unsigned.
Role bindings in your lifecycle other than the reference agents are kept, and
the build's log says when milestone 1 sent a stage to someone else instead.
Stages of your own in the lifecycle document are kept and named on the build,
and not run.

## Run it

You need Node 22 or later, git, a checkout of
[CommonAgent/adlc](https://github.com/CommonAgent/adlc) (the reference agents),
and a checkout of [CommonAgent/adlc-console](https://github.com/CommonAgent/adlc-console)
(the page).

```
git clone https://github.com/jeffrschneider/ProductFactory.git
cd ProductFactory
npm install                    # fetches adlc-console at a pinned commit; nothing else
npx product-factory init       # writes product-factory.json here
```

Edit `product-factory.json` (below), set the model settings in your
environment, and start it:

```
npx product-factory            # or: npm start
```

It prints its address and the command that opens the console against it:

```
node bin/adlc-console.mjs --service http://127.0.0.1:4510 --key-file <data folder>/service-key
```

Run that in your checkout of adlc-console. The key is made on first start,
kept in the data folder, readable only by you, and sent only to this service.
Start a build from the console's New build form, and act at the gates there.

Press Ctrl+C to stop Product Factory. A build that was running sends its
phase out again the next time it starts.

## product-factory.json

One small file. It names where things are and which environment variables
hold the model settings. It never holds a key: a model setting is the name of
an environment variable, and a value there is refused.

```json
{
  "adlc": "../adlc",
  "lifecycle": "./lifecycle.json",
  "data": "./builds",
  "port": 4510,
  "model": { "name": "MODEL_NAME", "endpoint": "MODEL_ENDPOINT", "key": "MODEL_KEY", "protocol": "MODEL_PROTOCOL" },
  "code": {
    "holder": "harness",
    "harness": ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node:*)"],
    "rounds": 3,
    "minutes": 30
  },
  "package": { "packer": ["npx", "--yes", "@common-agent/package@0.1.0"] }
}
```

- `adlc`: your checkout of CommonAgent/adlc. Paths are read from the folder the file is in.
- `lifecycle`: the lifecycle document, made with the defaults if it is missing.
- `data`: where builds are kept, one folder each.
- `model`: the environment variable each of the four model settings is read
  from. The reference agents read them as `MODEL_NAME`, `MODEL_ENDPOINT`,
  `MODEL_KEY` (may be empty) and `MODEL_PROTOCOL` (`anthropic-messages`,
  `openai-chat` or `gemini`), and Product Factory passes them through under
  those names. With one missing, Requirements and Test stop and name it.
- `code`: who holds Code, the harness command, how many rounds the harness
  gets before the build stops and asks you, and how long one round may take.
- `package.packer`: the Common Agent packer, `common-agent-pack`, or any
  command that takes the same two command lines.

## Point it at your coding harness

Your coding harness is a command that runs in the build's folder. The folder
carries the hand-off contract: `AGENTS.md` says what to write and what not to
touch, and `node .adlc/check.mjs` is the check (see
[your coding agent](https://agenticdevelopment.ai/your-coding-agent.html)).
Coding agents read `AGENTS.md` on their own.

Give the command as a list of words. It runs without a shell, so nothing a
build carries can become part of a command line. These words are filled in:

| Word | What it becomes |
|---|---|
| `{prompt}` | one line: read AGENTS.md and write the scripts until the check exits 0; on a later round, also the file that says what is still wrong |
| `{workspace}` | the build folder |
| `{feedback_file}` | the file holding what the last check said, or empty |
| `{round}` | the round's number |

The same values are in the environment as `PF_PROMPT`, `PF_WORKSPACE`,
`PF_FEEDBACK_FILE` and `PF_ROUND`. Your harness keeps its own sign-in and
settings; Product Factory passes your environment through.

```
"harness": ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node:*)"]
"harness": ["codex", "exec", "--full-auto", "{prompt}"]
```

After the harness ends, Product Factory runs `node .adlc/check.mjs` itself.
Exit 0 is a pass and the build waits for your OK. Anything else is a failed
round: its words go to the harness on the next round, up to `rounds`. Then
the build stops and waits on you, with "Give it more rounds" or "Stop".

To have the reference code writer hold Code instead, set `"holder":
"code-writer"`. It runs the code writer's own steps from your adlc checkout
(its workspace, its check with its rounds, its report and its delivery check)
around the same harness command.

## How a build is run

Each build runs a process document: "make a new agent", as published at
[agentprocesses.ai](https://agentprocesses.ai/make-a-new-agent.html), in
[processes/make-a-new-agent.txt](processes/make-a-new-agent.txt) with its
blanks filled for one computer ([processes/SOURCE.json](processes/SOURCE.json)
lists each fill). Its levels make the two gates: `approve-the-spec` is a
person's gate, and `write-the-scripts` is supervised, so the scripts wait for
your OK before they are packed.

The open-source process runner
([AgentMesh-Community/process-runner](https://github.com/AgentMesh-Community/process-runner),
Apache-2.0) runs it: its parser reads the document, its planner and run state
decide every next step. Its pure modules are copied unchanged under
[vendor/process-runner](vendor/process-runner); `SOURCE.json` there records the
version and commit, and `node scripts/vendor.mjs --process-runner <checkout>`
upgrades it. Product Factory does not copy the parts of the runner that send
mesh messages, and reaches no service: it supplies only the delivery.

That boundary is one file, [lib/orchestrator.mjs](lib/orchestrator.mjs), the
only one that imports the runner. It opens a run from the document, gives the
runner's next action, applies an event, and says which stage and which holder
adapter a phase belongs to. [lib/runner.mjs](lib/runner.mjs) drives it: it asks
for the next action, hands a phase to its adapter, and tells the runner what
came back. [lib/adapters.mjs](lib/adapters.mjs) holds the holder adapters, the
reusable part: the reference agent scripts, the hand-off, your coding harness
command and the packer, each reached the way it says it is run. The person's
gate is the console: an answer there is an event the runner reads (approved,
a deviation for changes, resumed, stopped).

Why this way: the runner already holds the hard part (order from `after:`
lines, gates, holds, ways back, refusals, resuming), and reusing it keeps one
implementation of the Agent Processes rules. Product Factory stays small, and
a newer runner, or another runner that gives the same answers, drops in at
one file.

A phase at a stage milestone 1 does not run, or at a stage the build's
lifecycle leaves out, ends the run there. The run's record names the phases
left open; for a full build those are `approve-the-deploy` and after.

## The lifecycle

The lifecycle is a lifecycle document (CommonAgent/adlc
`standards/lifecycle-document.schema.json`, version 0.1). Product Factory
keeps no store of its own for it: it uses the adlc console's file store
(`lib/lifecycle-file.mjs`, from the adlc-console package pinned in
`package.json`), and adds only what a service says: which stages it cannot
build without (Requirements, Test and Code, with why), and the stages and
roles answers holding only what stages.json names, as the API says.

The console's Lifecycle page works against the service: choose stages for
the organization or a project, and who holds each role. A build keeps the
choices in effect when it started.

## What is on disk

```
<data>/service-key                 the key, made once
<data>/builds/<id>/build.json      the build's record: the lifecycle it started under, each stage, the run
<data>/builds/<id>/run/            the process document, and the run as the process runner keeps it
<data>/builds/<id>/stages/         every job folder, record, log and file each stage made
```

## Standards it uses

- Lifecycle API 0.3 and stages.json 1.2.0 (CommonAgent/adlc, copies in `standards/`).
- The lifecycle document 0.1, through the adlc console's store.
- Agent Processes, through the process runner, for "make a new agent".
- The Common Agent package format, through `@common-agent/package`.

Where milestone 1 differs from one of them:

- **Lifecycle API.** Code's holder is `your_agent` with no handle (the API's
  check allows that on a build's stage), and Package's holder is
  `outside_tool` (the packer), not the reference package maker, which needs
  Python. The roles answer is the lifecycle document's: it does not show your
  harness as the code writer's binding, because a binding to your own agent
  needs a handle. A stage's `where` is always null: the API knows only a pull
  request there. Stages of your own are not in the stages answer, which lists
  stages.json's stages only.
- **Agent Package.** The packer (0.1.0) implements Common Agent 0.30.0-draft.
  It packs each skill as written, so Product Factory first places each skill's
  scripts and references under `skills/<slug>/`, as plugin.json's build entry
  names them; the reference package maker does that in Python. A file the
  build entry names that no stage handed on is not packed, and the reply says
  which. The build record is unsigned.
- **The process document.** The blanks are filled (processes/SOURCE.json).
  "Approve the spec" in the console answers two phases at once: the spec
  writer's draft, which the document makes assisted (held for the person), and
  the approve-the-spec gate. There is no "another round" at your OK on the
  code, because the document has no way back from there; you can stop.
- **The process runner.** A run that reaches Deploy closes with the outcome
  `ended` and its open phases listed; the runner leaves the outcome's words
  to whoever closes a run.

## Tests

```
npm test
```

node:test, with fake holders: stand-in spec writer, test writer and code
writer scripts at the same paths as the real ones
(`test/fixtures/fake-adlc`), a stand-in harness and a stand-in packer. They
cover the file store, the lifecycle file, every API answer run through the
console's contract checks and the lifecycle API's own check
(`standards/lifecycle-api-check.mjs`), and builds walked through every stage:
both gates, asking for changes, a failed suite round, rounds running out, a
left-out stage, a project's lifecycle, the reference code writer, a refused
spec started again, stopping, archiving, and starting again mid-stage.
Set `PF_TEST_TMP` to keep test folders somewhere other than the system's.

## License

Apache-2.0. See LICENSE. The process runner's files under vendor/ are
Apache-2.0, with its LICENSE beside them.
