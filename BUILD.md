# The milestones after milestone 1

Milestone 1 runs one build of one agent end to end on one computer. These
come next, each in a few lines.

## Board

One column per phase (Define, Make, Ship, Prove, Use, Run, Change), one card
per build, placed by the stage it is at. Each card says what is waiting and
on whom, with a filter for the builds waiting on me. Built in the console,
read from the same lifecycle API.

## Dashboard

A light view of the current builds: median time per stage, send-backs per
stage, and what is waiting now on a person or an agent. Built in the console
from the lifecycle API. Not called analytics.

## Analytics

Questions over time, from an SQLite history the factory keeps beside the
build files (`node:sqlite`, built into Node). Never estimated: time per stage and per build,
where builds wait longest, rounds per stage and how often work is sent back,
spend where holders report it, and how each holder performs.

## Intake and connectors

A build starts from a ticket or an API call as well as the console, links
back to its ticket, and posts there when a gate waits and when it ends.
Connectors for the tracker, the repository host (Code as a pull request with
the gate run on every push) and notifications, each small and behind its own
published interface.

## Teams

An organization, its teams and projects, and people with roles (member,
approver, admin). Who may approve which gate is set per lifecycle. Sign-in
through the organization's single sign-on, or local accounts.

Built with local accounts: people.json, a key for each person, and
`approvers` in the lifecycle document (README, Teams). Single sign-on is
not built; OIDC plugs in at `identify()` in lib/people.mjs.

## Run stages handed to a runtime

Deploy and the stages after it (Conformance, Monitor, Eval, Incident, Cost,
Update, Rollback, Decommission) become bindings the build records and hands
to the runtime the team brings. The factory installs nothing and runs nothing
itself.

## General software

A new kind of product is added by naming its shape, its package and its
install target: a web service, a container, a library, an app. The
lifecycle, the stages, the roles and the factory stay the same.
