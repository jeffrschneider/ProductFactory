# Product Factory: specification

Version 0.1, 2026-11-08.

## 1. What it is

Product Factory turns a request into a shipped, managed product. It runs an
organization's own development lifecycle, the
[agentic development lifecycle](https://agenticdevelopment.ai) (ADLC) as that
organization has tailored it, and every role in that lifecycle and every tool
around it is one the organization brings.

The factory does not write code, host models, run CI or track issues. It
holds the lifecycle together: it starts builds, sends each stage to its
holder, waits at the gates, keeps the record, and shows the team where every
build stands.

## 2. The story: bring your own X

Every outside capability is something the organization brings. The factory
defines what it needs from each, and ships a reference choice where one
exists, so it works on day one and nothing is locked in.

| You bring | What the factory needs from it | Reference choice |
|---|---|---|
| Coding harness | Takes a "write the code" pull request and pushes commits until the gate passes, reading the AGENTS.md hand-off contract | Claude Code, Codex, Devin or any agent that works on a pull request; the reference code writer |
| Model | An endpoint the reference agents call | Any provider the organization uses |
| Role holders | An agent, a person or a tool for each role in the lifecycle | The reference agents at github.com/CommonAgent/adlc |
| Lifecycle | Which stages are used, stages of your own, who holds each role | The ADLC's 24 stages, as a lifecycle document |
| Repository host | Branches, pull requests and status checks | GitHub, GitLab, Bitbucket, or plain git |
| Issue tracker | A ticket can start a build, and the build reports back on it | Jira, Linear, GitHub Issues, or none |
| Checking tools | Scanners and test tools whose results come back as evidence in open formats | Any tool that writes SARIF, CycloneDX, SPDX, SLSA, in-toto, OpenTelemetry or Pact |
| Orchestrator | Runs a process document step by step | Any orchestrator for the Agent Processes format |
| Storage | Somewhere to keep lifecycles and build records | Files on disk |
| Identity | Who people are, and which team they belong to | The organization's single sign-on, or local accounts |
| Runtime | Where a finished product is installed and kept running | Any platform that installs the product's package; AgentMesh for agents and processes |
| Notifications | Where a person is told a gate is waiting | Email, Slack, Teams, or the console alone |

Two rules hold for every row:

1. **No vendor code in the factory.** A holder is reached through its role's
   published contract (agentroles.ai) or as an agent with a handle; a tool's
   results arrive as evidence in an open format the factory reads once. Adding
   a new vendor never changes the factory.
2. **Existing standards are used as they are.** Agent-to-agent calls use A2A;
   processes use Agent Processes; packages use the Common Agent package
   format; evidence uses the formats named above. Where the factory must
   differ from a standard, the difference is named in this spec and agreed
   before it ships.

## 3. What it builds

A build makes one version of one product. The kinds of product are pluggable:
each kind names its standard shape, its package and where it is installed.

| Kind | Its shape | Its package | Installed on |
|---|---|---|---|
| Agent | Common Agent | Agent Package | AgentMesh, or any platform that installs Agent Packages |
| Process | Agent Processes document | Signed process record | An orchestrator |

Version 0.1 builds these two.

**Design assumption: general software comes later.** Product Factory will
build general software too (a web service, a container, a library, an app).
That is out of scope for version 1, but nothing in version 1 may assume the
product is an agent or a process. A new kind is added by naming its shape,
its package and its install target; the lifecycle, the stages, the roles and
the factory stay the same.

## 4. Terms

The factory uses the terms defined at
[agenticdevelopment.ai/terms.html](https://agenticdevelopment.ai/terms.html):
lifecycle, stage, phase, role, holder, reference agent, gate, hands back,
done when, asset, build, process, step, orchestrator. Two more:

- **Factory:** this product: the layer that runs lifecycles for a team.
- **Board:** the team's view of every build, one column per phase.

## 5. Features

### 5.1 Lifecycles (built in the open-source console)

- An organization defines its lifecycle: which stages it uses, stages of its
  own, and who holds each role. A project can differ from the organization.
- The lifecycle is a document (`lifecycle-document.schema.json` in
  CommonAgent/adlc), kept in files. No database is required. Keeping the files
  in git is the team's choice.

### 5.2 Intake

- A build starts from words typed in the console, from a ticket in the
  team's tracker, or from an API call.
- A build started from a ticket links back to it, and posts on it when a gate
  waits and when the build ends.
- The request carries whatever the person attached: notes, a document, an
  earlier version, a prototype.

### 5.3 Builds

- Each build runs the lifecycle the team had when the build started. A later
  change to the lifecycle never changes a build under way.
- Each stage is sent to its holder. A stage held by the team's coding harness
  becomes a pull request with the hand-off contract; the gate (the suite, the
  code critic, the security reviewer, whichever the lifecycle uses) runs on
  every push.
- Every stage shows who held it, what it was given, what it handed back, and
  each round it took.
- A person can send work back a stage (Code back to Test) with words saying
  why.

### 5.4 Gates

- A gate waits for a named person or team: approve the spec, the OK on the
  code, approve the install, accept the result.
- The waiting person is told through the team's notifications, and can
  answer from the console or the notification.

### 5.5 Board

- One column per phase (Define, Make, Ship, Prove, Use, Run, Change), one card
  per build, placed by the stage it is at.
- Each card shows what is waiting and on whom. A filter shows only the builds
  waiting on me.

### 5.6 Analytics

Read from the build records, never estimated:

- Time per stage and per build, and where builds wait longest.
- Rounds per stage, and how often work is sent back.
- Spend per build and per stage, where the holders report it.
- How each holder performs: passes, refusals, time.

### 5.7 Teams

- An organization, its teams and projects, and roles for people (member,
  approver, admin).
- Who may approve which gate is set per lifecycle.

### 5.8 Record and audit

- Every build keeps its record: the lifecycle it ran under, every stage's
  holder, input, output and evidence, every approval and who gave it.
- The record ends with the product's package and its signed build record, so
  a platform that installs the product can check where it came from.

### 5.9 After the build

- The lifecycle's run stages (Monitor, Eval, Incident, Cost, Update, Rollback,
  Decommission) are bindings the build records: who holds each, with what
  settings. The factory hands them to the runtime the team brought; it does
  not run the product itself.

## 6. How it is put together

| Part | What it does | Status |
|---|---|---|
| Console | The page people use: lifecycles, builds, gates, board, analytics | Open source, github.com/CommonAgent/adlc-console; lifecycles and builds exist, board and analytics to build |
| Lifecycle API | What any factory service answers, so the console and other tools can read builds and act at gates | Published at agenticdevelopment.ai/api.html (0.3 in review) |
| Lifecycle store | Lifecycles and build records | Files, per the lifecycle document schema |
| Orchestrator | Runs each build as a process document | An open-source orchestrator ships with Product Factory; any Agent Processes orchestrator can replace it |
| Reference agents | Default holders for the roles | Open source, github.com/CommonAgent/adlc |
| Connectors | Tracker, repository host, notifications, identity | To build; each one small, each behind its own published interface |

## 7. Open source

All of Product Factory is open source under Apache-2.0: the console, the
lifecycle store, the orchestrator, the connectors and the reference agents.
Nothing needed to define a lifecycle or run a build is closed.

## 8. Not in scope

- Writing code. That is the coding harness's job.
- Hosting models, running CI, tracking issues, running the finished product.
- A competing protocol, package format or process format.
- General software as a kind of product, in version 1 (see the design
  assumption in section 3).

## 9. Decisions

1. All of Product Factory is open source (section 7).
2. General software is a design assumption and out of scope for version 1
   (section 3).
3. The name is Product Factory.
