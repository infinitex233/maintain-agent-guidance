# Repository Guidelines

## Project Structure & Module Organization

- `.codex-plugin/` and `.claude-plugin/` contain the Codex and Claude Code manifests; `.agents/plugins/` contains the Codex marketplace entry.
- `hooks/hooks.json` wires lifecycle events to the shared updater.
- `skills/maintain-agent-guidance/SKILL.md` defines the agent workflow. Its `scripts/maintain-guidance.mjs` file contains the deterministic status, enable, disable, apply, and hook commands; `agents/openai.yaml` contains agent metadata.
- `tests/` holds the Node test suites: `distribution.test.mjs` validates manifests and packaging, while `maintain-guidance.test.mjs` covers updater behavior and safety cases.
- `README.md` and `README.zh-CN.md` are the user-facing documentation.

## Build, Test, and Development Commands

This repository has no package manager configuration or build step. Run the complete suite with:

```bash
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
```

To load the working tree as a Claude Code plugin, use `claude --plugin-dir .`. For direct updater checks, run commands such as `node skills/maintain-agent-guidance/scripts/maintain-guidance.mjs status --host codex --cwd .`.

## Coding Style & Naming Conventions

Use modern Node.js ESM in `.mjs` files, `node:` imports, two-space indentation, semicolons, and small focused helpers. Use `camelCase` for variables and functions, `PascalCase` only for types or classes, and descriptive kebab-case keys for maintained guidance. Keep JSON, Markdown, and JavaScript files UTF-8 with LF endings, as configured in `.gitattributes`.

## Testing Guidelines

Tests use Node's built-in `node:test` runner and `node:assert/strict`; no separate framework or coverage threshold is configured. Name tests as clear behavior statements and add regression coverage beside the affected suite. Exercise platform-sensitive changes on both POSIX and Windows assumptions when possible.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Initial release of maintain-agent-guidance` and `Harden guidance maintenance hooks`; follow that style and keep unrelated changes separate. Pull requests should explain the behavior change, list the exact test command run, and call out updates to manifests, hooks, or managed-file behavior. Include screenshots only for documentation or rendered-output changes.

## Safety & Configuration Notes

The updater must preserve human-authored content, BOM/line endings, and atomic-write behavior. Never persist raw prompts or credentials, bypass secret rejection, or edit the managed guidance block manually; use the updater command and verify its reported result.
