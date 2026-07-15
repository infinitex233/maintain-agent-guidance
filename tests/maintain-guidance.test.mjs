import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  const data = join(base, "data");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(data, { recursive: true });
  return { base, repo, data };
}

function run(args, { cwd, data, input, extraEnv = {} }) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MAG_DATA_DIR: data, ...extraEnv },
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function runAsync(args, { cwd, data, extraEnv = {} }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, MAG_DATA_DIR: data, ...extraEnv },
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

function enable(repo, data, host = "codex") {
  const result = run(["enable", "--cwd", repo, "--host", host], { cwd: repo, data });
  assert.equal(result.status, 0, result.stderr);
  return result.json;
}

test("a dormant hook exits silently before explicit enablement", () => {
  const { repo, data } = fixture();
  const result = run(["hook"], {
    cwd: repo,
    data,
    input: {
      cwd: repo,
      hook_event_name: "Stop",
      turn_id: "turn-1",
      stop_hook_active: false,
      model: "gpt-test",
      last_assistant_message: "Always use uv.",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("enable and disable preserve human guidance and use the host target", () => {
  const { repo, data } = fixture();
  const codexTarget = join(repo, "AGENTS.md");
  writeFileSync(codexTarget, "# Human guidance\n\n- Keep this line.\n", "utf8");

  const enabled = enable(repo, data, "codex");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.changed, true);
  assert.match(readFileSync(codexTarget, "utf8"), /Keep this line/);
  assert.match(readFileSync(codexTarget, "utf8"), /maintain-agent-guidance:enabled/);

  const claude = enable(repo, data, "claude");
  assert.equal(claude.target, join(repo, "CLAUDE.md"));

  const disabled = run(["disable", "--cwd", repo, "--host", "codex"], { cwd: repo, data });
  assert.equal(disabled.status, 0, disabled.stderr);
  const content = readFileSync(codexTarget, "utf8");
  assert.doesNotMatch(content, /maintain-agent-guidance:enabled/);
  assert.match(content, /maintain-agent-guidance:start/);
  assert.match(content, /Keep this line/);
});

test("Claude plugin variables override an inherited Codex thread id", () => {
  const { repo, data } = fixture();
  const result = run(["status", "--cwd", repo], {
    cwd: repo,
    data,
    extraEnv: {
      PLUGIN_ROOT: "",
      CLAUDE_PLUGIN_ROOT: resolve(repo, "plugin"),
      CODEX_THREAD_ID: "inherited-codex-thread",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.host, "claude");
  assert.equal(result.json.target, join(repo, "CLAUDE.md"));
});

test("candidate prompts request one maintenance continuation and do not persist prompt text", () => {
  const { repo, data } = fixture();
  enable(repo, data);
  const prompt = "From now on, always use uv and never pip in this repository.";

  const submit = run(["hook"], {
    cwd: repo,
    data,
    input: {
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-2",
      prompt,
      model: "gpt-test",
    },
  });
  assert.equal(submit.status, 0, submit.stderr);
  assert.equal(submit.stdout, "");

  const stop = run(["hook"], {
    cwd: repo,
    data,
    input: {
      cwd: repo,
      hook_event_name: "Stop",
      turn_id: "turn-2",
      stop_hook_active: false,
      model: "gpt-test",
      last_assistant_message: "Implemented the requested change.",
    },
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.json.decision, "block");
  assert.match(stop.json.reason, /maintain-agent-guidance skill/);

  const stateFiles = [];
  for (const entry of [join(data, "repos")]) {
    try {
      stateFiles.push(...readdirSync(entry).map((name) => join(entry, name)));
    } catch {}
  }
  assert.ok(stateFiles.length > 0);
  assert.ok(stateFiles.every((file) => !readFileSync(file, "utf8").includes(prompt)));

  const recursiveStop = run(["hook"], {
    cwd: repo,
    data,
    input: {
      cwd: repo,
      hook_event_name: "Stop",
      turn_id: "turn-2",
      stop_hook_active: true,
      model: "gpt-test",
      last_assistant_message: "Guidance maintenance finished.",
    },
  });
  assert.equal(recursiveStop.status, 0, recursiveStop.stderr);
  assert.equal(recursiveStop.stdout, "");
});

test("Claude prompt ids keep maintenance active across multiple turns", () => {
  const { repo, data } = fixture();
  enable(repo, data, "claude");
  const hookEnv = { MAG_HOST: "claude" };

  for (const promptId of ["prompt-1", "prompt-2"]) {
    const submit = run(["hook"], {
      cwd: repo,
      data,
      extraEnv: hookEnv,
      input: {
        cwd: repo,
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        prompt_id: promptId,
        prompt: "Always use uv in this repository.",
      },
    });
    assert.equal(submit.status, 0, submit.stderr);

    const stop = run(["hook"], {
      cwd: repo,
      data,
      extraEnv: hookEnv,
      input: {
        cwd: repo,
        hook_event_name: "Stop",
        session_id: "session-1",
        prompt_id: promptId,
        stop_hook_active: false,
        last_assistant_message: "Implemented the requested change.",
      },
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.json?.decision, "block");

    const recursiveStop = run(["hook"], {
      cwd: repo,
      data,
      extraEnv: hookEnv,
      input: {
        cwd: repo,
        hook_event_name: "Stop",
        session_id: "session-1",
        prompt_id: promptId,
        stop_hook_active: true,
        last_assistant_message: "Guidance maintenance finished.",
      },
    });
    assert.equal(recursiveStop.status, 0, recursiveStop.stderr);
  }
});

test("Claude turns stay distinct when prompt ids are unavailable", () => {
  const { repo, data } = fixture();
  enable(repo, data, "claude");
  const hookEnv = { MAG_HOST: "claude" };

  for (let turn = 0; turn < 2; turn += 1) {
    run(["hook"], {
      cwd: repo,
      data,
      extraEnv: hookEnv,
      input: {
        cwd: repo,
        hook_event_name: "UserPromptSubmit",
        session_id: "legacy-session",
        prompt: "Always use uv in this repository.",
      },
    });
    const stop = run(["hook"], {
      cwd: repo,
      data,
      extraEnv: hookEnv,
      input: {
        cwd: repo,
        hook_event_name: "Stop",
        session_id: "legacy-session",
        stop_hook_active: false,
        last_assistant_message: "Implemented the requested change.",
      },
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(stop.json?.decision, "block");
    run(["hook"], {
      cwd: repo,
      data,
      extraEnv: hookEnv,
      input: {
        cwd: repo,
        hook_event_name: "Stop",
        session_id: "legacy-session",
        stop_hook_active: true,
      },
    });
  }
});

test("a Stop event cannot consume another prompt id's pending candidate", () => {
  const { repo, data } = fixture();
  enable(repo, data, "claude");
  const hookEnv = { MAG_HOST: "claude" };
  run(["hook"], {
    cwd: repo,
    data,
    extraEnv: hookEnv,
    input: {
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt_id: "prompt-1",
      prompt: "Always use uv in this repository.",
    },
  });

  const mismatched = run(["hook"], {
    cwd: repo,
    data,
    extraEnv: hookEnv,
    input: {
      cwd: repo,
      hook_event_name: "Stop",
      session_id: "session-1",
      prompt_id: "prompt-2",
      stop_hook_active: false,
      last_assistant_message: "Implemented the requested change.",
    },
  });

  assert.equal(mismatched.status, 0, mismatched.stderr);
  assert.equal(mismatched.stdout, "");
});

test("ordinary prompts and generic completion summaries stay on the fast no-op path", () => {
  const { repo, data } = fixture();
  enable(repo, data);

  run(["hook"], {
    cwd: repo,
    data,
    input: {
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-3",
      prompt: "What time is it?",
      model: "gpt-test",
    },
  });
  const stop = run(["hook"], {
    cwd: repo,
    data,
    input: {
      cwd: repo,
      hook_event_name: "Stop",
      turn_id: "turn-3",
      stop_hook_active: false,
      model: "gpt-test",
      last_assistant_message: "It is 10:30.",
    },
  });

  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "");
  assert.equal(existsSync(join(data, "repos")), false);
});

test("apply is idempotent and a stable key replaces superseded guidance", () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  writeFileSync(target, "# Human guidance\n\n- Preserve me.\n", "utf8");
  enable(repo, data);

  const addArgs = [
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "python-package-manager",
    "--evidence", "explicit", "--text", "Use `uv` instead of `pip` for Python package management.",
  ];
  const first = run(addArgs, { cwd: repo, data });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.changed, true);
  const firstContent = readFileSync(target, "utf8");
  const firstMtime = statSync(target).mtimeMs;

  const second = run(addArgs, { cwd: repo, data });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.changed, false);
  assert.equal(readFileSync(target, "utf8"), firstContent);
  assert.equal(statSync(target).mtimeMs, firstMtime);

  const replacement = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "python-package-manager",
    "--evidence", "explicit", "--text", "Use Poetry instead of `uv` for Python package management.",
  ], { cwd: repo, data });
  assert.equal(replacement.status, 0, replacement.stderr);
  assert.equal(replacement.json.changed, true);

  const finalContent = readFileSync(target, "utf8");
  assert.match(finalContent, /Preserve me/);
  assert.match(finalContent, /Use Poetry instead/);
  assert.doesNotMatch(finalContent, /Use `uv` instead/);
  assert.equal((finalContent.match(/mag:key=python-package-manager/g) ?? []).length, 1);
});

test("base64 guidance input preserves shell metacharacters without evaluation", () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo, data);
  const text = "Run `npm test`; keep $() and 'quotes' literal.";

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "commands", "--key", "shell-safe-command",
    "--evidence", "verified", "--text-base64", Buffer.from(text, "utf8").toString("base64"),
  ], { cwd: repo, data });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(target, "utf8"), /Run `npm test`; keep \$\(\) and 'quotes' literal\./);
});

test("verified commands are categorized and secrets are rejected without a file change", () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo, data);

  const command = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "commands", "--key", "unit-tests",
    "--evidence", "verified", "--text", "Run `uv run pytest` for the unit test suite.",
  ], { cwd: repo, data });
  assert.equal(command.status, 0, command.stderr);
  assert.match(readFileSync(target, "utf8"), /### Commands/);
  const beforeSecret = readFileSync(target, "utf8");

  const secrets = [
    "API_TOKEN=EXAMPLE_SECRET_VALUE_12345",
    `github_pat_${"A".repeat(82)}`,
    `Authorization: Bearer ${"b".repeat(32)}`,
    `Authorization: Bearer ${"c".repeat(32)},`,
    `AWS_SECRET_ACCESS_KEY=${"D".repeat(40)}`,
    `AWS_SESSION_TOKEN=${"E".repeat(48)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
  ];
  for (const [index, text] of secrets.entries()) {
    const secret = run([
      "apply", "--cwd", repo, "--host", "codex",
      "--category", "pitfalls", "--key", `secret-${index}`,
      "--evidence", "explicit", "--text", text,
    ], { cwd: repo, data });
    assert.notEqual(secret.status, 0);
    assert.match(secret.stderr, /secret/i);
    assert.equal(readFileSync(target, "utf8"), beforeSecret);
  }
});

test("malformed managed markers fail closed without touching the file", () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  const malformed = [
    "# Human guidance",
    "<!-- maintain-agent-guidance:enabled -->",
    "<!-- maintain-agent-guidance:start -->",
    "unterminated block",
    "",
  ].join("\n");
  writeFileSync(target, malformed, "utf8");

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "formatting",
    "--evidence", "explicit", "--text", "Use the repository formatter.",
  ], { cwd: repo, data });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /marker/i);
  assert.equal(readFileSync(target, "utf8"), malformed);
});

test("concurrent updates serialize without losing entries", async () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo, data);

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runAsync([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", `fixture-rule-${index}`,
    "--evidence", "repeated", "--text", `Use fixture convention number ${index}.`,
  ], { cwd: repo, data })));

  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const content = readFileSync(target, "utf8");
  assert.equal((content.match(/mag:key=fixture-rule-/g) ?? []).length, 8);
});

test("a contender waits for a slow lock handoff", async () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo, data);
  const lock = `${target}.maintain-agent-guidance.lock`;
  writeFileSync(lock, "active", "utf8");

  const pending = runAsync([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "slow-lock-handoff",
    "--evidence", "verified", "--text", "Wait for a slow lock owner before writing.",
  ], { cwd: repo, data });
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  rmSync(lock, { force: true });
  const result = await pending;

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(target, "utf8"), /Wait for a slow lock owner before writing/);
});

test("stale locks fail closed without changing guidance", () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  enable(repo, data);
  const before = readFileSync(target, "utf8");
  const lock = `${target}.maintain-agent-guidance.lock`;
  writeFileSync(lock, "stale", "utf8");
  const staleTime = new Date(Date.now() - 60_000);
  utimesSync(lock, staleTime, staleTime);

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "conventions", "--key", "stale-lock-diagnostic",
    "--evidence", "verified", "--text", "Report stale updater locks safely.",
  ], { cwd: repo, data });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale lock/i);
  assert.match(result.stderr, /verify no updater is running/i);
  assert.equal(readFileSync(target, "utf8"), before);
  assert.equal(existsSync(lock), true);
});

test("UTF-8 BOM and CRLF line endings survive managed updates", () => {
  const { repo, data } = fixture();
  const target = join(repo, "AGENTS.md");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(target, Buffer.concat([bom, Buffer.from("# Human\r\n\r\nKeep this.\r\n", "utf8")]));
  enable(repo, data);

  const result = run([
    "apply", "--cwd", repo, "--host", "codex",
    "--category", "pitfalls", "--key", "redis-required",
    "--evidence", "verified", "--text", "Start Redis before integration tests.",
  ], { cwd: repo, data });
  assert.equal(result.status, 0, result.stderr);

  const final = readFileSync(target);
  assert.deepEqual([...final.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = final.subarray(3).toString("utf8");
  assert.doesNotMatch(text, /(?<!\r)\n/u);
  assert.match(text, /Keep this/);
});
