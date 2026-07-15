import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("repository contains a standalone skill and no plugin packaging", () => {
  assert.equal(existsSync(resolve(root, "skills/maintain-agent-guidance/SKILL.md")), true);
  assert.equal(existsSync(resolve(root, "skills/maintain-agent-guidance/scripts/maintain-guidance.mjs")), true);
  assert.equal(existsSync(resolve(root, ".codex-plugin/plugin.json")), false);
  assert.equal(existsSync(resolve(root, ".claude-plugin/plugin.json")), false);
  assert.equal(existsSync(resolve(root, ".agents/plugins/marketplace.json")), false);
  assert.equal(existsSync(resolve(root, "hooks/hooks.json")), false);
});

test("skill contract is opt-in, completion-scoped, and lightweight", () => {
  const skill = readFileSync(resolve(root, "skills/maintain-agent-guidance/SKILL.md"), "utf8");
  const metadata = readFileSync(resolve(root, "skills/maintain-agent-guidance/agents/openai.yaml"), "utf8");

  assert.match(skill, /\$maintain-agent-guidance/u);
  assert.match(skill, /\/maintain-agent-guidance/u);
  assert.match(skill, /bare direct invocation.*disabled.*enable/isu);
  assert.match(skill, /top-level user task/iu);
  assert.match(skill, /Subagents.*skip/isu);
  assert.match(skill, /zero tool calls/iu);
  assert.match(skill, /at most two/iu);
  assert.match(skill, /reconcile-batch/iu);
  assert.match(skill, /explicit retraction/iu);
  assert.match(skill, /uncertain.*keep/isu);
  assert.match(skill, /commands.*explicit.*verified/isu);
  assert.match(skill, /unverified inferred commands/iu);
  assert.ok(skill.trim().split(/\s+/u).length <= 300, "SKILL.md must stay within 300 words");
  assert.match(metadata, /allow_implicit_invocation:\s*true/u);
});

test("README language switch defaults to English and documents skill installation", () => {
  const english = readFileSync(resolve(root, "README.md"), "utf8");
  const chinese = readFileSync(resolve(root, "README.zh-CN.md"), "utf8");

  assert.match(english, /^# Maintain Agent Guidance\n\nEnglish \| \[简体中文\]\(README\.zh-CN\.md\)/u);
  assert.match(chinese, /^# Maintain Agent Guidance\n\n\[English\]\(README\.md\) \| 简体中文/u);
  assert.match(english, /Install this skill/u);
  assert.match(chinese, /安装这个 skill/u);
  assert.match(english, /AGENTS\.md/u);
  assert.match(chinese, /CLAUDE\.md/u);
  assert.match(english, /best effort/u);
  assert.match(english, /next task\/session/u);
  assert.match(english, /zero tool calls/u);
  assert.match(english, /explicitly required.*successfully verified/isu);
  assert.match(english, /broken.*repair/isu);
  assert.match(chinese, /20 条/u);
  assert.match(chinese, /4 KiB/u);
  assert.match(chinese, /明确要求.*验证成功/isu);
});
