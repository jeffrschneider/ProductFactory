---
schema: https://schemas.agentmesh.ai/architecture-standard/v1
name: Architecture standard
version: 2.0.0
owner: agentmesh.ai
layer: publisher
approved_by: null
approved_at: null
---

# The architecture standard

This is the standard the Architecture stage holds an agent to, the first part
of stage 02 of the Agent Development Lifecycle
(https://agenticdevelopment.ai/stages.html), held by the solution architect
role (https://agentroles.ai/solution-architect.html). The solution architect
applies it to write the architecture record. The Design stage, held by the
spec writer for an agent and the solution planner for a solution, designs
within the record and is held to the same standard. Where a rule here and a
message disagree, the rule governs and the reply says so.

The architect decides by applying these rules, and asks the person only where
the rules leave a real choice. A rule applied is a decision with its reason,
written in the record. A choice the rules leave open is a question, never a
guess.

## 1. What the architecture record says

The record says what the agent is made of, how its parts are joined, how it
runs, how its data moves, and why it is built that way. It also says what it
stands on: the systems it reaches and what is bound to each. It says nothing
a later stage owns.

1. **The systems.** Each system the agent reaches, in plain system words:
   `database`, `files`, `text-reasoning`, `mail`. These are the names the
   package's runtime requirements carry in `systems[]` (Common Agent 12.4),
   and the package maker builds a package whose system names equal the
   record's. A system is never named by its product, an address or an
   account: "Supabase" is a product bound to `database`, not a system.
2. **The bindings.** For each system, the product bound to it in each
   environment the agent will run in, spelled the way the deploy into it
   spells it: `dev`, `test`, `production` (Common Agent 8.3). Each binding
   says whether the organization chose it (`customer`) or a platform default
   filled it (`platform`), as the deployment record's `provided_by` does. A
   keyless public service is bound to the service itself (section 2).
3. **The dependencies.** The other agents and services the agent depends on,
   each named, with why.
4. **The kind.** What the agent's inside is made of: skills a harness reads
   (`plugin-on-harness`), code that answers on the network by itself
   (`mesh-coded`), or somebody else's program in a container
   (`third-party-framework`). The default is `plugin-on-harness` with its
   work in scripts: a program that calls a model at named points (rule 6).
5. **The components.** The agent's own parts and the systems outside it, each
   with what it is responsible for (section 12).
6. **The connectors.** How each component is joined to the next and to each
   system it reaches, each connector naming both of its ends (section 13).
7. **The runtime and deployment view.** How the agent runs, and what each
   system is bound to in each environment it runs in (section 14).
8. **The data flow.** The job's data, step by step, from the caller back to
   the caller (section 15).
9. **The drivers.** The quality requirements and constraints the decisions
   answer: what the agent may spend, how quickly it must answer, what data it
   may hold or move and where, which parties it trusts and on what terms, and
   any other the spec or the statement states (section 16). They are inputs
   the record carries, and none of them is a decision.
10. **The decisions.** Every decision about the agent's structure, in the
    manner of an architecture decision record: its context, the drivers it
    answers, what was decided and why, the alternatives weighed and its
    consequences (section 17). Then the rulings: each rule of this standard
    applied, and each answer a person or the build gave. A decision without a
    reason is not delivered.
11. **The egress.** For each environment, what the agent may reach on the
    network beyond the derived set (its systems, the network, the registrar,
    the model it is given and the hosts its workspace kinds are reached at),
    each further destination named by what it is and why, or a statement that
    it needs none; and whether that environment's target enforces an allowlist
    or runs the agent `open`.

The record sets the agent's structure and designs nothing a later stage
owns. The statement of the job and the spec belong to Requirements. The
steps, the inputs and outputs, the settings and the files a package is built
from belong to Design, and the agent that does a step belongs to Source. The
record says which components there are, what each is responsible for and how
they are joined. The Design writes them down as the package's offerings,
skills and scripts, and a Design that needs a component or a system the
record does not name sends it back to the architect as a question (section
7).

## 2. Bindings: the organization's stack first

"The organization's stack" is the stack section of the organization record
(AgentMesh docs/account-stack.md): one binding per system, each with a
product, who provides it, and a row per environment. The platform's defaults
are the House Stack, published as the system vocabulary at
`/v1/stack/vocabulary`. The architect binds each system in each environment
in this order, the role's rule ("the organization's own choice is the binding
wherever it made one, a platform default fills each binding it left open")
walked the way the deploy's resolver walks it:

1. the organization's own binding for that environment;
2. the organization's production binding, where the environment has none and
   the organization said production may stand in;
3. the House Stack's product, where the House Stack covers the system, marked
   as a platform default;
4. otherwise a question naming the system and the environment.

The role and the AgentMesh deploy disagree in one place, and the record says
so rather than hiding it. Where the organization bound a system in one
environment and not another, the role fills the other with a default, and the
deploy's resolver refuses a test or production deploy there until the
organization binds it (AgentMesh docs/account-stack.md, section 3, step 7).
The record follows the role, and that binding's decision says what a deploy
there needs first.

A binding names a product. It never carries a credential, an address, a key
store or an account identifier: those are what an install needs, and the
owner's instruction supplies them at Deploy (Common Agent 12.6 rule 3).

**A keyless public service.** A service the agent reaches at one fixed
address that takes no key, such as the Hacker News API, is a system of the
record like any other, named in plain system words (`hacker-news`). Nobody
chooses a product for it, so it is bound to the service itself, and that is
a valid binding with no product behind it. The binding names the address,
says it takes no key, gives the access (`read`, `write` or `read-write`) and
records the owner's approval, in every environment:
`itself at <address>, no key, read, approved by the owner in egress-1`. The
architect asks the owner for it as it asks for any destination (section 7),
with the address in the question; a yes makes it a system bound this way,
and a no leaves it out. This address is the one address a record carries.

## 3. Models are bound systems

A model is a system like any other, stated by the capability the agent needs
and bound to a product per environment.

- The system is named by capability: `text-reasoning` for text,
  `image-reading` for pictures, `speech-to-text` and `text-to-speech` for
  speech, each with access `trigger`.
- The record says the capability the work needs in plain words: text, vision,
  long context, speech. It names the product bound in each environment, never
  a model or a version. A product the organization bound is named as it chose
  it. Where the House Stack's product fills the binding, the record names it
  as `platform` with the House Stack's label,
  and never the provider or the model behind it: the House Stack's models are
  AgentMesh's choice, they change, and AgentMesh does not say whose they are.
- Where the build that asked settles how the agent reaches a model (a model
  door the build provides, say), the record names no model system at all
  (section 11).
- No model name goes into code, a skill, an instruction, a setting's default
  or the record. The scripts reach the model through the four settings of
  the model system, `MODEL_NAME`, `MODEL_ENDPOINT`, `MODEL_KEY` and
  `MODEL_PROTOCOL` (Common Agent 0.41.0, Section 12.4.1), read through the
  caller on every run and from nowhere else, and refuse in words, naming the
  setting, when `MODEL_NAME`, `MODEL_ENDPOINT` or `MODEL_PROTOCOL` is empty.
  The install places the values from the binding, and a run config may
  change the model for one job.

Why: models are retired on somebody else's schedule. An agent shipped with a
model's name written into a script answered 404 the day that model went, and
the fix was a rebuild. A model named only in configuration is a setting
changed.

## 4. What passes between steps and agents

Readable formats by default.

- Content that a person reviews, or that one step or agent hands another, is
  Markdown: `text/markdown`, with a light convention. A short header carries
  the few structured fields, then fixed headings carry the rest, and the
  convention is sketched where the piece is declared.
- JSON only for exact typed data that code consumes and a person never reads:
  identifiers, coordinates, timings, numeric series. Then the kind says what
  the data is, `application/vnd.<org>.<name>+json` or another registered
  `+json` type. Never a bare `application/json`.
- Every kind is specific: a media type, a vendor kind, or one of the value
  kinds `text`, `identifier`, `url` and `document` where nothing more is
  known.
- Each input says who gives it: a `person`, an `agent`, or `either`.

## 5. Addresses and settings

- **Addresses are never settings a person types.** An address the caller
  gives is an input of kind `url`. An address of a product somebody binds
  comes with the binding at install. A keyless public service's address is
  the one its binding names (section 2): the Design declares it as the
  service's address setting, whose default is that address, and the install
  places it. No script holds an address of its own; each reads the setting
  (Common Agent Section 12.6, rule 2).
- **Settings are declared with defaults.** A value that shapes the work is a
  setting the agent declares, with its default, whether it is a preference
  (the closest layer wins) or a rule (the tightest layer wins), and whether a
  sender who does not own the agent may set it for one job (AgentMesh
  docs/run-config-plan.md). A setting nobody declared cannot be set.
- **Inputs are the material; options are settings.** An input is only the
  material the job is about: the page, the brief, the facts. Anything that
  only shapes how the job runs (a voice, a tone, a length, a style, a format
  choice, anything with a fixed set of values or a default) is a setting,
  never an input, so a person's page draws a choice and not a free-text box.
  Brand, palette and template material is a standing asset (section 10),
  never an input.
- **Settings are declared in full.** Every setting has a `label` and an
  `about` for a person, a `default`, its `allowed` values whenever the value
  has a natural set of choices (voices, tones, lengths, formats) with a label
  for each in `value_labels`, and for a number its `min`, `max` and `step`.
  Every option gets its default and its choices at design time, and none is
  left open.

## 6. The kind and the `how`

The default is a program that calls a model at named points: each step
declares `how` as control `script`, intelligence `none` or `called`, and
contract `full`. A model in control has to earn it (control `model`,
intelligence `open`, contract `ends`), and the record gives the reason when
it does. A harness reading skills is the default carrier; code that answers
on the network itself, or a container, is chosen with its reason.

## 7. Commitments are asked, never filled

A spending limit, a product that neither the organization chose nor the
platform offers, access to a system the statement does not call for, and a
network destination beyond the derived set are commitments somebody would be
held to. The architect asks for each and fills none of them in, unless the
build that asked has already settled it (section 11). A keyless public
service is asked as a destination, and the owner's yes makes it a system of
the record (section 2). A spending limit, once set, is a driver the record
carries (section 16), never a decision. A step of the
design that needs a system the record does not name comes back to the
architect as a question, and the record is revised before the design goes
on; the system is never added on the designer's word alone.

## 8. Done

The Architecture part is done when every system is named and bound in each
environment the agent will run in (a keyless public service bound to itself
is bound), every decision has a reason, every kind
of output a person reads has its standing assets decided (section 10), and
every step of the design uses only systems the record named. The record's
views are part of it: every component has a responsibility, every connector
names both of its ends, the data flow has its steps, every decision about
structure cites its drivers and gives at least one alternative and its
consequences, and no limit stands as a decision (sections 12 to 17). The
architect checks all of these but the design's steps before it delivers, and
says the record is not finished while a question is open. The design's steps
are checked when the design comes back: the spec writer's draft declares
exactly the record's systems, and a step that needs another goes back as a
question.

## 9. The record's form

The record is a Markdown document for the person, with a structured header
for the bindings, so the next stage and a test can read the bindings without
parsing prose. The header is front matter: `record`, `statement`,
`environments`, `kind`, `done`, `questions`, `systems`, `standing_assets`
(the schemas section 10 decided, or `none`), `cost_limit` (the spending
limit in the words it was set in, or `not set`), and `bindings`, one line
per system and environment. The cost limit is the cost driver's value
(section 16), carried in the header as an input the next stage reads. The
Design declares it as the
ceiling of the spending system it bounds, in the shape of Common Agent
Section 12.4, item 4: the model system says it spends, in the limit's
currency, and `ceilings[]` names that system, `per` task or day, with the
limit's number as `suggested`, which the owner's instruction adopts at
install. The body quotes the statement it answers under
`## Statement`, then carries the fixed headings `## Systems`, `## Bindings`,
`## Dependencies`, `## Kind`, `## Components`, `## Connectors`,
`## Runtime and deployment`, `## Data flow`, `## Drivers`, `## Egress`,
`## Formats`, `## Standing assets`, `## Settings`, `## Decisions` and
`## Questions`, in that order. The header is written from the same facts as
the body, never by hand, and its format word stays `architecture-record-v1`:
the header reads as it did, and the views are in the body.

## 10. Standing assets

A standing asset is the organization's shared material that many agents
read: its brand profile, its style guide, its glossary, its media templates
(standards/README.md). The record decides, for each kind of output a person
reads, which standing assets apply, each with its reason, or says "none,
because" and the reason. The Design then declares exactly those as
`can_use` entries, each saying what the agent reads, what it does with it,
and what it does `without` it.

- **Which outputs.** An output a person reads, watches or hears: one whose
  kind is `text/markdown`, `text/html`, an image, a video or audio
  (`person_facing_kinds` in standards/standing-asset-schemas.json).
- **The house rule.** Written copy (`text/markdown`, `text/html`) reads the
  style guide, for the voice, and the brand profile, for how the
  organization's name is written and the words it never says. Visual output
  (`text/html`, images, video) reads the brand profile, for the look. Media
  (video, audio) reads the media templates. A glossary is added where the
  work uses the organization's own terms. The rule, its reasons and the
  fields each kind reads are written as data in
  standards/standing-asset-schemas.json (`outputs`), and the record applies
  them.
- **None, because.** An agent with no output a person reads declares none,
  and the record says so with that reason. An agent whose person-facing
  output should read none says why, in the person's words, as the answer to
  `standing-assets: none, because ...`.
- **Only known kinds.** A standing asset is named by a schema on the list in
  standards/standing-asset-schemas.json. The package maker refuses any other.
- **Whose library.** Work content (brand, style, templates) comes from the
  requester's library, under the requester's grant; build standards come
  from the operator's.
- **No secrets.** A standing asset is never a credential and never an
  address the agent is told to reach; it is handed to the job.

## 11. Answers a build has already settled

A request can come from a build that already holds some of the answers the
architect would otherwise ask: defaults it settles for every agent it makes
(the kind, what the agent may reach, how it reaches a model), the platform's
own spending rules, the account's limits. The build hands them over with the
request, each with where it came from.

- **Used, not asked.** Each settled answer is used as given, as a ruling that
  says who settled it and records where it came from, and the question it
  answers is never put to the person. A settled spending limit is the cost
  driver, with where it came from (section 16).
- **Never contradicted.** The record binds nothing a settled answer rules
  out. Where the architect would have chosen otherwise (a model system where
  the build settles a model door, a destination where it settles that the
  agent reaches nothing outside the platform), the settled answer stands and
  the decision says what the architect would have chosen, as a note under
  what was weighed, never as a binding or a question.
- **Only what nobody else can answer is asked.** A question the settled
  answers do not answer is still asked, and the record says it is not
  finished until it is answered.

## 12. Components and responsibilities

A component is one part of the agent with one responsibility, or a system
outside it that the agent reaches. The record names each component, gives it
an id in lowercase-hyphen words, says in one sentence what it is responsible
for, and says which component it sits within.

- **The carrier**, from the kind: the harness for `plugin-on-harness`, the
  program that does the work when a message arrives (Common Agent Section
  12.1); the agent's own service for `mesh-coded`; the container for
  `third-party-framework`.
- **The skills.** One per job a caller orders, because every offering has
  exactly one skill and every skill an offering (Common Agent Section 12.6,
  rule 2). Where the spec came with the request, its offerings are the
  skills. Otherwise the architect names them from the statement, and the
  Design declares them as the offerings.
- **The scripts.** Each skill on a harness runs one script,
  `scripts/<skill>.mjs`: the program that calls a model at named points
  (section 6).
- **The parts.** The pieces of each script, each with one responsibility: a
  client for a system it reads or writes, a filter, a writer that calls the
  model, the part that puts the reply together. A part that reaches a system
  names it.
- **The outside systems.** Every system of the record, and a keyless public
  service still asked, drawn as asked (section 2).

Code draws what code can know: the carrier from the kind, the skills from
the spec's offerings, a script for each skill, and the outside systems from
the record. The architect writes what is judgment: the parts, and each
responsibility.

For hn-digest, a Product Factory build that reads the current Hacker News
top stories, keeps those on a topic the caller names, has a model write one
sentence about each and hands back a Markdown digest, the components are:

- the harness, which starts the skill's script once per job and hands back
  what it writes as the reply;
- the skill `topic-digest`, which writes a digest of the current top stories
  on the caller's topic, and its script `scripts/topic-digest.mjs`;
- within the script, the Hacker News client (reads the top story ids, then
  each item), the topic filter (keeps the stories on the topic, up to
  `stories_in_digest`), the sentence writer (has the model write one sentence
  per story, through the shared model caller) and the digest writer (puts
  the Markdown digest together);
- outside, `hacker-news`, the public Hacker News API, and `text-reasoning`,
  the model.

## 13. Connectors and interfaces

A connector joins two components and says how: the interface each side holds
to. Each connector names both of its ends, a component or the caller
(whoever sent the job, a person or an agent). It says how the two are joined,
the access where it reaches a system, and what it carries, as the data flow
says.

- **The job in.** From the caller to the carrier, with the job's inputs.
- **The harness to each script.** By command, started once per job, with
  the job's input and its settings as flags. The Design writes it as the
  job's `run` (Common Agent Section 12.3).
- **A part to each system it reaches.** A model through the shared model
  caller and the four settings of the model system (section 3, and Common
  Agent Section 12.4.1). A keyless public service at the address its binding
  names, read from a setting and never written into a script (section 2, and
  Common Agent Section 12.6, rule 2). Any other system through the product
  bound to it, with the credential and address the install places (Common
  Agent Section 12.4).
- **The reply out.** From each script to the caller, on the script's
  standard output, which the harness hands back as the job's reply.

Code draws every connector from the kind, the skills, the systems and the
bindings. None is the model's to invent, and a connector whose end is not a
component of the record is no connector.

For hn-digest: the caller to the harness, with the topic; the harness to
`scripts/topic-digest.mjs` by command, with the topic, `stories_to_read` and
`stories_in_digest` as flags; the Hacker News client to `hacker-news` over
HTTPS, read, with no key; the sentence writer to `text-reasoning` through
the shared model caller and `MODEL_NAME`, `MODEL_ENDPOINT`, `MODEL_KEY` and
`MODEL_PROTOCOL`; and the script to the caller, with the digest as the
reply.

## 14. Runtime and deployment

The runtime and deployment view says how the agent runs, from its kind, and
what each system is bound to in each environment, from the bindings
(section 2). A `plugin-on-harness` agent runs once per job: the harness
starts the skill's script as a command, and the process ends when the reply
is written, with no service of its own, no port and no process kept between
jobs. A `mesh-coded` agent runs as its own long-lived service, and a
`third-party-framework` agent as a container the deploy starts. Where the
work needs a note on how it runs, the record says so in a sentence (a bound
on what it does at once, a schedule).

For hn-digest: it runs per job under a harness, with no service of its own;
in dev, test and production `text-reasoning` is bound to the platform's
models as a platform default, and `hacker-news` to the service itself at its
address, with no key.

## 15. Data flow

The data flow is the job's data from the caller back to the caller, one step
at a time. Each step goes from one component to another, says what passes,
and says how in one sentence. The architect writes the wording. Code reads
each end as a component, and leaves out a step whose end is no component of
the record (a service the owner said no to), and says so.

For hn-digest: the topic comes in; the client reads the top story ids, then
each story's item; the filter keeps the stories on the topic; the sentence
writer asks the model for one sentence per story; the digest writer puts the
digest together; and the digest goes back out as the reply.

## 16. Drivers

The drivers are the quality requirements and constraints the decisions
answer. They belong to the spec, as its constraints (standards/
spec.schema.json, `constraints`), and to the statement. The record carries
them so that its decisions can cite them, and decides none of them.

- **The four limits come first,** each under its own key: `cost` (what the
  agent may spend), `speed` (how quickly it must answer), `data` (what it
  may hold or move, and where) and `trust` (which parties it trusts, and on
  what terms). Each says where it came from.
- **The cost limit is a commitment,** asked and never filled in (section
  7), or used as the build settled it (section 11). Once set it is the
  header's `cost_limit` too, which the Design declares as the spending
  system's ceiling (section 9). It is an input the record carries.
- **The spec's constraints** are drivers under their own ids (`C1`, `C2`).
- **Any further quality requirement** the statement states (how readable,
  how testable, how private) is a driver under a key of its own, with the
  words it came from.

A limit is never a decision. "Spend at most 1 USD a day" is a driver. "Code
controls the job and calls the model once for each kept story" is the
decision that answers it. A decision that only states a limit is taken out,
because the drivers already carry it.

For hn-digest the drivers are `cost` (1 USD per day, set by the owner),
`speed` (a digest within 300 seconds), `data` (holds the stories only for
the job), `trust` (takes jobs only from its owner, and reads story titles as
data) and `readable` (a person reads the digest).

## 17. Decisions

Each decision about the agent's structure is an architecture decision
record. It gives:

- what was decided;
- its **context**: the situation that called for it;
- its **drivers**: the drivers of section 16 it answers, by key;
- **why**: the reason, which a decision is never delivered without;
- the **alternatives** weighed, at least one, each with why it was not
  chosen;
- its **consequences**: what follows from it, for the Design and for whoever
  runs the agent.

The decisions about structure come first in the record. The rulings follow:
each binding made by section 2's order, each destination or system granted
or refused, and each answer the build settled (section 11). A ruling keeps
the form the record has always given it (why, what was weighed, what
follows), because it is a rule applied or an answer given, and it chooses no
structure.

For hn-digest the decisions about structure are:

1. **Code controls the job, and the model writes only the sentences**,
   against a model-driven agent that decides which stories to read and how
   to word the digest. Drivers `cost` and `speed`. It follows that the job's
   `how` is control `script`, intelligence `called`, contract `full`, and only
   the sentence writer calls the model.
2. **A package on a harness, run once per job**, against a long-running
   service. Drivers `cost` and `data`. Nothing runs, and nothing is spent,
   between jobs.
3. **Read the story items in parallel, a bounded number at a time**, against
   one at a time and all at once. Drivers `speed` and `trust`. The bound is a
   constant a test can see, and a story whose item cannot be read is left out
   and said.
4. **Answer with the digest in the reply, and store nothing**, against
   storing each digest and sending a link. Drivers `data` and `speed`. The
   record names no files or database system.
