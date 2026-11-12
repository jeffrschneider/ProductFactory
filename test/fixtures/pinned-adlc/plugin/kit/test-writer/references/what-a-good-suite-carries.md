# What a good test suite carries

Read off the nine packages that already have one, not invented. Every number
here was counted on 2026-09-13 across brand-reader, brief-writer,
explainer-critic, explainer-maker, process-runner, publisher, quiz-maker,
spec-writer and video-watcher: 74 scripts, 51 test files, 589 tests.

This is the reference the writing step works from. It says what a suite that
holds a working package carries, and where the existing nine are thin.

## One file per script, or one per package

51 files for 74 scripts, median 10 tests per file and never more than 45.
publisher covers five scripts in one file of 25 tests; process-runner has
twelve files for eleven scripts. Either is fine. A file is named after the
script or the concern it pins: asked.test.mjs, draft.test.mjs,
publish.test.mjs. It runs with `node --test test/<file>` and nothing else: no
runner, no config, no dependency outside node itself, and `import { test }
from "node:test"` with `assert from "node:assert/strict"`.

## Every file opens by saying what is worth pinning

All 51 begin with a comment block: what the script decides, which of those
decisions are worth pinning and why, what the tests never touch, and the run
line. publisher's opens "Publishing decides on bytes, and says nothing is
published until it has looked at the address," and then lists seven
decisions. A reader who never runs the suite learns from that block what the
script promises. The block ends with what the suite never does: "Nothing here
touches a network: the host and the addresses are functions the test hands
in."

## Tests call the functions, and the script is a thin main

49 of 51 files import named functions from `../scripts/<name>.mjs` and call
them. 68 of the 74 scripts export their working functions for exactly this
reason; the main, under a guard comparing `import.meta.url` to
`process.argv[1]`, reads the variables, calls those functions and prints. So
a test of a decision is a call and an assertion, not a process.

A suite written before the scripts exist is the suite that names those
functions. The imports it writes are the interface the scripts will have to
meet, so they are chosen with care: one function per decision, named for
what it decides (`typeOf`, `carriesASecret`, `nameFor`, `blanksOf`), taking
plain values and returning plain values, with anything that reaches the world
handed in as a function (`fetchImpl`, `call`, `io`).

Nothing in the nine touches a network, a model or a real host. Where a
script would, the test hands in a function: `fetchImpl: async () => ({ ok:
false, status: 403 })`, `call: async () => JSON.stringify({ spec, blanks: []
})`. A test that fails is then a decision that failed, never a host that was
down.

## The process contract is pinned too, once

28 of 51 files also spawn the script as a process, `spawnSync("node",
[script], { env })`, to pin the contract the harness relies on. Called with
a required variable missing, it exits 2 and says which: "JOB_DIR and RECORDS
are required" (48 of 74 scripts do this). On a job with nothing to do it
exits 3 with a reply that names what would be enough (4 scripts). On an error
it exits 1 (41 scripts). What it prints: 14 scripts print one JSON object; 60
print one sentence or nothing at all and write their result to the files the
variables name. So a test of a script's output reads the file it wrote, not
stdout. 27 files assert an exit code and only 5 parse stdout as JSON.

## Temp folders, cleaned whatever happened

29 of 51 files make a folder with `mkdtempSync(join(tmpdir(),
"<package>-"))` and remove it in `finally`. One helper per file does it,
`folders(async (at) => { ... })` or `work()`, and the test body is given the
paths. Nothing is written beside the package and nothing is left behind.

## A test's name is a sentence about the decision

Median 14 words. 586 of 589 start lowercase; none start with "test" or
"should". 248 of 589 say what must not happen: "a credential is refused on its
bytes, whatever the file is called", "a stop files no pieces", "nothing is
altered to make it publishable". The name states the rule and the assertions
are the evidence. An assertion carries its own message where the failure
would otherwise be unreadable: `assert.equal(calls, 0, "it did not even ask
the host for a token")`.

## What is asserted

`assert.match` on reply text, in 44 files: the reply is the product, and the
phrase that matters is pinned with a regex, `/does not publish one whatever it
is called/`. `deepEqual` in 48 files, for records and lists. `assert.throws`
in 30, for refusals the function throws. Exact equality for numbers, codes
and paths. 17 files have async tests, for functions that take a handed-in
async call. A function that awaits anything, or is handed an async call,
refuses by returning a rejected promise: its refusal is pinned with
`await assert.rejects(...)` in an async test, and `assert.throws` around it
can never pass, since it sees only a throw made before the function returns
(a round trip on 2026-11-09 sent a suite back for exactly that).

Every number and rule a feature states is pinned by a test of that feature:
the limit, the count, the time limit, the order, the words or pattern it
quotes, the exit code. A suite for a reader whose feature said "a 10-second
timeout" and "up to 20 at a time" asserted neither, and the code written to
it kept neither.

## A test for every acceptance scenario, named by its id

Since test-writer 0.9.0 the suite is written from the spec (spec-v1), the
analysis Requirements hands back, and not from the agent's descriptor alone.
Each feature there has requirements, each a statement with shall, its kind and
the exact words, patterns and numbers it fixes, and acceptance scenarios in
Gherkin, each naming the requirements it checks. So:

- every scenario has at least one test, named with its id in square brackets
  and then a sentence: `test("[F1.A1] a points line is read by its pattern",
  ...)`; a test for two carries both, `[F1.A1, F1.A2]`. Keep the F number in
  the name: the build maps each test to its feature by it;
- that test follows the scenario's Given, When and Then, and checks every
  requirement its `checks` lists;
- every entry of a tested requirement's `exact` is written in a test of its
  feature as it stands: a refusal's words and a reply's wording byte for
  byte, a pattern as the same pattern (`/^(\d+) points?$/` for
  `^(\d+) points?$`), a limit as the number. A paraphrase (`/no points/i`
  for "No points lines were found.") is sent back;
- a constraint is tested by a test named for it, `[C1] ...`;
- inputs are built to fit their JSON Schemas, and outputs asserted against
  theirs.

The round trip that made this a rule rebuilt a news reader from its as-built
record. The record carried the runner's stop pattern, where page metadata is
read from, the refusal's words and the output's schema exactly; none of it
reached the suite, and the gate passed code the original's own tests fail.

## Every interface the spec keeps is kept

An interface with `keep: true` is one a dependent relies on. The test writer
adds `test/kept-interfaces.test.mjs` itself, made from the spec with no model:
a kept function is exported under its name from its module, async as its
signature says; a kept command accepts its flags; the job folders kept as
examples hold kept files that fit their schemas. Import a kept function by its
own name from its own module, and call it as its signature says. In each test
that runs a job writing a kept file, end with:

    import { checkKept } from "./kept-interfaces.test.mjs";
    // ... the job runs into jobDir ...
    assert.deepEqual(checkKept(jobDir, { expect: ["I2"] }), []);

and for a kept message, `assert.deepEqual(keptProblems("I6", value), [])`.

A kept constant (an exported value) and a kept declaration (a name or value
the agent's files declare, at a place such as
`agent-descriptor.json offerings[0].outputs[1].name`) are held there too, by
their exact values. When a test of yours uses one, import the constant by its
own name from its own module rather than writing its value again.

## The original's own tests

A rebuild's suite carries the original's own tests, placed by the test writer
unchanged but for the import specifiers its manifest lists, with the files
they import under `test/support/`. They are not yours: never write one again,
never answer under one of their names, and never import from
`test/support/` in a test of your own. Read them for the interface the
scripts must keep, and import from the scripts by the same names they do.
Every test file must load: a test that throws before it reaches a script pins
nothing. In an ES module there is no `__dirname`, `__filename` or `require`;
make a path from `import.meta.url` (`dirname(fileURLToPath(import.meta.url))`)
and import what you need.

## What a suite pins, in the order it matters

1. Each refusal the spec lists, as a case that tries the thing and is
   refused, with the reply's wording. A refusal with no test is a sentence
   in a file.
2. The empty case: nothing given, or nothing readable, exits 3 with the reply
   the job's `empty` sentence promises; no model is called and no pieces are
   filed.
3. Each record the spec declares is written where it is declared, with the
   shape the script documents, and written whether the job succeeded or not.
4. The good case: the job's `good` sentence, turned into assertions on the
   artifact, clause by clause.
5. The process contract, once per script: the exit-2 line, and the exit-3
   line where the script has one.
6. The declaration itself: publisher's last test reads agent-descriptor.json
   and checks the offering's steps and that each one's `how` is what it
   claims. A package's root holds its agent-descriptor.json, so a suite reads
   it at `../agent-descriptor.json` from test/, and never a spec.json.
   It asserts only members the file carries, as the agent's own files show
   them: offerings by `id`, each with `name`, `does`, `inputs`, `outputs`,
   `how` and `steps`. The descriptor has no `jobs`, `slug` or `offered`
   (every offering listed is offered), and no package name: that is
   plugin.json's `name`, and a descriptor `name`, where there is one, is a
   display name such as "Test writer". A test like this touches no script,
   so it must pass against the files before any script exists; one that
   cannot is refused.

## Every delivered piece is checked against its declared kind

Since 2026-10-27 every suite carries `test/delivered-formats.test.mjs`. The
test writer adds it; it is the same bytes in every suite and the model never
writes it. It exports `checkDelivered(jobDir)`, which reads
`../agent-descriptor.json` and the job folder's `pieces.json`, and returns
a sentence for each piece that is not what its declared kind says: Markdown
that is JSON or lacks a heading its `about` sketches in backticks, a JSON
kind that does not parse or lacks a top-level member its `about` sketches as
`{a, b}`, HTML that carries no element, a binary without its signature, or a
piece pieces.json lists under a media type other than the declared one.

Every test that fills a job folder, by running a job's main or calling its
pieces script's `fill`, ends with it:

    import { checkDelivered } from "./delivered-formats.test.mjs";
    // ... the job runs into jobDir ...
    assert.deepEqual(checkDelivered(jobDir), []);

It was added because an inventory of 73 agents found 59 pieces whose declared
kind was not what the code sent, and nothing in any suite looked.

## Every job keeps its own records

Since 2026-10-31 every suite also carries `test/records-per-job.test.mjs`,
added by the test writer like the format check and never written by the
model. The host hands every job of an agent the same records folder, the
agent's own, and keeps it across jobs. A record the declaration keeps per job
has a `file` pattern that starts with the job's folder, `*/went-without.json`,
read relative to that folder, so the job writes it at
`<records>/<the job folder's name>/went-without.json` and the script makes the
folder as `join(RECORDS, basename(JOB_DIR))`. A test hands every job the same
records folder, never a folder per job, which is the layout the host never
makes.

When the declaration keeps a record per job, one test runs two jobs of the
same kind and then holds them to it:

    import { checkRecordsPerJob } from "./records-per-job.test.mjs";
    // ... two jobs, each with its own job folder, one records folder ...
    assert.deepEqual(checkRecordsPerJob(records, [jobDir1, jobDir2]), []);

Run two ordinary jobs, jobs that succeed. Every job writes went-without.json,
with no entries when it lacked nothing, because the conformance check reads
it after jobs that may lack nothing (vowel-meter, build
ab_3508d5dec3d4642113, wrote it only when a job lacked something and did not
conform). A record the declaration says is written only in some cases, and
that neither job writes, goes in `{ except: ["<its file or name>"] }`;
went-without.json never does, and the check holds every job to it whatever
`except` names. It was added because three agents built
on dev wrote went-without.json straight into the records folder, so each job
overwrote the last, and their suites, which handed each job its own folder as
the records folder, never noticed (technical debt 639).

## Every computed expected value is worked twice

Since 2026-10-31 every suite also carries `test/worked-values.test.mjs`,
added by the test writer and never written by the model. Each expected value
that a rule in the spec decides from the input (a count, a total, a length,
letters taken from words, an order, which items pass) is written twice: as
the literal you expect, and as a computation, a few lines of plain code in
the test file over the same input that apply the spec's rule step by step.
It is a constant at the top of the file, before any test, and the tests use
the constant:

    import { worked } from "./worked-values.test.mjs";

    function vowelsIn(s) {
      let n = 0;
      for (const ch of s.toLowerCase()) if ("aeiou".includes(ch)) n += 1;
      return n;
    }
    const SENTENCE = "Education provides curious insights.";
    const TOTAL = worked(14, () => vowelsIn(SENTENCE), "the vowels in SENTENCE");

    test("the vowels of a sentence are counted", () => {
      assert.equal(countVowels(SENTENCE).total, TOTAL);
    });

Assert against the constant, never a bare number: `assert.equal(result.total, 4)`
or `/^- a: 1$/m` pins a value nothing checks, and goes back by line (an exit
status, a count of calls and a length are left alone). The computation never
calls a script, and never repeats the literal. Read
the rule from the spec word for word: "one letter per word" gives "HTP" for
"hypertext transfer protocol", whatever the world spells. The test writer
evaluates every worked value before it delivers the suite and sends back each
one its own computation does not give. Where no expected value is decided by
such a rule (every expectation is a reply's wording, a refusal, an exit code
or what a stand-in model said), the notes say so on a line that starts
"No worked values:". It was added because suites pinned values worked out
wrong (16 vowels where the sentence holds 14, "HTTP" where the rule gives
"HTP"), and the build stopped at the code step on a conflict that was the
suite's (technical debt 646).

## A delivered piece is read by whole lines

Find a line of a delivered piece by a pattern for the whole line, or by the
text after its heading line:

    assert.match(text, /^- a: 1$/m);

never by a single letter or a short word searched anywhere in the piece. A
heading or a word of prose holds letters too: `## Counts` holds o and u
before any i, so `block.indexOf("i") < block.indexOf("o")` fails a piece that
keeps the spec. The test writer sends back a search for one letter with
indexOf, lastIndexOf, includes or search.

## Where the nine are thin

Two files import nothing from the scripts and pin by process alone. Four
packages have no test that reads their own declaration. Nine packages declare
went-without.json and only spec-writer's suite tests that anything writes it.
Do better than that wherever the spec gives the material.

## The suite is run against nothing before it is delivered

A suite written before the scripts exist is run against empty scripts, one
stand-in for every file the spec names. It must fail. A suite that passes
with every function absent has asserted nothing, and that is the check the
writing step is held to. When the scripts do exist, each is blanked in turn
and the suite run again; a script whose absence the suite never notices is a
script nothing tests, and the verdict says so by name.

## The two scripts every package shares, and their fixed exports

Most specs name `scripts/went-without.mjs` and `scripts/pieces.mjs`. They
are the same two files in every package that has them, copied and not
rewritten, so a suite imports their names as they are and does not guess at
others. On 2026-09-14 the first real run imported names these files do not
export, and the tests that did so failed for a reason that was not the
code-writer's.

`scripts/went-without.mjs` exports exactly: `FILE` (the string
`"went-without.json"`), `fileIn(records)` (the path of that file under the
records directory), `note(records, { wanted, did, why })` (appends one
entry and returns it), `read(records)` (the entries, `[]` when the file is
absent), `sentence(entries)` (one sentence over a list of entries, `""` for
none) and `paragraph(records)` (`sentence(read(records))`). Each takes the
folder it writes in as it is: a script hands it the job's own folder,
`join(RECORDS, basename(JOB_DIR))`, so a test reads the record there.

`scripts/pieces.mjs` exports `STEP_OF` (which step each kind of piece comes
from), `aboutOf(text, path)` (the one-line description a piece is filed
with), `plan(...)` (the pieces list for a job, from what the job made; its
named options are the package's own and the spec's scripts say which) and
`fill(jobDir, { entries, copies })` (writes pieces.json under the job folder
and copies each file under out/). Test `plan` through the package's own
scripts that call it rather than by guessing its options.
