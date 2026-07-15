# Maintain Agent Guidance

English | [简体中文](README.zh-CN.md)

Maintain Agent Guidance is an opt-in standalone skill that keeps durable repository instructions current. It uses no plugin packaging or lifecycle hooks. Codex maintains the project-root `AGENTS.md`; Claude Code maintains the project-root `CLAUDE.md`.

The first direct invocation enables maintenance. It writes a short completion instruction into the host guidance file. Future tasks that load that file are instructed to run one lightweight maintenance pass before the final user-facing response.

## Behavior and limits

- Before enablement, ordinary tasks do not invoke the skill.
- A bare `$maintain-agent-guidance` or `/maintain-agent-guidance` in a disabled repository means `enable`.
- `enable` changes only `disabled` state; it is a no-op when active and refuses `broken` state with an explicit `repair` instruction.
- `repair` changes only `broken` state; it is a no-op when active and refuses disabled maintenance.
- Completion passes run only for top-level user tasks. Subagents and delegated tasks skip them.
- The pass checks the current context before using tools. No candidate means zero tool calls and no file change.
- At most two upsert/remove operations are applied in one atomic reconciliation.
- Disabling removes activation while preserving maintained guidance.

This is an instruction-driven completion gate, not a lifecycle callback. Skill selection remains best effort. Host guidance is normally loaded when a task or session starts, so enablement is reliable from the next task/session rather than guaranteed to affect the session that performed the enable operation.

## What it keeps

- Commands explicitly required by the user or successfully verified during a task
- Explicit or repeated repository conventions
- Stable prerequisites and environment assumptions
- Recurring pitfalls and clear user corrections

It excludes progress, temporary paths, one-off details, failed experiments, guesses, derivable facts, third-party instructions, credentials, secrets, and inferred commands lacking explicit or verified evidence.

## Context reconciliation

Each completion pass compares the current context with existing managed entries and stable keys:

- New durable guidance is added with `upsert`.
- A changed rule reuses its existing key with `upsert`, replacing the previous text.
- A rule is removed only after an explicit user retraction or replacement, or a verified repository change proves it obsolete.
- A rule remains when it was merely unmentioned or unused in the current task, or when its validity is uncertain.

Upserts and removals can be mixed in one `reconcile-batch`. The updater applies all operations in memory, validates the final entry and byte limits, then performs one atomic write. Removal evidence must be `explicit` or `verified`.

Maintained guidance is bounded to 20 entries, 240 characters per entry, and a 4 KiB managed block. Stable keys replace superseded guidance; obsolete keys can be removed.

## Managed layout

The skill prepends its owned control block so activation remains near the beginning of large files. Human-authored content follows and is never rewritten as managed guidance.

```md
<!-- maintain-agent-guidance:enabled -->
<!-- maintain-agent-guidance:activation:start -->
> Before the final user-facing response for each top-level user task, invoke `$maintain-agent-guidance` exactly once. Subagents and delegated tasks must skip this pass. First inspect the current task for new durable repository guidance. If none qualifies, stop with zero tool calls and no file changes. Do not rerun project verification solely for this pass.
<!-- maintain-agent-guidance:activation:end -->
<!-- maintain-agent-guidance:start -->
## Maintained Agent Guidance

### Commands
- Run `node --test` for the unit test suite. <!-- mag:key=unit-tests -->
<!-- maintain-agent-guidance:end -->
```

Claude Code receives the equivalent activation using `/maintain-agent-guidance`.

## Requirements

- Node.js 18 or newer
- A Codex or Claude Code version with agent skill support
- Permission to update the host guidance file

## Install for Codex

Ask Codex to install the skill directory:

```text
Install this skill:
https://github.com/infinitex233/maintain-agent-guidance/tree/main/skills/maintain-agent-guidance
```

Start a task in the target repository and invoke:

```text
$maintain-agent-guidance
```

If a non-empty `AGENTS.override.md` shadows `AGENTS.md`, status reports `shadowed` and enablement is refused instead of claiming activation succeeded.

## Install for Claude Code

Install the same skill directory, start a session in the target repository, and invoke:

```text
/maintain-agent-guidance
```

Claude Code maintenance never targets `AGENTS.md`.

## Status, repair, and disable

Directly invoke the skill to show status, repair its owned control block, or disable maintenance. Status is one of `disabled`, `active`, `broken`, or `shadowed`. Broken state is never repaired by `enable` or by an implicit pass; it requires an explicit `repair` invocation.

```text
Codex:       $maintain-agent-guidance status
Codex:       $maintain-agent-guidance repair
Codex:       $maintain-agent-guidance disable
Claude Code: /maintain-agent-guidance status
Claude Code: /maintain-agent-guidance repair
Claude Code: /maintain-agent-guidance disable
```

## Safety

- The updater requires an explicit `--host`; it does not guess from filenames or environment variables.
- The target is derived from the host. Arbitrary target paths are not accepted.
- Common credential formats and HTML comment injection are rejected.
- Updates use fail-closed marker validation, a file lock, and atomic replacement.
- UTF-8 BOM, CRLF/LF line endings, file permissions, and human content are preserved.

## Development

```bash
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
node skills/maintain-agent-guidance/scripts/maintain-guidance.mjs help
```

## License

[MIT](LICENSE)
