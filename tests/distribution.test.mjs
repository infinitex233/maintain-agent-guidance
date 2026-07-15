import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("plugin and marketplace identities stay aligned", () => {
  const codexPlugin = readJson(".codex-plugin/plugin.json");
  const claudePlugin = readJson(".claude-plugin/plugin.json");
  const codexMarketplace = readJson(".agents/plugins/marketplace.json");
  const claudeMarketplace = readJson(".claude-plugin/marketplace.json");

  assert.equal(codexPlugin.name, "maintain-agent-guidance");
  assert.equal(claudePlugin.name, codexPlugin.name);
  assert.equal(claudePlugin.version, codexPlugin.version);
  assert.equal(codexMarketplace.plugins[0].name, codexPlugin.name);
  assert.equal(claudeMarketplace.plugins[0].name, codexPlugin.name);
  assert.equal(claudeMarketplace.plugins[0].version, codexPlugin.version);
  assert.equal(codexMarketplace.plugins[0].source.path, "./");
  assert.equal(claudeMarketplace.plugins[0].source, ".");
});

test("marketplace root contains both plugin manifests", () => {
  assert.equal(existsSync(resolve(root, ".codex-plugin/plugin.json")), true);
  assert.equal(existsSync(resolve(root, ".claude-plugin/plugin.json")), true);
  assert.equal(existsSync(resolve(root, "hooks/hooks.json")), true);
  assert.equal(existsSync(resolve(root, "skills/maintain-agent-guidance/SKILL.md")), true);
});

test("README language switch defaults to English and links both ways", () => {
  const english = readFileSync(resolve(root, "README.md"), "utf8");
  const chinese = readFileSync(resolve(root, "README.zh-CN.md"), "utf8");

  assert.match(english, /^# Maintain Agent Guidance\n\nEnglish \| \[简体中文\]\(README\.zh-CN\.md\)/u);
  assert.match(chinese, /^# Maintain Agent Guidance\n\n\[English\]\(README\.md\) \| 简体中文/u);
  assert.match(english, /infinitex233\/maintain-agent-guidance/u);
  assert.match(chinese, /infinitex233\/maintain-agent-guidance/u);
});
