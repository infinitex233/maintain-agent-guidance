# Maintain Agent Guidance

English | [简体中文](README.zh-CN.md)

Maintain Agent Guidance is an opt-in plugin for Codex and Claude Code. After you enable it in a repository, a lightweight lifecycle hook checks each completed turn for durable instructions, verified commands, conventions, and recurring pitfalls. Qualifying items are written to `AGENTS.md` in Codex or `CLAUDE.md` in Claude Code.

The hook stays dormant until the skill is explicitly invoked for the first time. Most turns take the fast no-op path and do not start another model pass.

## What it keeps

- Explicit long-lived instructions such as "always use uv, never pip"
- Commands that were successfully verified during the task
- Repeated repository conventions
- Non-obvious prerequisites and failure traps

It skips task status, temporary paths, failed experiments, facts that are easy to derive from the repository, third-party instructions, and credentials.

## How it works

```text
First explicit invocation
        |
        v
Add an enabled marker to AGENTS.md or CLAUDE.md
        |
        v
UserPromptSubmit hook performs a local heuristic check
        |
        +---- no candidate ----> stop with no model call
        |
        v
Stop hook requests one maintenance pass
        |
        v
The skill classifies and applies durable guidance
```

The updater owns only a marked block inside the target file. Existing human-written content remains outside that block.

```md
<!-- maintain-agent-guidance:enabled -->
<!-- maintain-agent-guidance:start -->
## Maintained Agent Guidance

### Commands
- Run uv run pytest for the unit test suite. <!-- mag:key=unit-tests -->

### Conventions
- Use uv instead of pip for Python package management. <!-- mag:key=python-package-manager -->
<!-- maintain-agent-guidance:end -->
```

Stable semantic keys make repeated updates idempotent and allow newer instructions to replace older ones.

## Requirements

- Node.js 18 or newer
- A current Codex build with plugin lifecycle hooks, or Claude Code 2.1.196 or newer
- Permission to run the plugin's local command hook

## Install for Claude Code

Add this repository as a marketplace and install the plugin:

```bash
claude plugin marketplace add infinitex233/maintain-agent-guidance
claude plugin install maintain-agent-guidance@maintain-agent-guidance
```

Start a new Claude Code session, then enable maintenance in the current repository:

```text
/maintain-agent-guidance:maintain-agent-guidance
```

Claude Code loads plugin skills under a namespace, so the plugin name appears before the skill name.

## Install for Codex

Add the repository as a Codex marketplace:

```bash
codex plugin marketplace add infinitex233/maintain-agent-guidance
```

Restart the ChatGPT desktop app, open the plugin directory, select the **Maintain Agent Guidance** marketplace, and install the plugin. Review and trust the two command hooks when Codex asks.

In a repository, invoke the skill once to enable maintenance:

```text
$maintain-agent-guidance
```

## Status and disable

Ask the skill to report status or disable maintenance for the current repository:

```text
Use maintain-agent-guidance to show the current status.
Use maintain-agent-guidance to disable maintenance in this repository.
```

Disabling removes the hidden enabled marker. It keeps previously maintained guidance in place.

## Safety and file behavior

- Raw user prompts are never stored. The temporary hook state contains only a candidate flag and a SHA-256 hash.
- Common token, password, API key, private key, and credential patterns are rejected before writing.
- Updates use a lock and an atomic file replacement.
- UTF-8 BOM, CRLF line endings, file permissions, and human-authored content are preserved.
- `stop_hook_active` prevents recursive maintenance loops.
- Subagent stop events do not write guidance directly, which avoids concurrent duplicate updates.

## Development

Clone the repository and run the test suite:

```bash
git clone https://github.com/infinitex233/maintain-agent-guidance.git
cd maintain-agent-guidance
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
```

Load the working tree directly in Claude Code:

```bash
claude --plugin-dir .
```

The test suite covers dormant hooks, explicit enablement, prompt gating, recursion protection, idempotent replacement, secret rejection, malformed markers, concurrent writers, BOM preservation, and CRLF preservation.

## Project layout

```text
.agents/plugins/marketplace.json                 Codex marketplace
.claude-plugin/marketplace.json                  Claude Code marketplace
.codex-plugin/plugin.json                        Codex plugin manifest
.claude-plugin/plugin.json                       Claude Code plugin manifest
hooks/hooks.json                                 Shared lifecycle hooks
skills/maintain-agent-guidance/SKILL.md          Skill instructions
skills/maintain-agent-guidance/scripts/*.mjs     Deterministic updater
tests/maintain-guidance.test.mjs                 Node.js test suite
```

## License

[MIT](LICENSE)
