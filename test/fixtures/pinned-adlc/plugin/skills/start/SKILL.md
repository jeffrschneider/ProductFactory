---
name: start
description: Start building a new agent through the ADLC, from the person's own words. Use when someone asks to build, make or start a new agent.
argument-hint: <folder> <what the agent should do, in the person's words>
---

Start a new build folder and take the agent from the person's request through the Agent Development Lifecycle.

1. The first word of the arguments is the folder; everything after it is the person's request. If there is no request, ask the person what the agent should do, in their words.
2. Lay out the folder: `node "${CLAUDE_PLUGIN_ROOT}/kit/start.mjs" <folder>`. (A folder started with an earlier plugin gets this one's kit with `node "${CLAUDE_PLUGIN_ROOT}/kit/start.mjs" --update <folder>`.)
3. In that folder, write the person's request to `request.md`, exactly as they said it.
4. Follow the adlc skill from its first phase, the spec, running `node .adlc/check.mjs` as often as you like.

Arguments: $ARGUMENTS
