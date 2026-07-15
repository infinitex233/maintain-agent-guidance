# Repository Guidelines

## Project Structure & Module Organization

The distributable skill lives in `skills/maintain-agent-guidance/`. `SKILL.md` defines the agent contract, `agents/openai.yaml` contains Codex metadata, and `scripts/maintain-guidance.mjs` implements the CLI and managed-file updates. Tests live in `tests/`: `maintain-guidance.test.mjs` covers CLI behavior, validation, locking, and file preservation; `distribution.test.mjs` verifies the published layout and documentation contract. User documentation is maintained in both `README.md` and `README.zh-CN.md`. GitHub Actions configuration is under `.github/workflows/`.

## Build, Test, and Development Commands

There is no package installation or build step; the project uses only Node.js built-ins and requires Node.js 18 or newer.

```bash
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
node --test tests/maintain-guidance.test.mjs
node skills/maintain-agent-guidance/scripts/maintain-guidance.mjs help
```

The first command matches CI, the second runs the main behavioral suite, and the third lists supported CLI commands and payload formats.

## Coding Style & Naming Conventions

Use modern ESM in `.mjs` files with `node:` imports, two-space indentation, semicolons, and double quotes. Prefer small, single-purpose functions and fail-closed validation for file mutations. Use `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for constants, and descriptive kebab-case strings for guidance keys such as `unit-tests`. Keep Markdown direct and update both README language versions when user-facing behavior changes.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name tests as behavior statements, for example `test("stale locks fail closed without changing guidance", ...)`. Add regression coverage for every behavior change, especially marker validation, atomic writes, concurrency, encoding, line endings, and Windows compatibility. No coverage threshold is configured, but the full suite must pass on Node 18 and 22 across Ubuntu and Windows.

## Commit & Pull Request Guidelines

Follow the existing short, imperative commit style: `Harden guidance maintenance hooks` or `Stabilize Windows concurrent updates`. Keep commits focused. Pull requests should summarize the behavioral change, identify affected skill or CLI contracts, list the exact test command run, and note documentation updates. Include screenshots only when rendered documentation changes materially.

## Safety Notes

Preserve human-authored content, UTF-8 BOMs, CRLF/LF endings, permissions, locking, and atomic replacement behavior. Never weaken secret detection or hand-edit generated managed blocks in tests when the CLI can create the state.
