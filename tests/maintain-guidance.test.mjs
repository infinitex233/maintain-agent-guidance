import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../skills/maintain-agent-guidance/scripts/maintain-guidance.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "maintain-agent-guidance-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  return { base, repo };
}

function run(args, { cwd, extraEnv = {} }) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  const stdout = result.stdout.trim();
  let json = null;
  if (stdout.startsWith("{") || stdout.startsWith("[")) json = JSON.parse(stdout);
  return {
    ...result,
    json,
  };
}

function runAsync(args, { cwd }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function enable(repo, host = "codex") {
  const result = run(["enable", "--cwd", repo, "--host", host], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  return result.json;
}

function status(repo, host = "codex") {
  const result = run(["status", "--cwd", repo, "--host", host], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  return result.json;
}

function repair(repo, host = "codex") {
  const result = run(["repair", "--cwd", repo, "--host", host], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  return result.json;
}

test("Codex enable adds a completion instruction to AGENTS.md and is idempotent", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  writeFileSync(target, "# Human guidance\n\n- Keep this line.\n", "utf8");

  const first = enable(repo, "codex");
  assert.equal(first.target, target);
  assert.equal(first.enabled, true);
  assert.equal(first.changed, true);
  const content = readFileSync(target, "utf8");
  assert.match(content, /Keep this line/);
  assert.match(content, /maintain-agent-guidance:enabled/);
  assert.match(content, /maintain-agent-guidance:activation:start/);
  assert.match(content, /\$maintain-agent-guidance/);
  assert.match(content, /top-level user task/);
  assert.match(content, /Subagents and delegated tasks must skip/);
  assert.match(content, /zero tool calls/);
  assert.match(content, /maintain-agent-guidance:start/);
  assert.ok(content.indexOf("maintain-agent-guidance:activation:start") < content.indexOf("# Human guidance"));
  assert.ok(content.indexOf("maintain-agent-guidance:start") < content.indexOf("# Human guidance"));

  const second = enable(repo, "codex");
  assert.equal(second.changed, false);
  assert.equal(readFileSync(target, "utf8"), content);

  const repairedActive = repair(repo, "codex");
  assert.equal(repairedActive.changed, false);
  assert.equal(readFileSync(target, "utf8"), content);
});

test("Claude enable targets CLAUDE.md and never creates AGENTS.md", () => {
  const { repo } = fixture();
  const result = enable(repo, "claude");

  assert.equal(result.target, join(repo, "CLAUDE.md"));
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
  const content = readFileSync(join(repo, "CLAUDE.md"), "utf8");
  assert.match(content, /\/maintain-agent-guidance/);
  assert.doesNotMatch(content, /\$maintain-agent-guidance/);
});

test("host is required and arbitrary targets are rejected", () => {
  const { repo } = fixture();
  writeFileSync(join(repo, "CLAUDE.md"), "# Claude guidance\n", "utf8");

  const missingHost = run(["status", "--cwd", repo], {
    cwd: repo,
    extraEnv: { MAG_HOST: "claude", CLAUDE_CODE_ENTRYPOINT: "1" },
  });
  assert.notEqual(missingHost.status, 0);
  assert.match(missingHost.stderr, /--host.*required/i);

  const outside = join(dirname(repo), "outside.md");
  const arbitraryTarget = run([
    "enable", "--cwd", repo, "--host", "codex", "--target", outside,
  ], { cwd: repo });
  assert.notEqual(arbitraryTarget.status, 0);
  assert.match(arbitraryTarget.stderr, /unknown option.*target/i);
  assert.equal(existsSync(outside), false);
});

test("status reports disabled, active, broken, and shadowed states", () => {
  const { repo } = fixture();
  assert.equal(status(repo).state, "disabled");

  enable(repo);
  assert.equal(status(repo).state, "active");

  const target = join(repo, "AGENTS.md");
  const active = readFileSync(target, "utf8");
  writeFileSync(target, active.replace("exactly once", "more than once"), "utf8");
  assert.equal(status(repo).state, "broken");

  const repaired = run(["repair", "--cwd", repo, "--host", "codex"], { cwd: repo });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(status(repo).state, "active");

  const override = join(repo, "AGENTS.override.md");
  writeFileSync(override, "# Override\n", "utf8");
  const shadowed = status(repo);
  assert.equal(shadowed.state, "shadowed");
  assert.equal(shadowed.shadowedBy, override);

  const before = readFileSync(target, "utf8");
  const refused = run(["enable", "--cwd", repo, "--host", "codex"], { cwd: repo });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /shadowed/i);
  assert.equal(readFileSync(target, "utf8"), before);

  enable(repo, "claude");
  assert.equal(status(repo, "claude").state, "active");
});

test("an enabled marker without owned blocks is repaired without duplication", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  writeFileSync(target, "<!-- maintain-agent-guidance:enabled -->\n", "utf8");

  assert.equal(status(repo).state, "broken");
  const before = readFileSync(target, "utf8");
  const refused = run(["enable", "--cwd", repo, "--host", "codex"], { cwd: repo });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /broken.*repair/i);
  assert.equal(readFileSync(target, "utf8"), before);

  repair(repo);
  const content = readFileSync(target, "utf8");
  assert.equal((content.match(/maintain-agent-guidance:enabled/g) ?? []).length, 1);
  assert.equal(status(repo).state, "active");
});

test("repair refuses to enable disabled maintenance", () => {
  const { repo } = fixture();
  const result = run(["repair", "--cwd", repo, "--host", "codex"], { cwd: repo });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disabled.*enable/i);
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
});

test("disable removes activation but keeps human and maintained guidance", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  writeFileSync(target, "# Human guidance\n\n- Preserve me.\n", "utf8");
  enable(repo);
  const applied = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "python-package-manager",
    "--evidence", "explicit", "--text", "Use `uv` instead of `pip` for Python package management.",
  ], { cwd: repo });
  assert.equal(applied.status, 0, applied.stderr);

  const disabled = run(["disable", "--cwd", repo, "--host", "codex"], { cwd: repo });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.json.enabled, false);
  const content = readFileSync(target, "utf8");
  assert.doesNotMatch(content, /maintain-agent-guidance:enabled/);
  assert.doesNotMatch(content, /maintain-agent-guidance:activation/);
  assert.doesNotMatch(content, /final user-facing response/);
  assert.match(content, /Preserve me/);
  assert.match(content, /Use `uv` instead/);
  assert.match(content, /maintain-agent-guidance:start/);
});

test("repair migrates an existing marker-only installation to the completion instruction", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  writeFileSync(target, [
    "# Existing",
    "",
    "<!-- maintain-agent-guidance:enabled -->",
    "<!-- maintain-agent-guidance:start -->",
    "## Maintained Agent Guidance",
    "<!-- maintain-agent-guidance:end -->",
    "",
  ].join("\n"), "utf8");

  assert.equal(status(repo).state, "broken");
  const before = readFileSync(target, "utf8");
  const refused = run(["enable", "--cwd", repo, "--host", "codex"], { cwd: repo });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /broken.*repair/i);
  assert.equal(readFileSync(target, "utf8"), before);

  const result = repair(repo);
  assert.equal(result.changed, true);
  const content = readFileSync(target, "utf8");
  assert.equal((content.match(/maintain-agent-guidance:enabled/g) ?? []).length, 1);
  assert.equal((content.match(/maintain-agent-guidance:activation:start/g) ?? []).length, 1);
  assert.match(content, /top-level user task/);
});

test("apply refuses to write before explicit enablement", () => {
  const { repo } = fixture();
  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "formatter",
    "--evidence", "explicit", "--text", "Use the repository formatter.",
  ], { cwd: repo });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not active/i);
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
});

test("apply is idempotent and a stable key replaces superseded guidance", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);

  const addArgs = [
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "python-package-manager",
    "--evidence", "explicit", "--text", "Use `uv` instead of `pip` for Python package management.",
  ];
  const first = run(addArgs, { cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.changed, true);
  const firstContent = readFileSync(target, "utf8");
  const firstMtime = statSync(target).mtimeMs;

  const second = run(addArgs, { cwd: repo });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.changed, false);
  assert.equal(readFileSync(target, "utf8"), firstContent);
  assert.equal(statSync(target).mtimeMs, firstMtime);

  const replacement = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "python-package-manager",
    "--evidence", "explicit", "--text", "Use Poetry instead of `uv` for Python package management.",
  ], { cwd: repo });
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.equal(replacement.json.changed, true);

  const finalContent = readFileSync(target, "utf8");
  assert.match(finalContent, /Use Poetry instead/);
  assert.doesNotMatch(finalContent, /Use `uv` instead/);
  assert.equal((finalContent.match(/mag:key=python-package-manager/g) ?? []).length, 1);
});

test("commands accept explicit or verified evidence but reject repeated evidence", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);

  const explicit = run([
    "apply", "--cwd", repo, "--host", "codex", "--category", "commands",
    "--key", "user-test-command", "--evidence", "explicit", "--text", "Run `uv run pytest` for future test runs.",
  ], { cwd: repo });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(readFileSync(target, "utf8"), /mag:key=user-test-command/);

  const before = readFileSync(target, "utf8");
  const repeated = run([
    "apply", "--cwd", repo, "--host", "codex", "--category", "commands",
    "--key", "inferred-command", "--evidence", "repeated", "--text", "Run an inferred command in future tasks.",
  ], { cwd: repo });
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /command evidence must be explicit or verified/i);
  assert.equal(readFileSync(target, "utf8"), before);
});

test("apply-batch updates at most two candidates atomically", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  const items = [
    {
      category: "commands",
      key: "unit-tests",
      evidence: "verified",
      text: "Run `node --test` for the unit test suite.",
    },
    {
      category: "pitfalls",
      key: "redis-required",
      evidence: "repeated",
      text: "Start Redis before running integration tests.",
    },
  ];

  const result = run([
    "apply-batch", "--cwd", repo, "--host", "codex",
    "--items-base64", Buffer.from(JSON.stringify(items), "utf8").toString("base64"),
  ], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.changed, true);
  assert.equal(result.json.results.length, 2);
  const content = readFileSync(target, "utf8");
  assert.match(content, /mag:key=unit-tests/);
  assert.match(content, /mag:key=redis-required/);

  const before = readFileSync(target, "utf8");
  const tooMany = run([
    "apply-batch", "--cwd", repo, "--host", "codex",
    "--items-base64", Buffer.from(JSON.stringify([...items, items[0]]), "utf8").toString("base64"),
  ], { cwd: repo });
  assert.notEqual(tooMany.status, 0);
  assert.match(tooMany.stderr, /at most 2/i);
  assert.equal(readFileSync(target, "utf8"), before);
});

test("remove deletes one managed key and is idempotent", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  for (const [category, key, text] of [
    ["commands", "unit-tests", "Run `node --test` for tests."],
    ["conventions", "module-format", "Use ECMAScript modules in Node.js files."],
  ]) {
    const applied = run([
      "apply", "--cwd", repo, "--host", "codex", "--category", category,
      "--key", key, "--evidence", "verified", "--text", text,
    ], { cwd: repo });
    assert.equal(applied.status, 0, applied.stderr);
  }

  const first = run([
    "remove", "--cwd", repo, "--host", "codex", "--key", "unit-tests",
  ], { cwd: repo });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.changed, true);
  const content = readFileSync(target, "utf8");
  assert.doesNotMatch(content, /mag:key=unit-tests/);
  assert.doesNotMatch(content, /### Commands/);
  assert.match(content, /mag:key=module-format/);

  const second = run([
    "remove", "--cwd", repo, "--host", "codex", "--key", "unit-tests",
  ], { cwd: repo });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.changed, false);
});

test("reconcile-batch atomically updates and removes guidance", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  for (const [category, key, text] of [
    ["conventions", "python-package-manager", "Use `uv` for Python package management."],
    ["pitfalls", "redis-required", "Start Redis before integration tests."],
  ]) {
    const applied = run([
      "apply", "--cwd", repo, "--host", "codex", "--category", category,
      "--key", key, "--evidence", "verified", "--text", text,
    ], { cwd: repo });
    assert.equal(applied.status, 0, applied.stderr);
  }

  const operations = [
    {
      op: "upsert",
      category: "conventions",
      key: "python-package-manager",
      evidence: "explicit",
      text: "Use Poetry for Python package management.",
    },
    { op: "remove", key: "redis-required", evidence: "explicit" },
  ];
  const result = run([
    "reconcile-batch", "--cwd", repo, "--host", "codex",
    "--operations-base64", Buffer.from(JSON.stringify(operations), "utf8").toString("base64"),
  ], { cwd: repo });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.changed, true);
  assert.deepEqual(result.json.results.map(({ op, key, changed }) => ({ op, key, changed })), [
    { op: "upsert", key: "python-package-manager", changed: true },
    { op: "remove", key: "redis-required", changed: true },
  ]);
  const content = readFileSync(target, "utf8");
  assert.match(content, /Use Poetry/);
  assert.doesNotMatch(content, /Use `uv`/);
  assert.doesNotMatch(content, /redis-required/);
});

test("reconcile-batch validates capacity against the final state", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  for (let index = 0; index < 20; index += 1) {
    const result = run([
      "apply", "--cwd", repo, "--host", "codex", "--category", "conventions",
      "--key", `rule-${index}`, "--evidence", "repeated", "--text", `Keep durable rule number ${index}.`,
    ], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
  }

  const operations = [
    {
      op: "upsert",
      category: "conventions",
      key: "replacement-rule",
      evidence: "explicit",
      text: "Keep the replacement durable rule.",
    },
    { op: "remove", key: "rule-0", evidence: "verified" },
  ];
  const result = run([
    "reconcile-batch", "--cwd", repo, "--host", "codex",
    "--operations-base64", Buffer.from(JSON.stringify(operations), "utf8").toString("base64"),
  ], { cwd: repo });

  assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(target, "utf8");
  assert.equal((content.match(/<!-- mag:key=/g) ?? []).length, 20);
  assert.match(content, /mag:key=replacement-rule/);
  assert.doesNotMatch(content, /mag:key=rule-0(?:\s|--)/);

  const beforeOverflow = readFileSync(target, "utf8");
  const overflow = run([
    "reconcile-batch", "--cwd", repo, "--host", "codex",
    "--operations-base64", Buffer.from(JSON.stringify([
      {
        op: "upsert",
        category: "conventions",
        key: "overflow-rule",
        evidence: "explicit",
        text: "This operation exceeds the final entry budget.",
      },
    ]), "utf8").toString("base64"),
  ], { cwd: repo });
  assert.notEqual(overflow.status, 0);
  assert.match(overflow.stderr, /20 entries/i);
  assert.equal(readFileSync(target, "utf8"), beforeOverflow);
});

test("reconcile-batch rejects weak deletion evidence without changing guidance", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  const applied = run([
    "apply", "--cwd", repo, "--host", "codex", "--category", "pitfalls",
    "--key", "redis-required", "--evidence", "verified", "--text", "Start Redis before integration tests.",
  ], { cwd: repo });
  assert.equal(applied.status, 0, applied.stderr);
  const before = readFileSync(target, "utf8");

  const result = run([
    "reconcile-batch", "--cwd", repo, "--host", "codex",
    "--operations-base64", Buffer.from(JSON.stringify([
      { op: "remove", key: "redis-required", evidence: "repeated" },
    ]), "utf8").toString("base64"),
  ], { cwd: repo });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /remove evidence must be explicit or verified/i);
  assert.equal(readFileSync(target, "utf8"), before);
});

test("managed guidance is capped at 20 entries and replacements remain possible", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  for (let index = 0; index < 20; index += 1) {
    const result = run([
      "apply", "--cwd", repo, "--host", "codex", "--category", "conventions",
      "--key", `rule-${index}`, "--evidence", "repeated", "--text", `Keep durable rule number ${index}.`,
    ], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
  }
  const full = readFileSync(target, "utf8");

  const overflow = run([
    "apply", "--cwd", repo, "--host", "codex", "--category", "conventions",
    "--key", "rule-overflow", "--evidence", "repeated", "--text", "This rule exceeds the entry budget.",
  ], { cwd: repo });
  assert.notEqual(overflow.status, 0);
  assert.match(overflow.stderr, /20 entries/i);
  assert.equal(readFileSync(target, "utf8"), full);

  const replacement = run([
    "apply", "--cwd", repo, "--host", "codex", "--category", "conventions",
    "--key", "rule-0", "--evidence", "explicit", "--text", "Replace durable rule number zero.",
  ], { cwd: repo });
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.match(readFileSync(target, "utf8"), /Replace durable rule number zero/);
});

test("managed guidance enforces text and total byte budgets", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);

  const tooLong = run([
    "apply", "--cwd", repo, "--host", "codex", "--category", "conventions",
    "--key", "too-long", "--evidence", "explicit", "--text", `Keep ${"x".repeat(240)}`,
  ], { cwd: repo });
  assert.notEqual(tooLong.status, 0);
  assert.match(tooLong.stderr, /240 character/i);

  let failed = false;
  for (let index = 0; index < 20; index += 1) {
    const before = readFileSync(target, "utf8");
    const result = run([
      "apply", "--cwd", repo, "--host", "codex", "--category", "pitfalls",
      "--key", `large-${index}`, "--evidence", "repeated", "--text", `Pitfall ${index}: ${"y".repeat(210)}`,
    ], { cwd: repo });
    if (result.status !== 0) {
      assert.match(result.stderr, /4096 byte/i);
      assert.equal(readFileSync(target, "utf8"), before);
      failed = true;
      break;
    }
  }
  assert.equal(failed, true, "the 4 KiB managed block limit must be reached before 20 large entries");
});

test("unknown options fail before any command mutates files", () => {
  const { repo } = fixture();
  for (const command of ["enable", "status", "disable", "repair", "apply", "apply-batch", "reconcile-batch", "remove"]) {
    const before = existsSync(join(repo, "AGENTS.md")) ? readFileSync(join(repo, "AGENTS.md"), "utf8") : null;
    const result = run([command, "--cwd", repo, "--host", "codex", "--bogus", "value"], { cwd: repo });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /unknown option.*bogus/i, command);
    const after = existsSync(join(repo, "AGENTS.md")) ? readFileSync(join(repo, "AGENTS.md"), "utf8") : null;
    assert.equal(after, before, command);
  }

  const help = run(["help"], { cwd: repo });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--target/);
  assert.match(help.stdout, /reconcile-batch/);
  assert.match(help.stdout, /"op":"upsert"/);
  assert.match(help.stdout, /"op":"remove"/);
});

test("base64 guidance input preserves shell metacharacters without evaluation", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  const text = "Run `npm test`; keep $() and 'quotes' literal.";

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "commands", "--key", "shell-safe-command",
    "--evidence", "verified", "--text-base64", Buffer.from(text, "utf8").toString("base64"),
  ], { cwd: repo });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(target, "utf8"), /Run `npm test`; keep \$\(\) and 'quotes' literal\./);
});

test("secret-like guidance is rejected without changing the file", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  const before = readFileSync(target, "utf8");
  const secrets = [
    "API_TOKEN=EXAMPLE_SECRET_VALUE_12345",
    `github_pat_${"A".repeat(82)}`,
    `Authorization: Bearer ${"b".repeat(32)}`,
    `AWS_SECRET_ACCESS_KEY=${"D".repeat(40)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
  ];

  for (const [index, text] of secrets.entries()) {
    const result = run([
      "apply", "--cwd", repo, "--host", "codex",
      "--category", "pitfalls", "--key", `secret-${index}`,
      "--evidence", "explicit", "--text", text,
    ], { cwd: repo });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secret/i);
    assert.equal(readFileSync(target, "utf8"), before);
  }
});

test("malformed activation or managed markers fail closed", () => {
  const cases = [
    [
      "<!-- maintain-agent-guidance:enabled -->",
      "<!-- maintain-agent-guidance:activation:start -->",
      "missing activation end",
      "<!-- maintain-agent-guidance:start -->",
      "<!-- maintain-agent-guidance:end -->",
    ],
    [
      "<!-- maintain-agent-guidance:enabled -->",
      "<!-- maintain-agent-guidance:start -->",
      "missing managed end",
    ],
  ];

  for (const lines of cases) {
    const { repo } = fixture();
    const target = join(repo, "AGENTS.md");
    const malformed = `${lines.join("\n")}\n`;
    writeFileSync(target, malformed, "utf8");
    const refused = run(["enable", "--cwd", repo, "--host", "codex"], { cwd: repo });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /broken.*repair/i);
    assert.equal(readFileSync(target, "utf8"), malformed);

    const repairResult = run(["repair", "--cwd", repo, "--host", "codex"], { cwd: repo });
    assert.notEqual(repairResult.status, 0);
    assert.match(repairResult.stderr, /marker/i);
    assert.equal(readFileSync(target, "utf8"), malformed);
  }
});

test("concurrent updates serialize without losing entries", async () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runAsync([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", `fixture-rule-${index}`,
    "--evidence", "repeated", "--text", `Use fixture convention number ${index}.`,
  ], { cwd: repo })));

  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(target, "utf8");
  assert.equal((content.match(/mag:key=fixture-rule-/g) ?? []).length, 8);
});

test("a contender waits for a slow lock handoff", async () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  const lock = `${target}.maintain-agent-guidance.lock`;
  writeFileSync(lock, "active", "utf8");

  const pending = runAsync([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "slow-lock-handoff",
    "--evidence", "verified", "--text", "Wait for a slow lock owner before writing.",
  ], { cwd: repo });
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  rmSync(lock, { force: true });
  const result = await pending;

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(target, "utf8"), /Wait for a slow lock owner before writing/);
});

test("stale locks fail closed without changing guidance", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo);
  const before = readFileSync(target, "utf8");
  const lock = `${target}.maintain-agent-guidance.lock`;
  writeFileSync(lock, "stale", "utf8");
  const staleTime = new Date(Date.now() - 60_000);
  utimesSync(lock, staleTime, staleTime);

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "stale-lock-diagnostic",
    "--evidence", "verified", "--text", "Report stale updater locks safely.",
  ], { cwd: repo });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale lock/i);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(existsSync(lock), true);
});

test("UTF-8 BOM and CRLF line endings survive enable and apply", () => {
  const { repo } = fixture();
  const target = join(repo, "AGENTS.md");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(target, Buffer.concat([bom, Buffer.from("# Human\r\n\r\nKeep this.\r\n", "utf8")]));
  enable(repo);

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "pitfalls", "--key", "redis-required",
    "--evidence", "verified", "--text", "Start Redis before integration tests.",
  ], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);

  const final = readFileSync(target);
  assert.deepEqual([...final.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = final.subarray(3).toString("utf8");
  assert.doesNotMatch(text, /(?<!\r)\n/u);
  assert.ok(text.startsWith("<!-- maintain-agent-guidance:enabled -->"));
  assert.match(text, /top-level user task/);
  assert.match(text, /Keep this/);
});
