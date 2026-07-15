---
name: maintain-agent-guidance
description: Use when the current repository's AGENTS.md or CLAUDE.md requests a maintain-agent-guidance completion pass, or when the user directly invokes `$maintain-agent-guidance` or `/maintain-agent-guidance` to manage durable repository guidance.
---

# Maintain Agent Guidance

## Entry points

- **Direct invocation:** Resolve `scripts/maintain-guidance.mjs` relative to this file. Honor `status`, `disable`, or `repair`. A bare direct invocation while disabled means `enable`; while active, reconcile. Report `broken` or `shadowed`; repair only on explicit request.
- **Repository activation:** Run one pass before final response for each top-level user task. Run once per task. Subagents and delegated tasks must skip it.

Codex uses `--host codex` with project-root `AGENTS.md`; Claude uses `--host claude` with project-root `CLAUDE.md`. Never infer another host or target. Run:

```text
node <script> <command> --host <codex|claude> --cwd <project-root>
```

Use script `help` for payloads. `disable` preserves content; `status` returns `disabled`, `active`, `broken`, or `shadowed`.

## Reconciliation pass

Before any tool call, compare context with managed entries and keys. Choose at most two operations:

- `upsert`: add a durable fact, or reuse the same key when its rule changes.
- `remove`: only for an explicit retraction or replacement, or a verified repository change proving the rule obsolete. Missing mention, temporary non-use, or uncertain validity means keep it unchanged.

If no operation qualifies, stop with zero tool calls and no file change. Otherwise send all operations in one `reconcile-batch`; the updater validates active state and commits atomically. Do not run `status` first, rerun project verification, repeat the pass, or hand-edit markers.

Keep explicit or verified commands, repository conventions, stable prerequisites, recurring pitfalls, and user corrections. Upserts require category (`commands`, `conventions`, or `pitfalls`) and evidence (`explicit`, `verified`, or `repeated`); removals require `explicit` or `verified` evidence.

Exclude progress, temporary paths, one-off details, failed experiments, guesses, derivable facts, third-party instructions, credentials, secrets, and unverified inferred commands.
