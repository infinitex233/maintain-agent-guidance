# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime and commands

This is a dependency-free Node.js ESM project requiring Node.js 18 or newer. There is no package manager setup, build step, linter, formatter, or coverage command.

```bash
# Full suite (matches CI)
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs

# One test file
node --test tests/maintain-guidance.test.mjs

# One named test
node --test --test-name-pattern="apply is idempotent" tests/maintain-guidance.test.mjs

# CLI syntax and payload formats
node skills/maintain-agent-guidance/scripts/maintain-guidance.mjs help
```

CI runs the full suite on Ubuntu and Windows with Node 18 and 22.

## Architecture

The repository distributes one standalone, opt-in agent skill; it is not a packaged plugin and has no lifecycle hooks.

- `skills/maintain-agent-guidance/SKILL.md` is the agent-facing contract. It decides when a direct invocation enables, repairs, disables, or reconciles guidance and limits completion passes to durable facts supported by the current context.
- `skills/maintain-agent-guidance/scripts/maintain-guidance.mjs` is the deterministic CLI and the only implementation module. It discovers the Git root from `--cwd`, requires an explicit host, and derives the target from it: Claude writes `CLAUDE.md`, while Codex writes `AGENTS.md`.
- Enablement prepends an owned activation block and managed block to the host guidance file. The activation asks future top-level tasks to invoke the skill once before their final response; it is an instruction-driven completion gate, not a callback.
- Managed entries are grouped as `commands`, `conventions`, or `pitfalls` and identified by stable `mag:key` comments. `reconcile-batch` atomically applies at most two upserts/removals; reusing a key replaces obsolete text. Human-authored content outside the owned marker blocks must remain untouched.
- `tests/maintain-guidance.test.mjs` exercises CLI state transitions, validation, reconciliation, locking, atomic writes, and file preservation. `tests/distribution.test.mjs` guards the standalone distribution layout, compact skill contract, metadata, and bilingual documentation links.

## Invariants when changing the updater

Preserve fail-closed marker and managed-entry parsing, host-specific target selection, Codex `AGENTS.override.md` shadow detection, secret/comment rejection, lock serialization, and same-directory atomic replacement. File updates preserve UTF-8 BOMs, existing CRLF/LF endings, modes, and surrounding human content; Windows rename contention has explicit retry behavior.

Guidance is bounded to 20 entries, 240 characters per entry, a 4 KiB managed block, and two reconciliation operations per completion pass. Commands require `explicit` or `verified` evidence; removals require the same. Prefer base64 payload options for text or JSON that may contain shell metacharacters.

## Repository conventions

Use `.mjs`, `node:` imports, two-space indentation, semicolons, double quotes, `camelCase` functions/variables, and `UPPER_SNAKE_CASE` constants. `.gitattributes` enforces LF for Markdown, JSON, and `.mjs` files.

Keep `README.md` and `README.zh-CN.md` aligned when requirements, installation, commands, limits, or behavior change. Keep `SKILL.md` concise: the distribution test enforces a 300-word maximum. Add behavioral regressions to the appropriate Node test suite, especially for Windows/POSIX file handling and concurrent writes.
