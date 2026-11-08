# Product Factory

A product factory on the [agentic development lifecycle](https://agenticdevelopment.ai):
it runs your own lifecycle, and you bring everything around it. Your coding
harness, your model, your role holders. The specification is [SPEC.md](SPEC.md).

This is milestone 1: one build of one agent runs end to end on one computer,
with only open-source pieces. [BUILD.md](BUILD.md) lists the milestones after it.

## What milestone 1 does

`npx product-factory` starts a small service on `127.0.0.1`. It answers the
lifecycle API (version 0.4.1) that the [adlc console](https://github.com/CommonAgent/adlc-console)
reads, so the console shows your builds and lets you act at your gates. The
same command starts the console against it and opens it in your browser. It
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
| | you, in the console | The run plan is written beside the package. You read it with the package's build record, and approve the deploy. |
| Deploy | the runtime you bring | The package and the run plan are handed to your runtime's command. With no runtime set, Deploy waits for you to hand them over. |

A stage your lifecycle leaves out reads "not used". Stages milestone 1 does
not run read "not offered", and say so in plain words: the stages between
Requirements and Package that it does not run yet (Architecture, Impact,
Source, Review, Security review), and Release, Conformance, Acceptance and
Docs after it.

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

## What milestone 1 does not do

No board, no tracker but GitHub Issues, no repository host but GitHub, no single sign-on,
nothing installed by Product Factory itself (Deploy hands the package to your
runtime), no try-it, and agents only (no processes or general software). By
default the build folder is a folder on this computer, and its path is in the
Code stage's log; Code can be a pull request on GitHub instead (see
[Code on a pull request](#code-on-a-pull-request)). The package's build
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
  "package": { "packer": ["npx", "--yes", "@common-agent/package@0.1.0"] },
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
- `code`: who holds Code, the harness command, how many rounds the harness
  gets before the build stops and asks you, and how long one round may take.
  `"holder": "pull-request"` puts Code on a pull request; then `repository`
  names where (see [Code on a pull request](#code-on-a-pull-request)).
- `package.packer`: the Common Agent packer, `common-agent-pack`, or any
  command that takes the same two command lines.
- `runtime.command` (optional): the runtime you bring, given the package's
  path and the run plan's path. It runs in the settings file's folder.

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

## Code on a pull request

Code can be a real GitHub pull request that your own coding harness works on:
Claude Code, Codex, Devin, or anything that pushes commits. Set:

```json
"code": { "holder": "pull-request", "minutes": 30 },
"repository": { "host": "github", "repo": "owner/name", "token": "GITHUB_TOKEN" }
```

`token` is the name of the environment variable that holds a GitHub token,
never the token: it is read from there each time and never kept. The token
needs to read and write the repository's contents and pull requests, and, if
it may, commit statuses. Optional: `api` for a GitHub Enterprise Server
(`https://github.example.com/api/v3`), `poll_seconds` (default 30), and
`review.spending_limit`, the line the security reviewer is told (default
`10 USD per day`).

What happens at Code:

1. Product Factory lays out the build folder as in local mode (`AGENTS.md`,
   `.adlc/check.mjs`, `build.lock.json`) and opens a branch and a "Write the
   scripts" pull request holding it, in `agents/<name>/`. The repository's
   other files are left as they are.
2. You point your harness at the pull request. `AGENTS.md` is the contract.
3. Product Factory checks the pull request for a new push every
   `poll_seconds` (no webhook needed). On each one it runs the gate: the
   fence (only `scripts/` may change, and new tests under `test/`), a scan of
   the scripts for credential values, hidden characters and undeclared
   addresses, the suite and the suite again with each script blanked, and
   then the code critic and the security reviewer, where the lifecycle uses
   Review and Security review and the reference agent is in your adlc
   checkout. It says the result on the pull request as a comment, and as the
   commit status "Product Factory gate" where the token may post one.
4. The console shows the pull request and the latest check on the Code stage.
5. When the gate passes, the build waits for your OK. Your OK takes the
   scripts from that exact commit, merges the pull request there, and goes on
   to Package. A push after the pass needs its own pass first.
6. If your harness writes `records/conflict.md` (a test it cannot pass without
   breaking the spec), the gate stops and says so. **Send back to Test**, with
   your words, has the test writer revise the suite; the revised tests go on
   the same pull request as one commit, with the lock updated and the
   conflict removed, and the gate runs again.

The logic comes from the hand-off AgentMesh built, ported as plain
JavaScript: [lib/pull-request.mjs](lib/pull-request.mjs) (opening, revising
and taking the pull request), [lib/fence.mjs](lib/fence.mjs),
[lib/gate.mjs](lib/gate.mjs) and [lib/gate-suite.mjs](lib/gate-suite.mjs)
(the gate), and [lib/review.mjs](lib/review.mjs) (the reviewers). GitHub calls
go through the adlc console's client (`adlc-console/lib/github.mjs`). Local
mode is unchanged.

## Start builds from issues

An open GitHub issue with a label you choose can start a build. Name the
repository as for Code on a pull request, and add:

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
make, in stage order, each with a summary a person can read (the statement of
the job, the suite, the programs, the review findings, the security record,
the package and the run plan). Every summary is read from the build's own
files; a stage Product Factory does not run says so in words.

The chat at a stage is kept with the product across its builds; each message
names the build and version it was said in. The agent answers through the
reference agents' shared model caller in your adlc checkout, with the same
four model settings, from the stage's outputs, what it was given and the
build's record. Answering changes nothing. When you ask for a change, the
reply proposes the build's existing action for it (Requirements: Ask for
changes; Test: Send back to Test, from Code; Code: Give it more rounds, when
Code was refused), with its words filled in, and only when you may take that
action now. You confirm it with the action, so a change always goes back
through its gate. A stage held by a person, an outside tool, or your own
coding harness is not answered here, and the reply says so.

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
```

## Standards it uses

- Lifecycle API 0.4.1 and stages.json 1.2.0 (CommonAgent/adlc, copies in `standards/`).
- The lifecycle document 0.1, through the adlc console's store, with `approvers`
  (CommonAgent/adlc#121). The console's store checks each entry's shape, so a
  wrong entry makes the file invalid, named in words, like any other wrong
  field. Product Factory then checks what a schema cannot: that each person
  and team is in `people.json`, and that a named person may answer gates.
- Agent Processes, through the process runner, for "make a new agent".
- The Common Agent package format, through `@common-agent/package`.

Where milestone 1 differs from one of them:

- **Lifecycle API.** Code's holder is `your_agent` with no handle (the API's
  check allows that on a build's stage), and Package's holder is
  `outside_tool` (the packer), not the reference package maker, which needs
  Python. The roles answer is the lifecycle document's: it does not show your
  harness as the code writer's binding, because a binding to your own agent
  needs a handle. A stage's `where` is null, except at Code on a pull request,
  where it is that pull request with its newest commit and check. Stages of your own are not in the stages answer, which lists
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
  code, because the document has no way back from there; you can stop. The
  document has no way back from Code to Test either, only `[conflict]` back
  to the spec's gate, where "the suite or the spec is revised". So Send back
  to Test on a pull request takes `[conflict]`, and the same answer passes the
  spec's gate again with the spec as approved; the test writer then revises
  the suite from your words. The run records both, in your words.
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
(`test/fixtures/fake-adlc`), a stand-in harness and a stand-in packer. They
cover the file store, the lifecycle file, every API answer run through the
console's contract checks and the lifecycle API's own check
(`standards/lifecycle-api-check.mjs`), and builds walked through every stage:
both gates, asking for changes, a failed suite round, rounds running out, a
left-out stage, a project's lifecycle, the reference code writer, a refused
spec started again, stopping, archiving, and starting again mid-stage. Code
on a pull request runs against a fake GitHub (`test/fixtures/fake-github.mjs`,
a local HTTP stub with a small git in memory), with stand-in reviewers:
opening the pull request, a failing push and a passing one, the fence
refusing changes outside what the coding step may change, a reviewer's open
finding, your OK taking the passing commit and refused for a newer one, Send
back to Test, and starting again while it waits on pushes. The history's
tests build it again from the build files, answer the four analytics
questions over hand-made builds where every number is known, and call the
analytics route. Teams: the people
document, keys, each permission, and gate approvers by person and by team. Issues and
notices run against the same fake GitHub and a fake webhook receiver: a
labelled issue starting one build, an unlabelled one starting none, the
comments at a gate and at the end, the webhook and command notices, and a
notice that fails without stopping the build.
Set `PF_TEST_TMP` to keep test folders somewhere other than the system's.

## License

Apache-2.0. See LICENSE. The process runner's files under vendor/ are
Apache-2.0, with its LICENSE beside them.
