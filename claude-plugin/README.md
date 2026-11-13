# Product Factory for Claude Code

A Claude Code plugin, so an engineer can start and drive Product Factory
builds without leaving Claude Code. It holds two things:

- **An MCP server** (`mcp/server.mjs`, Node 22, no dependencies, stdio): six
  tools that are a thin client over the lifecycle API a running Product
  Factory answers. Everything they do is a route the adlc console calls too.
- **A skill** (`skills/product-factory/SKILL.md`): when to use the tools, to
  ask before taking any gate action and show the gate's words first, and how
  to work one builder's build on its pull request in the same session.

## Install it

You need Claude Code, Node 22 or later, and Product Factory running on this
computer (`npx github:jeffrschneider/ProductFactory`, or `npm start` in a
clone; see the main [README](../README.md)).

In Claude Code, add this repository as a plugin marketplace and install the
plugin from it:

```
/plugin marketplace add jeffrschneider/ProductFactory
/plugin install product-factory@product-factory
```

The same from a shell: `claude plugin marketplace add jeffrschneider/ProductFactory`,
then `claude plugin install product-factory@product-factory`. From a clone,
give the clone's folder instead of `jeffrschneider/ProductFactory`, or try it
for one session with `claude --plugin-dir <clone>/claude-plugin`.

Then start Claude Code in the folder you run Product Factory in (the one with
`product-factory.json`), or in a folder below it, and run `/mcp` to see the
`product-factory` server connected.

## How it finds Product Factory

The tools find the service and its key the way the console is given them: an
address and a key file.

1. With no settings, it reads the first `product-factory.json` in Claude
   Code's folder or a folder above it: the service is `127.0.0.1` at its
   `port` (4510 by default), and the key is `service-key` in its `data`
   folder, the file Product Factory made when it first started.
2. `PRODUCT_FACTORY_CONFIG` names that settings file instead.
3. `PRODUCT_FACTORY_URL` names the service's address, such as
   `http://127.0.0.1:4510`. Use it when Product Factory was started with
   `--port`, since the settings file then does not say where it is.
4. `PRODUCT_FACTORY_KEY_FILE` names a key file. With teams, give your own
   key (the one `npx product-factory person key <email>` printed, kept in a
   file), so every act is made as you and the gates you may not answer say who
   may instead.

Set these in the environment Claude Code starts in. The key is read from its
file on each call, sent only to the service, and never printed or put in an
answer.

## The tools

| Tool | What it does | Routes it calls |
|---|---|---|
| `start_build` | starts a build from words (`does`, `name`, `refuses`, `more`, `project`, `prototype`), or from a GitHub issue number when intake is on | `POST /builds`, `POST /intake/issues/:number` |
| `waiting_on_me` | across products: the gates the caller may answer, with the gate's words and each action's id; the feature proposals they may approve; the boss's open proposals; and what waits on someone else | `GET /me`, `/builds`, `/builds/:id`, `/builds/:id/stages/:stage`, `/products`, `/products/:name/features[/:id]`, `/products/:name/boss/messages` |
| `build_status` | where a build is: summary, current stage and its gate, the actions offered, the pull request and its latest check, the newest log; `wait_seconds` watches a working build until it moves | `GET /builds`, `/builds/:id`, `/builds/:id/stages/:stage`, `/products/:name` |
| `stage` | a stage's workspace: what it was given, its outputs and their summaries, done when, its gate | `GET /builds/:id/stages/:stage`, `/builds/:id` |
| `ask` | posts to a stage's agent or the product's boss, and returns the reply with any proposed action or feature, each with its id | `POST /products/:name/stages/:stage/messages`, `POST /products/:name/boss/messages` |
| `act` | takes one action by id: a build's action (`<build>/<action>`), a when-needed action, a boss proposal (`bp_...`) or a feature proposal (`fp_...`, approve or not_now) | `POST /builds/:id/actions/:name`, `POST /builds/:id/features/:feature/approve\|not_now`, `POST /products/:name/boss/messages` with `confirms` |

Each tool answers in plain words, then the same answer as compact JSON.

`act` reads the build first and takes only an action the build offers the
caller now (the service shapes the build per person, so a gate they may not
answer is not offered). Anything else is refused with what is offered
instead, and nothing is taken. It needs `engineer_said`, the engineer's own
words asking for the action, and the skill tells Claude to show the gate's
words and ask before calling it.

## One route added to Product Factory

The lifecycle API's start request has no issue in it, so starting a build
from one issue now, rather than at the next poll, needed a route:
`POST /v1/lifecycle/intake/issues/:number`. It is Product Factory's own, like
`/analytics`, and not part of the lifecycle API standard. It reads the same
labelled issues the poll reads, so the same rules hold: the issue is open and
carries the label, and it starts one build at most (a second ask answers 409
with the build it started). With intake off it says so. The tests are in
`test/intake.test.mjs`.

## Tests

`test/claude-plugin.test.mjs` runs the MCP server over stdio against a whole
Product Factory started in the test's process with stand-in holders
(`test/helpers.mjs`, `test/fixtures`): starting a build from words and from
an issue, waiting_on_me with a gate's words and ids, ask with a proposed
change and a proposed feature, act refusing an action that is not offered
and taking one that is, a feature approved and a boss proposal confirmed, and
finding the service from `product-factory.json`. `npm test` runs them with
the rest.
