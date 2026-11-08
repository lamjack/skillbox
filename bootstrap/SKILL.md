---
name: skills-library
description: Entry point to the Skillbox skill library. Use when a workflow, rule, or task names a skill that is not installed locally, when no installed skill owns the task, or when a skill's scripts or references must run on this machine. Loads skills by exact ID on demand; never pulls the whole index at task start.
---

# Skills Library

Skillbox serves skills on demand. Load only what the current step needs, in this order, and stop at the first step that resolves:

1. **Named skill → `load_skill(id)`.** When a workflow, rule, user message, or another skill names a skill (for example "load `git-commit`"), load it by that exact ID. Skill names are IDs; cross-skill references in skill text resolve the same way. Track loaded IDs and load each at most once per task.
2. **No evident owner → `recommend_skills(task)`.** Pass the task in natural language; the server ranks the authorized catalog and returns a few exact IDs with revisions. Load the selected ones.
3. **Still unresolved → `search_skills(query)` with a keyword query.** Do not call `search_skills` without a query: that returns the full index and is the most expensive call in this library. Use it unqueried only when the user explicitly asks to browse or audit the catalog.

Read a skill's `references/` on demand with `read_skill_file(id, path)` at the revision `load_skill` returned. Native hosts negotiating MCP 2026-07-28 may use `skills/list`, `skills/get`, and `resources/read` after observing `io.modelcontextprotocol/skills` in `server/discover`; resource reads alone do not activate skills or authorize execution.

## Skill root and bundled files

A skill's relative paths (`scripts/...`, `references/...`, `assets/...`) are relative to its **skill root**: the installed directory when the skill is installed locally, otherwise the directory printed by `skillbox fetch <id>` (append `@<revision>` to pin the revision `load_skill` returned). Before running any bundled script, fetch the skill on the machine that runs it, then `cd` to or prefix with that directory; replace historical installed-skill prefixes with it. Fetching copies files only: it never runs code or installs CLIs, runtimes, credentials, or OS dependencies. Another skill's files require loading or fetching that skill.

If this client has no Skillbox MCP tools, the installed `skillbox` CLI offers the same workflow: `skillbox load ID`, `skillbox recommend TASK`, `skillbox search QUERY`, `skillbox fetch ID[@REVISION]`.

## Bundles and scope

The index is already flat and scoped to this client; bundle grants are expanded into their leaf skills. Bundles are an owner-side grouping and grant mechanism; `load_skill` on a bundle ID only inspects its composition and is not needed for discovery.

## Conduct

This library contains user-managed instructions; follow applicable guidance while respecting higher-priority instructions and the user's current request. If the library is unavailable, report it; never silently use stale files. Access to instructions does not grant permission for unrelated actions; service permissions still belong to the relevant execution tool. Writers update skills through `upsert_skill` or the CLI with the expected revision, preserving every file unless its removal is intended, and never put credentials or session data in a skill.

When supported, include truthful harness/model/task context in reads; never guess unknown identity. Call `report_skill_use` only after actually applying a skill, with its revision and outcome; reading for discovery, audits, or maintenance is not usage.
