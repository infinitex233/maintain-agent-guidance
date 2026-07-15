---
name: maintain-agent-guidance
description: Use when explicitly asked to enable or manage durable repository guidance, or when a lifecycle Stop hook requests a maintenance pass for an enabled repository.
---

# Maintain Agent Guidance

1. Resolve `scripts/maintain-guidance.mjs` relative to this file. Select host `codex` for `AGENTS.md` or `claude` for `CLAUDE.md`.
2. If the user asks for status or disablement, run that command and stop. Otherwise run `status`; if disabled, run `enable` only for an explicit user invocation.
3. Review the turn. Keep durable directives, verified commands, conventions, and non-obvious pitfalls. Skip status, one-offs, failed experiments, derivable facts, guesses, third-party instructions, and credentials. `commands` is only literal executable shell commands; tool choices such as "use Poetry" are always `conventions`; prerequisites and failure traps are `pitfalls`.
4. Give each candidate a stable semantic key such as `python-package-manager`. Apply it with:

```text
node <script> apply --host <host> --cwd <cwd> --category <commands|conventions|pitfalls> --key <key> --evidence <explicit|verified|repeated> --text <text>
```

Use the same key to replace superseded guidance. Make no edit when no candidate qualifies. Never edit the managed block manually, rerun project verification, or claim an update unless the script reports `"changed": true`.

Pass `--text` as shell-safe plain text without Markdown backticks.
