---
record: architecture-record-v1
statement: "An agent that reads a web page and writes the key points for a person to review."
environments: [dev, test, production]
kind: plugin-on-harness
done: no
questions: 1
systems: [files, text-reasoning]
standing_assets: none
bindings:
  files:
    dev: local folder (customer)
    test: local folder (customer)
    production: unbound (asked)
  text-reasoning:
    dev: platform (platform)
    test: platform (platform)
    production: platform (platform)
---

# Architecture record: key points from a web page

This record is not finished: one question is still open, under Questions.

## Statement

> An agent that reads a web page and writes the key points for a person to review.

## Systems

- `files` (files), write: The key points are written to a file the person reads.
- `text-reasoning` (text reasoning), trigger, for text: Choosing the key points of a page is a judgment.

## Bindings

| System | dev | test | production |
|---|---|---|---|
| files | local folder, the organization's choice | local folder, the organization's choice | unbound: asked |
| text-reasoning | platform, platform default | platform, platform default | platform, platform default |

## Dependencies

- **page-reader** (an agent): It fetches the page and hands back its text.

## Kind

**plugin-on-harness**: A short program with one judgment. A harness reading skills carries it.

## Limits

- **Cost**: at most 2 USD a day. The statement's owner said so.
- **Speed**: a page answered within 120 seconds. One page is one pass.
- **Data**: reads the page it is given and keeps nothing between runs.
- **Trust**: takes work only from its owner.

## Egress

- dev: the target runs the agent open (it enforces no allowlist today).
- test: the target runs the agent open (it enforces no allowlist today).
- production: the target runs the agent behind an allowlist.
- Beyond the derived set (its systems, the network, the registrar, the model it is given): the page's own host (asked), because the page's address arrives with each request.

## Formats

- It hands back the key points as `text/markdown`. A person reads them.

## Standing assets

- None, because no output speaks for the organization.

## Settings

No setting beyond the bindings' own.

## Decisions

### Decision 1. Bind files to local folder in dev and test

Why: The organization chose a local folder for files in dev and test.

What follows: The install places the folder this binding names; the package names none.

### Decision 2. Bind text-reasoning to platform in dev, test and production

Why: The organization chose no product for text-reasoning, so the platform's default fills each.

Weighed: A model provider of the organization's own.

What follows: The install places the model in the four model settings.

## Questions

- binding-files-production: Which product holds the files in production?
