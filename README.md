# Maintain Agent Guidance

English | [简体中文](README.zh-CN.md)

Maintain Agent Guidance is an opt-in plugin for Codex and Claude Code. After you enable it in a repository, a lightweight lifecycle hook checks each completed turn for durable instructions, verified commands, conventions, and recurring pitfalls. Qualifying items are written to `AGENTS.md` in Codex or `CLAUDE.md` in Claude Code.

Before the skill is explicitly invoked, each hook process exits after checking for the enable marker. It does not write state or request another model pass. Enabled turns that do not match a candidate also take the local no-op path.

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

## Lightweight behavior

Codex uses [progressive disclosure](https://learn.chatgpt.com/docs/build-skills.md) for skills. Its normal skill catalog contains the name, description, and file path; the full `SKILL.md` loads only when Codex selects the skill. Using the `o200k_base` tokenizer as an estimate, this plugin adds about 65 tokens to that catalog and its complete skill is about 357 tokens.

Installing and enabling the plugin registers two local Node.js hook processes per turn. Repository maintenance is a separate opt-in: without the enable marker, both processes return after a file check. After enablement, ordinary turns run only local heuristics and, with current hook inputs, do not write state. In a local benchmark on Windows with Node.js 22, the two no-op hooks together took a median 0.18 to 0.20 seconds. Actual time depends on the host machine and filesystem.

A matching candidate requests one extra model continuation. The static skill and hook instructions add roughly 400 tokens, while the total cost depends on the existing conversation and the model's response. Broad phrases such as `must`, `avoid`, or `root cause is` can trigger this check even when the skill ultimately writes nothing. Maintained entries also become normal `AGENTS.md` or `CLAUDE.md` context, so the skill keeps only concise, durable guidance.

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

- Raw user prompts are never stored. Temporary hook state contains only lifecycle identifiers and counters, a candidate flag, and a SHA-256 hash.
- Common GitHub, GitLab, npm, AWS, Google, Slack, Bearer, JWT, password, private key, and credential patterns are rejected before writing.
- Updates use a fail-closed lock and an atomic file replacement; stale locks report an actionable path instead of risking concurrent writes.
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

The test suite covers dormant hooks, explicit enablement, realistic Claude and Codex hook input, host detection, prompt gating, recursion protection, idempotent replacement, shell-safe text transport, secret rejection, malformed markers, concurrent writers, stale-lock diagnostics, BOM preservation, and CRLF preservation.

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
