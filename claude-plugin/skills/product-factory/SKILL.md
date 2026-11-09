---
name: product-factory
description: Start and drive Product Factory builds from Claude Code with the product-factory MCP tools. Use when the engineer says things like "start a build of an agent that...", "build an agent from issue 12", "what's waiting on me", "where is the word-counter build", "show me the spec", "approve the spec", "ask for changes", "OK the code", "tell the test writer...", "ask the boss...", "approve feature F2", or "take the Code hand-off" on a pull request.
---

# Driving Product Factory from Claude Code

Product Factory runs builds of agents on the agentic development lifecycle.
Each build goes stage by stage (Requirements, Test, Code, Package, Deploy),
and waits at gates for a person. The product-factory MCP tools are a thin
client over the lifecycle API of the Product Factory running on this
computer; the console shows the same builds.

## The tools

| Tool | Use it to |
|---|---|
| `start_build` | start a build from the engineer's words (`does`, and `name`, `refuses`, `more` when they gave them), or from a GitHub issue number when intake is on |
| `waiting_on_me` | list the gates, feature proposals and boss proposals that wait on the engineer, each with its id |
| `build_status` | see where a build is: the current stage, its gate, the actions offered, the pull request and its check; `wait_seconds` watches it move |
| `stage` | read a stage's workspace: what it was given, its outputs and their summaries, its gate |
| `ask` | talk to the agent holding a stage, or to the product's boss (`stage: "boss"`) |
| `act` | take one action by its id, only after the engineer says yes |

Reading is free: `waiting_on_me`, `build_status` and `stage` change nothing,
so use them whenever they help. `ask` posts a message, and changes nothing else.

## Taking an action: always ask first

A gate is a person's decision. Never take a gate action, a feature decision or
a boss proposal on your own judgment, even when it looks obvious.

1. Find the action and its id with `waiting_on_me` or `build_status` (ids look
   like `b_1a2b3c4d5e6f/approve`, `bp_...` for a boss proposal, `fp_...` for a
   feature proposal).
2. Show the engineer the gate's words, as the tools give them: what the stage
   said it handed back, what is still open, the features approving starts
   with, the pull request's check, and who may answer. For a spec, offer to
   read the spec with `stage`.
3. Ask, naming the action: "Approve the spec for word-counter 0.1.0?"
4. Only on a clear yes in this conversation, call `act` with the id and the
   engineer's own words in `engineer_said`. For Ask for changes or Send back to
   Test, put their words in `needs` (`{ "changes": "..." }`).
5. Say what `act` answered: what it took, and where the build is now.

When the engineer has already said exactly what to do ("approve the spec for
word-counter"), that is the yes: show the gate's words in one or two lines,
then act. If more than one build could be meant, ask which.

`act` takes only what the build offers the engineer now. When it refuses, it
says what is offered instead; tell the engineer, and do not try another
action in its place.

A stage agent or the boss may propose an action or a feature in its reply.
Show it with its id, and take it only when the engineer says so.

## Starting a build

Use the engineer's words for `does`. Ask for a name if they have one in mind;
otherwise leave it out. After `start_build`, the spec writer works for a
while; use `build_status` with `wait_seconds` (60 to 120) to see the spec
waiting at the Requirements gate, then show it and ask.

## Taking the Code hand-off on a pull request

When the build is at Code and `build_status` shows a pull request, the
engineer's coding harness writes the scripts on it. When they ask you to take
the hand-off, do it in this same session:

1. Check out the pull request's branch: `gh pr checkout <pull request URL>`
   (or `git fetch origin` and check out its branch).
2. The build folder is `agents/<product name>/` in the repository. Read its
   `AGENTS.md` first and follow it: it is the hand-off contract.
3. Write only what the fence allows: the scripts under `scripts/`, and new
   tests under `test/` if the contract allows them. Do not change the spec
   files, the suite or `build.lock.json`.
4. Run the check from the build folder, `node .adlc/check.mjs`, until it exits 0.
5. Commit and push to the pull request's branch.
6. Watch the gate result come back: `build_status` with `wait_seconds` (Product
   Factory checks the pull request for pushes every `poll_seconds`, 30 by
   default). Report the check's words. When it fails, read them, fix the
   scripts, and push again.
7. When the gate passes, the build waits for the engineer's OK on the code.
   Show the check and ask before taking `OK the code`.

If a test cannot pass without breaking the spec, write `records/conflict.md`
in the build folder saying why, as AGENTS.md describes, and push; the gate
stops, and the engineer can Send back to Test with their words.

## When the tools cannot reach Product Factory

The tools find Product Factory from `product-factory.json` in the folder
Claude Code started in, or a folder above it: its port, and the key the
service made in its data folder. Otherwise they read `PRODUCT_FACTORY_URL`
and `PRODUCT_FACTORY_KEY_FILE` (a person's own key file), or
`PRODUCT_FACTORY_CONFIG`. If a tool says it cannot reach the service, tell
the engineer what it said; usually Product Factory is not started
(`npx product-factory` in its folder). Never print or ask for the key itself.
