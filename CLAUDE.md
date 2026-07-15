# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Maintain Agent Guidance is an opt-in plugin distributed for both Claude Code and Codex. Once enabled in a repository, lifecycle hooks identify likely durable instructions from completed turns and ask the plugin skill to persist qualified guidance in the host's file (`CLAUDE.md` for Claude Code or `AGENTS.md` for Codex).

The updater owns only a marker-delimited managed block. Human-authored content outside that block must remain intact. Maintained entries are categorized as `Commands`, `Conventions`, or `Pitfalls` and carry stable `mag:key` identifiers so repeated updates are idempotent and superseded guidance can be replaced.

## Development commands

This is a dependency-free Node.js ESM project. There is no `package.json`, package manager, build step, or configured linter. Node.js 18 or newer is required.

Run the full test suite:

```bash
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
```

Run one test file:

```bash
node --test tests/maintain-guidance.test.mjs
```

Run a single named test with Node's built-in test filter:

```bash
node --test --test-name-pattern="apply is idempotent" tests/maintain-guidance.test.mjs
```

Load the current checkout as a Claude Code plugin during development:

```bash
claude --plugin-dir .
```

Inspect the updater's status for a repository without changing it:

```bash
node skills/maintain-agent-guidance/scripts/maintain-guidance.mjs status --host claude --cwd <repository-path>
```

CI runs the full suite on Ubuntu and Windows with Node 18 and 22.

## Architecture

- `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are the host manifests; the marketplace metadata is in `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. Distribution tests keep these identities and required paths aligned.
- `hooks/hooks.json` registers the same updater command for `UserPromptSubmit` and `Stop`, with a five-second command timeout.
- `skills/maintain-agent-guidance/SKILL.md` defines the agent-facing policy: check status first, enable only after explicit invocation, classify only durable/verified/repeated guidance, assign stable keys, and invoke the updater rather than editing managed content directly.
- `skills/maintain-agent-guidance/scripts/maintain-guidance.mjs` is the deterministic core. Its CLI supports `status`, `enable`, `disable`, `apply`, and `hook`. It finds the Git root, detects the host, selects the target file, validates markers, normalizes and secret-checks guidance, and serializes updates through a lock plus atomic replacement.
- The hook path is deliberately lightweight. It stays dormant until enablement, uses prompt/assistant heuristics to gate model work, records only lifecycle state and a SHA-256 prompt hash, avoids recursive Stop handling, and defers when background work is active.
- File mutation preserves UTF-8 BOMs, detected CRLF/LF line endings, existing permissions, human-authored content, and fail-closed behavior for malformed markers or stale locks.
- `tests/distribution.test.mjs` checks manifests, marketplace metadata, required distribution files, and the bilingual README links. `tests/maintain-guidance.test.mjs` exercises lifecycle gating, host detection, idempotent keyed replacement, safe text transport, secret rejection, malformed markers, concurrent writers, stale-lock diagnostics, and BOM/CRLF preservation.

## Working with the updater

Use the script's host-specific target selection rather than assuming the target file. The normal lifecycle is:

```text
status -> enable (only for an explicit request) -> hook candidate detection -> skill classification -> apply
```

For a direct update, use `apply` with `--category`, `--key`, `--evidence`, and either `--text` or `--text-base64`. Base64 is preferred when transporting shell metacharacters. Reuse a key when replacing obsolete guidance. Do not manually edit the managed block; malformed markers cause the updater to refuse changes.

Keep the updater self-contained and platform-neutral: changes to file handling, lifecycle input, host detection, locking, or text validation should preserve the Windows and POSIX assumptions covered by the test suite.

## Repository conventions

Node source uses modern ESM `.mjs` files, `node:` imports, two-space indentation, semicolons, and small focused helpers. Variables and functions use `camelCase`; stable maintained-guidance keys use descriptive kebab case. `.gitattributes` specifies LF endings for Markdown, JSON, and `.mjs` files.

User-facing documentation is maintained in both `README.md` and `README.zh-CN.md`; changes to installation, commands, or behavior should keep the corresponding language documentation aligned.
