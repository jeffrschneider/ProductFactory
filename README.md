# Product Factory

A product factory on the [agentic development lifecycle](https://agenticdevelopment.ai):
it runs your own lifecycle, and you bring everything around it. Your coding
harness, your model, your role holders. The specification is [SPEC.md](SPEC.md).

This is milestone 1: one build of one agent runs end to end on one computer,
with only open-source pieces. [BUILD.md](BUILD.md) lists the milestones after it.

## What milestone 1 does

`npx product-factory` starts a small service on `127.0.0.1`. It answers the
lifecycle API (version 0.4.9) that the [adlc console](https://github.com/CommonAgent/adlc-console)
reads, so the console shows your builds and lets you act at your gates. The
same command starts the console against it and opens it in your browser. It
keeps everything in files: the lifecycle document and one folder per build.

A new agent is built by one builder: your coding harness with the ADLC plugin
(see [One builder](#one-builder)). A build follows the lifecycle in effect
when it started, and runs these stages:

| Stage | Who holds it | What happens |
|---|---|---|
| Requirements | one builder | Product Factory lays out one build folder with the ADLC plugin's kit and your words in `request.md`, and the builder writes the spec there (`spec.json`): each feature with its requirements and acceptance scenarios, the interfaces, constraints, systems and settings, and what it could not settle. The folder's own check says when it is ready for you. |
| | you, in the console | You approve the spec, or ask for changes and the builder revises it. |
| Architecture and Design, Test, Code | one builder | From the spec you approved, in the same folder and in whatever order works best: the architecture record, the agent's own files, the suite and the scripts. The folder's own check judges them together, and each stage reads done when the check passes the gates at it. What only you can answer waits for you, as `key: answer`. |
| Review, Security review | the reference code critic and the reference security reviewer | Once the check passes the build, the reviewers read it, the security reviewer against the architecture record. A refusal holds the build for you, with their words. |
| Package | the Common Agent packer | The agent's files and the scripts are packed as an Agent Package and validated. |
| | you, in the console | The run plan is written beside the package. You read it with the package's build record, and approve the deploy. |
| Deploy | the runtime you bring | The package and the run plan are handed to your runtime's command. With no runtime set, Deploy waits for you to hand them over. |
| Conformance | the Common Agent checkers | Once your runtime took the package, it is held to the Common Agent 0.41.0 checks that programs run with node and no network (Section 14): the package's mechanical checks of Section 12.10, by the packer's own `validate`, and, when the build carries a package AgentDoc (Section 13.4), its static checks of Section 9.10, by `@common-agent/agentdoc`. The checks that need the running agent (the Descriptor it serves, Section 4.9; the five questions, Section 4.3; trials, Section 7.7) are named as not checked, because your runtime holds the agent. The result is the build's `attestation` artifact, `attestation.md`, unsigned because Product Factory holds no key. A check that fails refuses the stage with the attestation; nothing reads as passed that did not run. The run ends before the publish gate, which Product Factory does not hold. |

A build can also start from existing code ([Start from existing code](#start-from-existing-code))
or from an as-built record ([Start from an as-built record](#start-from-an-as-built-record)).
Those run their own process documents on the reference writers: the
reference spec writer at Requirements, the reference test writer at Test, and
at Code the existing code adopted as it is, or, for a rebuild, the reference
code writer, which runs your coding harness in its own workspace.

A stage your lifecycle leaves out reads "not used". Stages milestone 1 does
not run read "not offered", and say so in plain words: the stages between
Requirements and Package that it does not run yet (Impact, Source), and
Release, Acceptance and Docs after it. A build started on an earlier version
of a process keeps its own copy of it and is not run again.

## Run stages handed to your runtime

Product Factory does not run the product. The stages after Package (Deploy,
Publish, Retract, Monitor, Eval, Incident response, Cost, Update,
Reconfigure, Rollback, Decommission) are bindings: the stage's "hands back"
line in stages.json is the interface its holder meets, and your lifecycle
says who holds each role and with what `settings` (a JSON object on the
holder in the lifecycle document, such as `{ "every_minutes": 5 }` for the
watcher). At the end of a build Product Factory writes `run-plan.json` beside
the package. For each of those stages it records:

- the role;
- the holder;
- the settings;
- the interface (the stage's "hands back" line);
- whether the holder is chosen.

A stage your lifecycle leaves out reads "not used"; a role nobody holds reads
"not chosen". The build shows each stage as the plan records it.

Then it asks the process document's "approve the deploy" gate: you read the
package's build record and the run plan, and approve the deploy in the
console. Only then does it hand the package and the run plan to the command
under `runtime.command`, with the two paths as its last two words, and
records the answer on Deploy. A command that ends with code 0 took it; one that prints a
JSON object may say `said` (its words) and `handle` (where the product
answers). The reference runtime, `runtimes/folder.mjs`, copies both files
into a folder, so the hand-off can be seen with no platform. With no runtime
set, Deploy waits: "Hand this package to your runtime", with both paths.

Beyond install, the runtime is asked to roll back, reconfigure and retire
(the runtime verbs, CommonAgent/adlc `standards/runtime-verbs.md`). The
command always gets a package and a run plan as its last two words, and the
verb in the environment: `PRODUCT_FACTORY_VERB` (`install`, `rollback`,
`reconfigure` or `retire`), with `PRODUCT_FACTORY_PRODUCT`,
`PRODUCT_FACTORY_VERSION` and `PRODUCT_FACTORY_FROM_VERSION`. A runtime that
knows a verb answers with `"verb"`; one that reads none installs what it is
given, which is safe: for rollback that is the earlier version, for
reconfigure the new run plan, and for retire the running version again, which
Product Factory says in words is not retired. The reference runtime does all
four over its folder and keeps what runs, and every verb, in
`<folder>/<name>.runtime.json`.

## What milestone 1 does not do

No board, no tracker but GitHub Issues, no repository host but GitHub, no single sign-on,
nothing installed by Product Factory itself (Deploy hands the package to your
runtime), no try-it, and agents only (no processes or general software). By
default the build folder is a folder on this computer; one builder can work
on a pull request on GitHub instead (see
[One builder on a pull request](#one-builder-on-a-pull-request)). The package's build
record is unsigned.
Role bindings in your lifecycle other than the reference agents are kept, and
the build's log says when milestone 1 sent a stage to someone else instead.
Stages of your own in the lifecycle document are kept and named on the build,
and not run.

## Run it

You need Node 22 or later, git, and a checkout of
[CommonAgent/adlc](https://github.com/CommonAgent/adlc) (the reference agents).
The [adlc console](https://github.com/CommonAgent/adlc-console) (the page)
comes with Product Factory, so you need no checkout of it.

In the folder you want to work in, run one command:

```
npx github:jeffrschneider/ProductFactory
```

Or, from a clone: `npm install`, then `npm start` (the same as
`npx product-factory`).

It starts Product Factory and the console in one process, opens your browser
on the console, and prints one line with its address:

```
Product Factory and its console are at http://127.0.0.1:52827/ (press Ctrl+C to stop both).
```

The console holds Product Factory's key in memory, so you copy no key and
open no second terminal. The key is made on first start, kept in the data
folder, readable only by you, and sent only to this service.

The first time, with no `product-factory.json` in the folder, it writes the
starter file (what `npx product-factory init` does), starts anyway, and opens
the console on the Lifecycle page. Edit `product-factory.json` (below) and set
the model settings in your environment. Until then it says what is missing,
on the terminal and in each build that stops for it.

### Check the settings

Each start prints a plain note for each thing that will stop a build: a model
setting that is not set, an adlc checkout that is not at the `adlc` path, a
coding harness command that is not on PATH, and, when one builder works on a
pull request, a repository token variable that is not set.

```
npx product-factory check
```

prints the same notes, then makes one tiny real call to the model endpoint
(a one-word answer, at most 64 tokens) through the reference agents' shared
model caller in your adlc checkout, and says what came back in words: the
answer, or why it was refused, such as a key that was refused or an account
whose credit balance is too low. It never prints a key. It exits 0 when there
are no notes and the model answered, and 1 otherwise.

Start a build from the console's New build form, and act at the gates there.
Ctrl+C stops both. A build that was running sends its phase out again the
next time it starts.

`--port <n>` sets the service's port and `--console-port <n>` the console's
(0 takes any free port). `--no-open` prints the address without opening the
browser.

To start only the service, for a console you run some other way, give
`--no-console`. It then prints the command that opens a console against it:

```
node bin/adlc-console.mjs --service http://127.0.0.1:4510 --key-file <data folder>/service-key
```

If `npx` fails on Windows with `EISDIR: illegal operation on a directory,
symlink` or `Lock compromised`, npm's cache is on a drive formatted exFAT or
FAT32. Those drives cannot hold the links and locks `npx` makes. Point npm's
cache at a folder on an NTFS drive (`npm config set cache <folder>`), or run
`npm start` in a clone.

## Drive it from Claude Code

The [claude-plugin](claude-plugin/) folder is a Claude Code plugin: an MCP
server and a skill that start builds, say what waits on you, read builds and
stages, talk to a stage's agent or the boss, and take gate actions when you
say so, all through the lifecycle API. In Claude Code:

```
/plugin marketplace add jeffrschneider/ProductFactory
/plugin install product-factory@product-factory
```

Start Claude Code in the folder Product Factory runs in. See
[claude-plugin/README.md](claude-plugin/README.md).

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
    "holder": "builder",
    "harness": ["claude", "-p", "{prompt}", "--plugin-dir", "{plugin}", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node:*)", "--setting-sources", "project", "--strict-mcp-config"],
    "rounds": 3,
    "minutes": 30,
    "env_remove": ["ANTHROPIC_API_KEY"]
  },
  "package": { "packer": ["npx", "--yes", "@common-agent/package@0.2.0"] },
  "runtime": { "command": ["node", "runtimes/folder.mjs", "--into", "./installed"] }
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
- `code`: the harness command, how many rounds the harness gets before the
  build stops and asks you, and how long one round may take. `"holder":
  "builder"` is the only holder, and may be left out: one builder makes every
  new agent. A file that names `"harness"`, `"code-writer"` or `"pull-request"`,
  the holders Product Factory had before, is refused in words. `"where":
  "pull-request"` puts one builder on a pull request; then `repository` names
  where (see [One builder on a pull request](#one-builder-on-a-pull-request)).
- `code.env_remove`: environment variables removed before the harness command
  runs. The default is `["ANTHROPIC_API_KEY"]`, so a harness uses its own
  sign-in. Claude Code run headless prefers `ANTHROPIC_API_KEY` over your
  Claude plan whenever the variable is set, and a key with no credit then
  fails every round. Set it to `[]` to keep the key, or add other names (such
  as `OPENAI_API_KEY`) for a harness that does the same. Only the harness loses
  them; the reference agents and the check keep your whole environment.
- `package.packer`: the Common Agent packer, `common-agent-pack`, or any
  command that takes the same two command lines.
- `runtime.command` (optional): the runtime you bring, given the package's
  path and the run plan's path. It runs in the settings file's folder.

## One builder

Every new agent is built by one builder (`"code": { "holder": "builder" }`,
which `product-factory init` writes, or no holder at all). It writes everything, from the spec through the code: your coding harness
with the ADLC plugin of the `adlc` checkout (`{plugin}` in the harness command).
No reference spec writer runs, so the spec and everything built from it have one
author and one check. The build runs the reference process "make a new agent" v3
as it is published, with only its blanks filled
(`processes/make-a-new-agent-one-builder.txt`). When the build starts, Product
Factory lays out one build folder with the ADLC plugin's kit and your words in
`request.md`. The build has two phases. First the builder writes the spec there
until the folder's own check says it is ready for you, and you read it at
Requirements in the console. Approve it, or ask for changes: your words are added to the end of
`request.md` under "The person asked for changes" and the date, and the builder
revises the spec. Once you approve it, the builder writes everything else in the
same folder, in whatever order works best: the architecture record, the agent's
own files, the tests and the code. The check judges them together.

Product Factory judges nothing about the agent itself. Your approval of the spec
is pressed in the console and run in the folder (`node .adlc/approve.mjs`), so it
is binding there; the plugin's hook stops the assistant from running it. What you
approve is the spec on the branch as it stands: if the builder pushed a new spec
after the one you read, nothing is approved, and the new spec is handed to you to
approve. After you send a spec back or ask for changes, the same spec is not handed
to you again; Requirements waits for the builder's revision. The console shows
each stage done when the folder's own check (`node .adlc/check.mjs --json`) passes
the gates at it: Architecture and Design when the architecture record and the
agent's own files pass, Test when the suite does, Code when the scripts do. The
tests are fixed the first time the code is judged against them. What only you can
answer (such as whether the agent may reach a public service) waits for you at its
stage, answered as `key: answer`; your answer goes into `answers.json` with your
words, and your reply into `said.md`, where the check finds them. A stage the check
still holds when the rounds are used up waits on you in the check's words, and from
any of these stages you can send the build back with your words (`send_back`,
lifecycle API 0.5.0): to a stage of the build, which opens the build again,
tests included, and the builder goes on from there; or to Requirements, which adds
your words to request.md, the builder revises the spec, and it goes on once you
approve it.

### One builder on a pull request

With `"code": { "holder": "builder", "where": "pull-request" }` and a
`repository`, this machine runs no coding agent and holds no sign-in to one.
When the build starts, Product Factory lays the build folder out with the ADLC
plugin's kit and your words in `request.md`, and puts it on a branch of its own
in `agents/<name>/` with a "Build the agent" pull request. Your own coding
assistant writes the spec there and pushes it. When the folder's check says the
spec is ready, you read it and approve it in the console; Product Factory pins
your approval in the folder and pushes it, and your changes go to `request.md`
the same way. You build everything with your own coding assistant wherever you
are: in Claude Code, install the
ADLC plugin (`/plugin install adlc --marketplace CommonAgent/adlc`), check the
branch out, open the folder and follow its `AGENTS.md`; another assistant reads
`AGENTS.md` too. Push as you go.

```json
"code": { "holder": "builder", "where": "pull-request" },
"repository": { "host": "github", "repo": "owner/name", "token": "GITHUB_TOKEN" }
```

`token` is the name of the environment variable that holds a GitHub token,
never the token: it is read from there each time and never kept. The token
needs to read and write the repository's contents and pull requests, and, if
it may, commit statuses. Optional: `api` for a GitHub Enterprise Server
(`https://github.example.com/api/v3`), `poll_seconds` (default 30), and
`review.spending_limit`, the line the security reviewer is told (default
`10 USD per day`). GitHub calls go through the adlc console's client
(`adlc-console/lib/github.mjs`), from [lib/pull-request.mjs](lib/pull-request.mjs).

Product Factory checks the pull request for pushes every
`repository.poll_seconds`, runs the folder's own check on each push, says its
result on the pull request, and shows each stage exactly as above. What only
you can answer, and any send back, you give in the console: Product Factory
makes the change in the folder (your words in `said.md`) and pushes it to the
branch as its own commit, so pull before you go on. When the check says the
build has passed, Product Factory makes the package, and you approve the deploy
in the console. `code.harness` is not used.

## Point it at your coding harness

Your coding harness is a command that runs in the build folder as one
builder. The folder carries the ADLC plugin's kit: `AGENTS.md` says what to
write and what not to touch, and `node .adlc/check.mjs` is the check (see
[your coding agent](https://agenticdevelopment.ai/your-coding-agent.html)).
Coding agents read `AGENTS.md` on their own.

Give the command as a list of words. It runs without a shell, so nothing a
build carries can become part of a command line. These words are filled in:

| Word | What it becomes |
|---|---|
| `{prompt}` | the round's instruction: write the spec from `request.md`, or build the agent from the approved spec, running the check after each change, with what the check said last |
| `{plugin}` | the ADLC plugin of the `adlc` checkout |
| `{workspace}` | the build folder |
| `{round}` | the round's number |

The same values are in the environment as `PF_PROMPT`, `PF_WORKSPACE` and
`PF_ROUND`. On Windows, a harness installed as a `.cmd` file runs through
cmd.exe, which cannot carry a line break in a command line, so `{prompt}`
reaches it with its line breaks as spaces. A rebuild from an as-built record runs the same command for the
reference code writer, in its workspace, with its own prompt; there
`{feedback_file}` (and `PF_FEEDBACK_FILE`) is the file holding what its last
check said, or empty. Your harness keeps its own sign-in and
settings; Product Factory passes your environment through, less the variables
in `code.env_remove` (by default `ANTHROPIC_API_KEY`, so the harness signs in
its own way and not with a key that happens to be set).

```
"harness": ["claude", "-p", "{prompt}", "--plugin-dir", "{plugin}", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node:*)", "--setting-sources", "project", "--strict-mcp-config"]
"harness": ["codex", "exec", "--full-auto", "{prompt}"]
```

The Claude Code command `product-factory init` writes runs it with your normal
sign-in and without your own plugins, hooks and MCP servers, so what you have
set up for yourself does not reach a build. `--setting-sources project` reads
only the build folder's settings, not your user settings, where plugins and
hooks are turned on; `--strict-mcp-config` uses only the MCP servers named
with `--mcp-config`, and it names none. Claude Code's `--bare` would skip them
too, but it ignores your normal sign-in and reads only `ANTHROPIC_API_KEY`, so
it is not used.

After the harness ends, Product Factory runs the folder's check itself, and
what it said goes to the harness on the next round, up to `rounds`. Then the
build stops and waits on you, with "Give it more rounds", "Send back" or
"Stop". For a rebuild, the reference code writer's own steps from your adlc
checkout (its workspace, its check with its rounds, its report and its
delivery check) run around the same harness command, and a pass waits for
your OK on the code.

## Send back to Requirements from Code

On a build that runs on the reference writers (a rebuild from an as-built
record, or adopted code), Code can be refused: the rounds are used up, or the
existing code does not pass its characterization suite. When the spec, not
the code, is what has to change, **Send back to Requirements**, with your
words, reopens the spec as an ask for changes. Once you approve the revised
spec, the test writer revises the suite against it, and Code goes on; for a
rebuild, the scripts written so far carry over into the new build folder.
The run records it as a deviation. One builder's build is sent back with
**Send back** instead (see [One builder](#one-builder)).

## Start builds from issues

An open GitHub issue with a label you choose can start a build. Name the
repository as for one builder on a pull request, and add:

```json
"repository": { "host": "github", "repo": "owner/name", "token": "GITHUB_TOKEN" },
"intake": { "github_issues": { "label": "product-factory", "poll_seconds": 60 } }
```

Product Factory reads the repository's open issues with that label every
`poll_seconds` (default 60; no webhook needed). Each one starts a build: the
issue's title is what the agent should do, and its body is the rest of the
request. An issue starts one build at most; the build keeps its issue, and its
log names it with a link. The build comments on the issue when a gate waits on
a person, naming the gate, and when the build ends, with how it ended. The
token needs to read issues and write issue comments.

## Gate notices

Product Factory can tell someone when a gate starts waiting and when a build
ends. Add one or more notices:

```json
"notify": [
  { "kind": "webhook", "url_env": "SLACK_WEBHOOK_URL" },
  { "kind": "command", "command": ["node", "send-mail.mjs"] }
]
```

Each notice carries a short JSON message:

```json
{ "build": "b_…", "name": "word-counter", "event": "waiting", "gate": "Approve the spec",
  "waiting_on": "Ana Lee (ana@example.com) or an approver in the team Platform",
  "stage": "requirements", "state": "waiting", "link": "…",
  "text": "word-counter (b_…) waits at Requirements: Approve the spec. Who may answer: Ana Lee (ana@example.com) or an approver in the team Platform." }
```

At the end `event` is `ended`, `state` is `done` or `stopped`, and `gate` is
null. `waiting_on` names the gate's approvers when the lifecycle names any
(people and teams, from people.json), and otherwise says `anyone`. A build
that is refused counts as waiting, and anyone may run it again. `link` is the
build's issue when it came from one, otherwise its address on the lifecycle API.

- `webhook` posts the message to the address in the environment variable
  `url_env` names (never the address itself). A Slack or Teams incoming
  webhook shows `text`.
- `command` runs the command, as a list of words and without a shell, with
  the message on stdin. Use it for email or anything else.

Each notice goes out once. Its key (a gate's wait at a stage and round, or the
build's end) is kept in build.json under `notices` before it is sent, so a
repeated save or a restart never sends it twice. A notice goes out once the
build has stopped moving, so a run that ends at Package and goes straight on to
your runtime is told only where it stops. A notice that fails is said in the
build's log, and the build goes on.

## How a build is run

Each build runs a process document, with its blanks filled for one computer
([processes/SOURCE.json](processes/SOURCE.json) lists each fill). A new agent
runs "make a new agent" v3, as published at
[agentprocesses.ai](https://agentprocesses.ai/make-a-new-agent.html), in
[processes/make-a-new-agent-one-builder.txt](processes/make-a-new-agent-one-builder.txt):
`write-the-spec` and `approve-the-spec`, a person's gate, then
`build-the-agent`, which one builder holds, then `make-the-package`,
`approve-the-deploy`, `deploy-the-agent` and `check-conformance`. A build
started from existing code runs
[processes/adopt-existing-code.txt](processes/adopt-existing-code.txt), and one
started from an as-built record runs
[processes/rebuild-from-as-built-record.txt](processes/rebuild-from-as-built-record.txt);
both have `write-the-spec`, `approve-the-spec`, `write-the-suite` and
`write-the-scripts` on the reference writers. A build started on an earlier
version of a document keeps its own copy of it in its folder.

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
runner's next actions, applies an event, and says which stage and which holder
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

Phases no `after:` path connects never wait for each other (Agent Processes
6.2): when the runner has more than one phase ready, the driver sends each now.

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

## Products, stages and each stage's agent

A product is every build of one name, such as `word-counter`: one build per
version. Each build's stages are workspaces, and the lifecycle API 0.4 answers
them:

```
GET  /v1/lifecycle/products                                   every product, its newest build and its versions
GET  /v1/lifecycle/products/<name>                            its builds, the newest run plan, and a short activity feed
GET  /v1/lifecycle/builds/<id>/stages/<stage>                 what the stage was given, what it handed back, its gate
GET  /v1/lifecycle/products/<name>/stages/<stage>/messages    the chat with the agent holding the stage
POST /v1/lifecycle/products/<name>/stages/<stage>/messages    { "text": "...", "build": "<id>" }: that agent answers
```

The build answer also carries `artifacts`: what the build has made and will
make, in stage order, each with a summary a person can read (the spec, the
agent's own files, the suite, the programs, the review findings, the security
record, the package and the run plan). Every summary is read from the build's own
files; a stage Product Factory does not run says so in words.

From lifecycle API 0.4.13, a made artifact also carries `checks`: the Common
Agent 0.41.0 rules its stage applied, each with its section, its rule where
the section numbers them, what it asks in plain words, the result (met, not
met or not checked) and one line on what was done, so the console can show a
table of rules per document and a tally for the version. Each check is read
from the stage's own records, never assumed, and a rule those records do not
speak to is left out:

| Artifact | Its checks, and where each is read |
|---|---|
| The agent's own files | Systems named in system words (Section 12.4), from the runtime requirements' `systems[]`: each a lowercase name with no address or account, and none a product the architecture record binds. Without an architecture record nobody has said which names are products, so that part reads not checked. No credential, key, address or account in a declaration (Section 6.4, rule 3), from every value of the draft Descriptor, except a `can_use` entry's `schema` and an example's public file. An example for each offering a person starts (Section 6.13.8), from each offering's `started_by` and `example`; an offering with no `started_by` is offered to a person (Section 6.13.2). |
| Architecture record | Systems named in system words (Section 12.4), from the record's systems, held against the products its bindings name. |
| Security record | Every permission asked for has a reason (Section 12.4), from the reviewer's `no_reason_recorded`. No address in its scripts (Section 12.6, rule 2), from the reviewer's address `warnings` and the code critic's Warnings on the same commit. The review names the archive's digest (Section 12.6, rule 5), from the review's `digest` and the package's, once the build holds the package. |
| The package | The package validates (Section 12.10), from the packer's validate result (`validation.json`). The packer, `@common-agent/package` 0.1.0, implements Section 12 as of Common Agent 0.30.0-draft, so the check is only as current as it, and the check says so. |
| Conformance attestation | One per section the attestation reports: the deployed package's mechanical checks (Section 12.10) and the package AgentDoc's static checks (Section 9.10), met or not met where they ran, or not checked with why; the bound, signed Descriptor (Section 4.9), the five questions (Section 4.3) and trials (Section 7.7), not checked, because your runtime holds the agent. |

The chat at a stage is kept with the product across its builds; each message
names the build and version it was said in. The agent answers through the
reference agents' shared model caller in your adlc checkout, with the same
four model settings, from the stage's outputs, what it was given and the
build's record. Answering changes nothing. When you ask for a change, the
reply proposes the build's existing action for it (Requirements: Ask for
changes, or Send back to Requirements once Code was refused; Code: Give it
more rounds, when Code was refused), with its words filled in, and only when you may take that
action now. You confirm it with the action, so a change always goes back
through its gate. A stage held by a person, an outside tool, or your own
coding harness is not answered here, and the reply says so.

## Cadence: every build, set up once, when needed

stages.json 1.3.0 gives each stage a cadence, and every stage of a build and
of each stage workspace carries it (`cadence`):

- **Every build**, the routine: Requirements, Test, Code, Review, Security
  review, Package, Release, Deploy, Conformance, Acceptance and Docs. These are
  a build's steps. Review and Security review run on one builder's build once
  its folder's check passes it, and their stages say what the reviewers said
  on the build Code's work is from: done, or refused with the reviewer's
  words. The findings and the security record are their outputs. A reviewer
  not asked says why. On a build that runs on the reference writers, the suite
  is the gate and they are not asked.
- **Set up once** per product: Source, Architecture and Design, Publish,
  Monitor, Eval, Incident response, Cost and Update. Who holds each, and with
  what settings, comes from the lifecycle and is carried forward. A new
  version whose holder and settings for one of them are the same as an earlier
  version's reads "Unchanged since 0.1.0" (`carried`), so nothing is asked
  again. Changing a holder or its settings holds from the next version.
- **When needed**, actions on the product: Impact, Retract, Reconfigure,
  Rollback and Decommission. They run when something happens, not as build
  steps (below).

`GET /v1/lifecycle/products/<name>` lists both: `setup`, each setup stage with
its role, its holder or null, its settings, `chosen`, `not_chosen` or
`not_used`, and the version it has held since (null when it holds from the
next version), as the lifecycle of the newest build's project has it now; and
`when_needed`, each action with `can_run` and, when it cannot run, `why_not`.
A holder is chosen with `PUT /v1/lifecycle/roles/<role>`.

## Guided setup and the when-needed actions

Lifecycle API 0.4.4. Each setup item carries a `form`: who may hold it (the
role's reference agent, your agent, a person or an outside tool), a few
settings with defaults, and the question the console's "Ask the boss" sends
("Who should monitor word-counter?"). The defaults (`lib/setup.mjs`):

| Stage | Settings |
|---|---|
| Source | where to look first |
| Architecture and Design | what to build on |
| Publish | where it's listed, who can see it |
| Monitor | check every N minutes, alert after M minutes without an answer, alert where |
| Eval | what it grades against, how often, sample |
| Incident response | who decides |
| Cost | monthly ceiling, warn at a percent, what happens at the ceiling |
| Update | who approves an update |

A form is saved with `PUT /v1/lifecycle/roles/<role>`, each stage's settings
under its own id in the holder's settings, so the watcher keeps Monitor's and
Cost's apart. A build keeps the lifecycle it started with, so its run plan and
every later version take the saved choices.

The when-needed actions run from the product page, each behind a confirm card
that says who may act (the lifecycle's `approvers` for the stage, as for a
gate), what will happen in the stage's own words, and for Rollback the version
it goes back to and what can't be undone. Confirming posts
`POST /v1/lifecycle/builds/<id>/actions/<stage>` on the build the list names;
the result is kept on that build, shows in the activity feed, and is the
item's `last`.

| Action | Runs when | What it does |
|---|---|---|
| Impact | a version runs, and a newer one has its declaration | runs the reference impact analyst (`agents/impact-analyst` in the adlc checkout) on the two declarations, with an empty list of dependents, and hands back its report |
| Rollback | a runtime is set, and an earlier version was installed | the runtime's `rollback` verb, with the earlier version's own package and run plan |
| Reconfigure | a runtime is set, and the setup chosen now differs from the running run plan | the runtime's `reconfigure` verb, with the same package and a new run plan |
| Retract | a version runs | handed to the Publisher holder you chose; otherwise a manual step you confirm, recorded |
| Decommission | a runtime is set, and a version runs | the runtime's `retire` verb; every record is kept and the product is marked retired |

Which version runs is the newest whose Deploy is done and that was not rolled
back or retired; the product answer says so in `running`.

## The boss

Each product has a boss: the agent you talk to about the whole product,
holding Agent Roles §39 ([the boss](https://agentroles.ai/boss.html)). It sits
on top of the runner, which keeps running each build's stages. The lifecycle
API 0.4.1 answers it:

```
GET  /v1/lifecycle/products/<name>/boss/messages      your conversation with the boss
POST /v1/lifecycle/products/<name>/boss/messages      { "text": "..." }, or { "text": "Yes.", "confirms": "<proposal id>" }
GET  /v1/lifecycle/products/<name>/boss/commitments   everything it committed on your behalf, in full
```

From the product's record, the boss does three things:

- It answers a question about the product (versions, stages, artifacts, who
  holds what, why something waits) and says where in the record the answer
  comes from.
- It routes a directive to the stage whose agent owns it, such as a case the
  tests should cover: it posts it into that stage's chat, with the product,
  the build, its version and your own words, and the reply says where it went
  (`routed`). That stage's agent answers in its chat.
- It breaks a larger request across the stages (`plan`), in the order the
  lifecycle runs them, naming the gate you will meet at each. When the
  request changes the agent's statement, it proposes starting the next
  version, with the newest build as its prototype; you confirm that with
  `confirms`, and it starts the build through the same start path as
  `POST /builds` (`started`). Then it proposes Ask for changes on the new
  build's Requirements with your words, which you confirm with the build's
  own action once the spec writer's first draft waits on you.

It never answers a gate, never changes an artifact, and takes no action of a
build itself: you take each one with the actions route, so every change goes
back through its gate. It commits no money, accepts no price, starts no build
you have not confirmed, and messages nobody outside the product's stages.
Asked to do any of those, it says no and why. Anyone who may see the product
may talk to it; a gate's action is proposed only to someone who may answer
that gate. Its conversation is kept in the build records beside the stage
chats, and each commitment is written once: every message it posted, every
proposal with your answer, and every build it started with the confirmation.

## Features

The spec carries a feature list (lifecycle API 0.4.3; the statement of the
job did until 0.4.8): each feature has a stable id (F1, F2, ...), a name,
what it does, and the offering it belongs to. When the spec writer hands back
the spec, each of its features the product does not already hold in the same
words comes to you as proposed, by the spec's own id. A feature the spec
keeps from an as-built record is answered through its behavior instead.
More are settled in a chat, mostly the Requirements chat with the spec
writer, or with the boss. When the conversation lands on a new or changed
feature, the reply proposes it with two buttons:

- **Approve feature**: a gate decision of Requirements for that one feature,
  kept with who, when and the message (`POST /builds/:id/features/:feature/approve`).
  The spec gets a new version with it.
- **Not now**: it stays proposed, a backlog item linked to the conversation.

Someone who may not answer the Requirements gate sees **Ask <approver> to
approve** instead: the approvers are told through the gate notices (event
`feature_approval`) and see the same proposal, with its approve button, on
the same message. At the end of Requirements the gate asks only what is
still open and to start building with the features; those approved in a chat
are not asked again, and the ones still waiting are approved with the gate.

The approved features reach the spec writer and the test writer as lines of
the run's material aimed at their phases (`[write-the-spec] ...`,
`[write-the-suite] ...`), which the process runner hands to that phase
alone; the reference agents read them as part of what they were asked. The
test writer names each test by the acceptance scenario of the spec it checks
(`[F3.A1] counts an empty passage as none`), which counts for feature F3, and
a test of a feature the spec has no scenario for by the feature's id (`[F3]
...`), so every round at Code reports its results per feature (`by_feature`,
and "By feature: F1 2 of 2 pass" in its words). A test
of an interface the spec keeps (`[I4] ...`) checks no feature, and is not
counted among the tests that check none.

`GET /products/:name/features[?version=]` and `GET /builds/:id/features`
answer the Features matrix: one row per feature, with a new, changed or
unchanged badge against the version before, and one cell for each of Spec,
Tests, Code, Review and Docs that is done, stale, missing or failing ("Tests
6/6") and opens that artifact at that feature. `GET
/products/:name/features/:feature` is a feature's history across stages and
versions: proposed, approved, tests added, code changed, reviewed, each linked
to its message or artifact. Everything is kept as events in each build's
record (`feature_log`), never rewritten (lib/features.mjs).

### Features at every stage (lifecycle API 0.4.5)

Each every-build stage shows its own slice of the features. The build answer
gives each stage a short count for the spine ("Test · 4 of 5 features"), and
the stage's workspace lists one line per feature, which the console shows in
the stage's Artifacts tab:

- **Requirements**: each feature and whether it is approved.
- **Test**: the tests that check each approved feature; a feature with none
  is marked to do, and the tests that check no feature are listed as not tied
  to one.
- **Code**: how many of each feature's tests pass ("Refuse non-text: 6 of 6").
- **Review**: the code critic's findings tied to a feature through its tests
  (the finding's place is a line inside one of its tests, or the finding quotes
  a test's name); every other finding is "not tied to a feature".
- **Docs**: which features the docs name, once Docs runs.

### Features for a build made before them

A product built before features existed has none. (A build whose spec is
still at Requirements has not reached features yet, and its Features page
says so: they come from its spec there.) When it has a spec, or from before
0.4.8 a statement of the job, and a spec writer that answers, its Features matrix offers
`backfill`, and the console's Requirements stage shows **List this product's
features**. The same is on the command line:

```
npx product-factory features backfill <product>
```

Both ask the spec writer in the Requirements chat
(`POST /builds/:id/features/backfill`), through the same stage chat and model
caller. Its reply proposes every feature of the spec, each
with id, name, what it does and its offering, and maps the tests already in
the build to them where their names or content make it clear. A name the
suite does not have is dropped, and a test that is not clear is left
unmapped and shown as such, never guessed. The features arrive as proposed:
**Approve all** (`POST /builds/:id/features/approve_all`) approves them
together, each recorded as a chat approval, as one new version of the
spec; or each can be answered on its own. Approving a listed feature
does not mark the tests or code made before it as stale, since it describes
what was already built.

## Start from existing code

A build can start from code that already exists (stages.json 1.4.0, the
starting point `existing-code`; lifecycle API 0.4.6). New build offers
"Start from existing code": a repository (a git URL or owner/name, and a
commit when you want one other than the newest), or a folder on this
computer, and what the product is called. The start request is
`{ name, starting_point: "existing-code", source: { repository, commit } }`
or `source: { folder }`.

The build runs the process "adopt existing code"
(`processes/adopt-existing-code.txt`), which is "make a new agent" with a
first phase:

| Stage | Who holds it | What happens |
|---|---|---|
| 00 Reverse engineering | the reference reverse engineer (CommonAgent/adlc `agents/reverse-engineer`) | The code is read at its commit (cloned with git, or copied from a folder that is not a repository, whose commit is then sha256 over its files) and the build records that commit. The reverse engineer hands back the as-built record: `behaviors.json`, `architecture.json`, `interfaces.json`, `sbom.cdx.json`, `tests-and-gaps.json` and `record.json`, and, from reverse engineer 0.3.0, the code's own tests under `tests/` and the files they import under `support/`, which are carried into the suite (see The original's own tests are in the gate). It is one artifact, kind `as_built`, with a readable summary per part. |
| Requirements | the spec writer, then you | Each behavior arrives as a proposed feature marked as built, with its evidence. You answer each one: **Approve feature** (it is intended), **This is a bug** (kept as a proposed fix item linked to the behavior, never approved by this or by the gate), or **Drop**. The spec is approved once every behavior is answered. |
| Test | the reference test writer | It is given the behaviors, the interfaces, the architecture as built, and the existing tests and gaps, whole (the spec writer is given them too), and writes characterization tests that pin each approved behavior, each named by its feature id. |
| Code | the existing code | The build folder starts from the code at that commit: the scripts the spec names are taken from it, and the gate runs them against the characterization suite. Code that cannot be packaged as an agent (no Node scripts, such as a Python service) stops here and says why in words. Product Factory adopts agents only. |

Package and the steps after it are the same as for any build: the result is
an Agent Package.

**Drift.** The product page's when-needed **Reverse engineer the change**
turns on when the codebase's commit now differs from the last one any build
knew, and says so in words (`source` on the product). Running it starts the
next version from the code as it is, at Reverse engineering, with the last
as-built record attached, so only what changed is described; each changed
behavior reaches Requirements marked as built, the same way.

The reverse engineer is run the way every reference agent is: its runtime
requirements' run declaration names the job script, and it gets `--job`,
`--records`, `--work`, `--text-file` and a `--file` per file. The
message names the trigger (adoption or drift), the repository, the commit and
the folder the code is in; the code also goes as an archive, and on drift the
last record's six files go with it.

## Start from an as-built record

A build can also start from the as-built record of code kept elsewhere, to
build that code again without taking it on: a rewrite, a port, or a
clean-room rebuild (stages.json 1.5.0, the starting point `as-built-record`;
lifecycle API 0.4.7). New build offers "Start from an as-built record": the
record's folder on this computer, or a repository with a commit and the path
of the record in it, and what the product is called. The start request is
`{ name, starting_point: "as-built-record", source: { folder } }` or
`source: { repository, commit, path }`.

The record is read when the build starts, and a record that is not whole is
refused in words: it must hold `record.json` naming the repository and commit
it describes, and its five parts (`behaviors.json`, `architecture.json`,
`interfaces.json`, `sbom.cdx.json`, `tests-and-gaps.json`). Any other JSON
file in the folder, such as the output schemas the reverse engineer derived,
goes with it whole, and so does every file of its `tests/` and `support/`
folders: the original's own tests, and each file they import from outside the
codebase with the whole closure of what those import (reverse engineer
0.3.0). The same limits hold them: 100 files beside the six, 20 MB in all.

### The original's own tests are in the suite

The original's own tests are the strongest check on a rebuild, so they are
carried into the suite unchanged. For a build with an as-built record, brought
or made by Reverse engineering, the test writer is given each test that
`tests-and-gaps.json` lists under `carried`, every file under `support/`, and a
carried manifest made from that list (`stages/test/carried-r<n>.json`):

```json
{ "carried_tests": "v1",
  "tests": [{ "file": "test/x.test.mjs", "at": "tests/test/x.test.mjs", "sha256": "<hex>",
              "imports": [{ "from": "../../lib/a.mjs", "support": "support/lib/a.mjs" }] }],
  "support": [{ "path": "support/lib/a.mjs", "sha256": "<hex>" }] }
```

The spec writer is not given them. The reference test writer (0.10.0) places
each test at `test/<name>` with only the listed import specifiers rewritten,
each support file at `test/support/<path from the repository's top>`, and
their record at `test/carried-tests.json`. The hand-off is then given the
suite as one archive, so the build folder keeps the support files' layout and
`build.lock.json` pins them like the tests. Only `test/*.test.mjs` is run as
the suite, so a file under `test/support/` is never run as a test. In the
features view the carried tests keep the names the original gave them and are
counted as original tests, `original` beside `untied` on the Test slice and on
the matrix, not tied to a feature. Send back to Requirements with "drop the
original test <name>" in your words takes that one test out of the suite when
the test writer revises it, recorded in `test/carried-tests.json`; no
revision changes one.

The build runs the process "rebuild from an as-built record"
(`processes/rebuild-from-as-built-record.txt`), "make a new agent" v1 with the
record given to the spec and the suite, on the reference writers:

| Stage | Who holds it | What happens |
|---|---|---|
| 00 Reverse engineering | the as-built record you brought | Not run here. The record is kept as the build's `as_built` artifact, which says it was brought, and the build's `source` names the code the record describes and where the record was read. |
| Requirements | the spec writer, then you | The spec writer is given the behaviors, the interfaces, the architecture as built, and the existing tests and gaps, whole, and asked to keep the interfaces and settings exactly as the record gives them. Each behavior arrives as a proposed feature marked as built, answered as for existing code. |
| Test | the reference test writer | It is given the same parts and writes tests that pin each approved behavior, for code written fresh. |
| Code | the reference code writer, running your coding harness | The code is written fresh in the code writer's workspace, and waits for your OK. Nothing is adopted: the code the record describes is never copied in. |

The product's drift and its when-needed Reverse engineering are about code
a build took on, so a build started from a record has none.

## Analytics

Product Factory keeps a history of every build in an SQLite file beside the
build files, `<data>/history.sqlite`, through Node's built-in `node:sqlite`:
no server and no dependency. The build files stay the source of truth. Each
time a build moves, its rows are written again from its `build.json`; if the
file is missing it is built again from the build folders, and a build changed
while Product Factory was stopped is caught up when it starts. Deleting the
file loses nothing.

The history has four tables: `builds` (project, status, start, end),
`stages` (holder, start, end, time, time waiting on a person and time with an
agent working, rounds, rounds sent back), `rounds` (each round of a stage, as
the build's record keeps it) and `steps` (each bar of the build's timeline,
with its split between a person and an agent).

It answers one read-only route:

```
GET /v1/lifecycle/analytics?window=7d|30d|all&project=<name>
```

This route is Product Factory's own. It is not part of the lifecycle API
standard, and another lifecycle service need not answer it; the adlc console
shows its Analytics page only when the service does. `window` is 30d when not
given, and `project` narrows every answer to one project's builds. Weeks start
on Monday, 00:00 UTC. It answers four things, never estimated:

- `builds`: per week, the builds started, finished and stopped.
- `stage_times`: per stage, per week, the median time of the stages that
  finished that week (every round, the agent's work and any wait on a person,
  as the console's Dashboard counts it).
- `send_backs`: per stage over the window, the rounds, the rounds sent back,
  and the rate.
- `waiting`: per week, the time spent waiting on a person and the time an
  agent was working, from the timeline steps that ended that week.

`node:sqlite` is built into Node 22.13 and later. On Node 22.5 to 22.12 start
Product Factory with `node --experimental-sqlite`; on an older Node it says so
when it starts, keeps no history, and does not offer the route.

## Teams

An organization, its teams and projects, and people with roles, kept in
`people.json` beside the lifecycle document:

```json
{
  "organization": "Example Org",
  "people": [
    { "name": "Ana Lee", "email": "ana@example.com", "role": "approver" },
    { "name": "Max Kim", "email": "max@example.com", "role": "member" }
  ],
  "teams": [{ "name": "Platform", "members": ["ana@example.com", "max@example.com"] }],
  "projects": [{ "name": "billing", "teams": ["Platform"] }]
}
```

| Role | May |
|---|---|
| member | start builds, stop and resume them, and see everything |
| approver | also answer the gates the lifecycle names them for |
| admin | also change the lifecycle, and people (with the command line) |

Who may approve each gate is set per lifecycle, in the lifecycle document's
`approvers`, by stage id. A project's list for a stage replaces the
organization's. Anyone may answer a gate whose stage is listed nowhere;
otherwise only an approver or admin named there, or in a team named there.

```json
"organization": { "approvers": { "requirements": [{ "team": "Platform" }], "code": [{ "person": "ana@example.com" }] } }
```

Each person has their own key. An admin makes it, and it is printed once:

```
npx product-factory person add ana@example.com --role approver --name "Ana Lee"
npx product-factory team add Platform --member ana@example.com --member max@example.com
npx product-factory project add billing --team Platform
npx product-factory people            # list them, and any problem with the file
npx product-factory person key ana@example.com      # a new key; the old one stops working
npx product-factory person revoke ana@example.com   # no key works
```

The person keeps the key in a file and opens the console with
`--key-file <that file>`. Every call is then made as them: the console's top
bar says who they are, a gate they may not answer says who may instead of
showing the button, and the People page lists people, teams and roles. A
refused act answers 403 with the reason in words. The service's own key
keeps working, as an admin. `people.json` is checked on start and on every
request, and problems are shown in words; `GET /v1/lifecycle/people` returns
them too.

Single sign-on is not built. It plugs in at `identify()` in
`lib/people.mjs`: verify the organization's OIDC ID token instead of a key,
and look the person up in `people.json` by its email.

## What is on disk

```
<data>/service-key                 the service's key, made once; it acts as an admin
<data>/people-keys.json            each person's key, kept only as its SHA-256
<data>/history.sqlite              the history analytics reads, rebuilt from the build folders when missing
<data>/builds/<id>/build.json      the build's record: the lifecycle it started under, each stage, the run
<data>/builds/<id>/run/            the process document, and the run as the process runner keeps it
<data>/builds/<id>/stages/         every job folder, record, log and file each stage made
<data>/builds/<id>/build/          one builder's build folder
```

## Standards it uses

- Lifecycle API 0.5.0 and stages.json 1.8.0 (CommonAgent/adlc, copies in `standards/`).
- One pin of the ADLC: `standards/ADLC.json` names the commit of CommonAgent/adlc those
  copies came from (`node scripts/vendor.mjs --adlc <checkout>` writes it), and the
  start-up check says when the `adlc` checkout is at another commit, so the standards,
  the reference agents and the ADLC plugin kit a build folder carries are one version.
- The spec, spec-v1 (CommonAgent/adlc `standards/spec.schema.json`): what Requirements
  hands back. `lib/spec.mjs` is the one place the spec writer's `spec.json` and
  `spec.md` are found and read; it tells the spec apart from any other `spec.json` by
  its format.
- The lifecycle document 0.1, through the adlc console's store, with `approvers`
  (CommonAgent/adlc#121). The console's store checks each entry's shape, so a
  wrong entry makes the file invalid, named in words, like any other wrong
  field. Product Factory then checks what a schema cannot: that each person
  and team is in `people.json`, and that a named person may answer gates.
- Agent Processes, through the process runner, for "make a new agent", "adopt existing code" and "rebuild from an as-built record".
- The Common Agent package format, through `@common-agent/package`, and the AgentDoc checks of Common Agent 9.10, through `@common-agent/agentdoc` (0.1.0, pinned).

Where milestone 1 differs from one of them:

- **The spec.** One builder writes the agent's own files in its build folder
  with the rest of the build, and they are shown at Architecture and Design,
  where stages.json 1.6.0 puts them. On the reference writers (adopting or
  rebuilding), the spec writer drafts them in the same job as the spec, at
  Requirements. Their artifact (`statement`) sits at Architecture and Design,
  as lifecycle API 0.4.8 says, and is listed even where the lifecycle leaves
  that stage out. The spec artifact's summary also carries the spec's systems,
  settings and price in words, which `SpecSummary` does not name.

- **Lifecycle API.** One builder's holder is `your_agent` with no handle (the
  API's check allows that on a build's stage), and Package's holder is
  `outside_tool` (the packer), not the reference package maker, which needs
  Python. The roles answer is the lifecycle document's: it does not show your
  harness as a binding, because a binding to your own agent needs a handle. A
  stage's `where` is null, except at Code on a build made before with its
  Code on a pull request. Stages of your own are not in the stages answer,
  which lists stages.json's stages only.
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
  code, because the document has no way back from there; you can stop. Send
  back to Requirements from a refused Code takes `[conflict]` back to the
  spec's gate, then `[changes]` to the spec writer, and the run records both,
  in your words.
- **The process runner.** The run asks the document's "approve the deploy"
  gate. Once you say yes, the run closes with the outcome `ended` before
  deploy-the-agent, with its open phases listed, and the package goes to your
  runtime; the runner leaves the outcome's words to whoever closes a run.

## Tests

```
npm test
```

node:test, with fake holders: stand-in spec writer, test writer and code
writer scripts at the same paths as the real ones
(`test/fixtures/fake-adlc`, with a stand-in ADLC plugin kit), a stand-in
builder (`test/fixtures/stub-builder.mjs`, which writes the scripts as the
stand-in harness does when the reference code writer runs it) and a
stand-in packer. They cover the file store, the lifecycle file, every API
answer run through the console's contract checks and the lifecycle API's own
check (`standards/lifecycle-api-check.mjs`), and builds walked through every
stage: one builder's spec and build, its questions, send backs and
reviewers; a rebuild's reference code writer, rounds running out and Send
back to Requirements; a left-out stage, a project's lifecycle, stopping,
archiving, and starting again mid-stage. One builder on a pull request runs
against a fake GitHub (`test/fixtures/fake-github.mjs`, a local HTTP stub
with a small git in memory). The history's
tests build it again from the build files, answer the four analytics
questions over hand-made builds where every number is known, and call the
analytics route. Teams: the people
document, keys, each permission, and gate approvers by person and by team. Issues and
notices run against the same fake GitHub and a fake webhook receiver: a
labelled issue starting one build, an unlabelled one starting none, the
comments at a gate and at the end, the webhook and command notices, and a
notice that fails without stopping the build. Features: a chat proposing one,
Approve feature with its new spec version, Not now, the Ask path with
its notice, tests named per feature and the results per feature, the matrix's
cells and badges, a feature's history, the small Requirements gate, and the
boss proposing one. The spec (`test/spec.test.mjs`): the stand-in spec writer
files `spec.json` and `spec.md` beside the agent's own files, and the tests
read them into the spec artifact, propose its features by their ids, give
`spec.json` to the test writer, check that the build folder carries the spec
pinned, map tests named `[F1.A1]` and `[I1]`, and run a spec writer from
before stages.json 1.6.0 that hands back no spec.
Set `PF_TEST_TMP` to keep test folders somewhere other than the system's.

## License

Apache-2.0. See LICENSE. The process runner's files under vendor/ are
Apache-2.0, with its LICENSE beside them.
