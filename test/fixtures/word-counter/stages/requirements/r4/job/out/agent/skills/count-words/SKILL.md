---
name: count-words
description: when a person or system has a single sentence of text and needs to know exactly how many words are in it
---

# Count words

Part of word-counter. when a person or system has a single sentence of text and needs to know exactly how many words are in it

## When to use this

when a person or system has a single sentence of text and needs to know exactly how many words are in it

## What this needs

- sentence (text/markdown, required)

## What a good result looks like

A precise integer representing the exact number of words contained within the provided sentence, returned as a single JSON reply object with a count field, free of any extraneous commentary, formatting, or conversational text, allowing immediate automated use by the caller.

## What it produces

- word count (application/vnd.agentmesh.wordcount+json, per task)

## When it comes back empty

If nothing is provided, or if the text is not a single sentence, it does not attempt to count. It stops, returns no count, and explains that exactly one sentence of text is required.

## How to do it

Run `node scripts/count.mjs --job <job folder>`. It reads the sentence, counts the words separated by whitespace, and prints a JSON object with a `reply` field containing the count.

## Scripts

Run these from this skill's folder; each one says what it needs at the top.

- scripts/count.mjs
- scripts/went-without.mjs
