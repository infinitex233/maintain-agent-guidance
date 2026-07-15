---
name: maintain-agent-guidance
description: Use when explicitly asked to enable or manage durable repository guidance, or when a lifecycle Stop hook requests a maintenance pass for an enabled repository.
---

# Maintain Agent Guidance

1. Resolve `scripts/maintain-guidance.mjs` relative to this file. Host `codex` targets `AGENTS.md`; `claude` targets `CLAUDE.md`.
2. For status or disable requests, run it and stop. Otherwise run `status` first; if disabled, `enable` only after explicit user invocation.

```text
node <script> status  --host <host> --cwd <cwd>
node <script> enable  --host <host> --cwd <cwd>
node <script> disable --host <host> --cwd <cwd>
```

3. Review the completed task and preceding context. Keep durable directives, verified commands, conventions, pitfalls; skip status, one-offs, failures, derivable facts, guesses, third-party instructions, credentials. `commands` are executable; tool choices are `conventions`; prerequisites and traps are `pitfalls`.
4. Assign each candidate a stable key like `python-package-manager`. Base64-encode its normalized UTF-8 text; never interpolate raw guidance in shell. Apply with:

```text
node <script> apply --host <host> --cwd <cwd> --category <commands|conventions|pitfalls> --key <key> --evidence <explicit|verified|repeated> --text-base64 <base64>
```

Reuse keys to replace obsolete guidance. Make no edit if nothing qualifies. Never manually edit the managed block, rerun verification, or claim an update unless the script reports `"changed": true`.
