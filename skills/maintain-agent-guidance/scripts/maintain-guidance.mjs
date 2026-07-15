#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const ENABLED_MARKER = "<!-- maintain-agent-guidance:enabled -->";
const START_MARKER = "<!-- maintain-agent-guidance:start -->";
const END_MARKER = "<!-- maintain-agent-guidance:end -->";
const BLOCK_TITLE = "## Maintained Agent Guidance";
const CATEGORIES = new Map([
  ["commands", "Commands"],
  ["conventions", "Conventions"],
  ["pitfalls", "Pitfalls"],
]);
const EVIDENCE = new Set(["explicit", "verified", "repeated"]);
const LOCK_RETRY_COUNT = 160;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_STALE_MS = 30_000;
const RENAME_RETRY_COUNT = 20;
const RENAME_RETRY_DELAY_MS = 25;

const DURABLE_PROMPT = /(?:\b(?:always|never|must|remember|prefer|default to|from now on|going forward|do not|don't|avoid)\b|use\s+.+?\s+instead\s+of|以后|始终|总是|永远|必须|务必|不要|禁止|默认|记住|改用|优先|而不是|统一使用)/iu;
const CORRECTION_PROMPT = /(?:\bnot\s+.+?\s+but\s+|\bcorrection\b|不(?:是|要).+而(?:是|要)|下次|以后别|应该改为)/iu;
const DURABLE_ASSISTANT = /(?:only works (?:when|if)|fails unless|root cause (?:was|is)|must be run from|requires .+ before|always use|never use|do not use|只能在|否则会|根因(?:是|在于)|必须从|需要先|注意不要)/iu;
const SECRET_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\s*[:=]\s*["']?[A-Za-z0-9/+=]{16,}/iu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}(?=$|[\s,;:)}\]"'])/iu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*["']?[^\s"']{8,}/iu,
  /https?:\/\/[^/\s:@]+:[^@\s/]+@/iu,
];

function fail(message) {
  throw new Error(message);
}

function parseOptions(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) fail(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }
  return options;
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

function validateMarkers(content) {
  const starts = countOf(content, START_MARKER);
  const ends = countOf(content, END_MARKER);
  const enabled = countOf(content, ENABLED_MARKER);
  if (starts !== ends || starts > 1) {
    fail("Managed guidance markers are malformed; refusing to edit the file.");
  }
  if (enabled > 1) {
    fail("Enable markers are malformed; refusing to edit the file.");
  }
  if (starts === 1 && content.indexOf(START_MARKER) > content.indexOf(END_MARKER)) {
    fail("Managed guidance markers are out of order; refusing to edit the file.");
  }
}

function findProjectRoot(cwd) {
  const start = resolve(cwd || process.cwd());
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || parse(current).root === current) return start;
    current = parent;
  }
}

function detectHost(options = {}, input = {}) {
  const explicit = options.host || process.env.MAG_HOST;
  if (explicit) {
    const host = String(explicit).toLowerCase();
    if (host !== "codex" && host !== "claude") fail(`Unsupported host: ${explicit}`);
    return host;
  }
  if (process.env.PLUGIN_ROOT || process.env.PLUGIN_DATA) return "codex";
  if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (process.env.CODEX_THREAD_ID || input.turn_id || input.model) return "codex";
  const cwd = resolve(options.cwd || input.cwd || process.cwd());
  if (existsSync(join(cwd, "CLAUDE.md")) && !existsSync(join(cwd, "AGENTS.md"))) return "claude";
  return "codex";
}

function targetPath(root, host, options = {}) {
  if (options.target) return resolve(root, options.target);
  return join(root, host === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

function readText(file) {
  if (!existsSync(file)) return { text: "", bom: false, eol: "\n" };
  const buffer = readFileSync(file);
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = buffer.subarray(bom ? 3 : 0).toString("utf8");
  return { text, bom, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renameWithRetry(source, target) {
  for (let attempt = 0; attempt < RENAME_RETRY_COUNT; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!retryable || attempt === RENAME_RETRY_COUNT - 1) throw error;
      sleep(RENAME_RETRY_DELAY_MS);
    }
  }
}

function withLock(file, callback) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.maintain-agent-guidance.lock`;
  let handle;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      handle = openSync(lock, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs >= LOCK_STALE_MS) {
          fail(`Stale lock detected at ${lock}; verify no updater is running, then remove it.`);
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (attempt === LOCK_RETRY_COUNT - 1) throw error;
      sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  if (handle === undefined) fail(`Unable to acquire lock for ${file}.`);
  try {
    return callback();
  } finally {
    if (handle !== undefined) closeSync(handle);
    rmSync(lock, { force: true });
  }
}

function atomicWrite(file, text, bom = false) {
  mkdirSync(dirname(file), { recursive: true });
  const prefix = bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  const payload = Buffer.concat([prefix, Buffer.from(text, "utf8")]);
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const mode = existsSync(file) ? statSync(file).mode : 0o600;
  writeFileSync(temporary, payload, { mode });
  try {
    renameWithRetry(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function mutateTextFile(file, transform) {
  return withLock(file, () => {
    const current = readText(file);
    const next = transform(current.text, current.eol);
    if (next === current.text) return false;
    atomicWrite(file, next, current.bom);
    return true;
  });
}

function emptyBlock(eol) {
  return [START_MARKER, BLOCK_TITLE, END_MARKER].join(eol);
}

function enableContent(content, eol) {
  validateMarkers(content);
  let next = content;
  if (!next.includes(START_MARKER)) {
    const separator = next.length === 0 ? "" : next.endsWith(eol) ? eol : `${eol}${eol}`;
    next = `${next}${separator}${ENABLED_MARKER}${eol}${emptyBlock(eol)}${eol}`;
  } else if (!next.includes(ENABLED_MARKER)) {
    const start = next.indexOf(START_MARKER);
    next = `${next.slice(0, start)}${ENABLED_MARKER}${eol}${next.slice(start)}`;
  }
  return next;
}

function disableContent(content, eol) {
  validateMarkers(content);
  const candidates = [`${ENABLED_MARKER}${eol}`, `${eol}${ENABLED_MARKER}`, ENABLED_MARKER];
  let next = content;
  for (const candidate of candidates) {
    if (next.includes(candidate)) {
      next = next.replace(candidate, candidate === `${eol}${ENABLED_MARKER}` ? "" : "");
      break;
    }
  }
  return next;
}

function isEnabled(file) {
  const { text } = readText(file);
  validateMarkers(text);
  return text.includes(ENABLED_MARKER);
}

function normalizeText(value) {
  const text = String(value || "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length < 4) fail("Guidance text is too short.");
  if (text.length > 500) fail("Guidance text exceeds the 500 character limit.");
  if (text.includes("<!--") || text.includes("-->")) fail("Guidance text cannot contain HTML comments.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("Guidance text appears to contain a secret or credential.");
  }
  return text;
}

function guidanceText(options) {
  if (options["text-base64"] === undefined) return options.text;
  const encoded = options["text-base64"];
  if (encoded === true || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    fail("Guidance text base64 is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) fail("Guidance text is not valid UTF-8.");
  return decoded;
}

function normalizeKey(value, text) {
  const source = value || `item-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  const key = String(source)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!key) fail("Guidance key must contain letters or digits.");
  return key;
}

function canonical(value) {
  return value.toLowerCase().replace(/[`*_.,;:!?]/g, "").replace(/\s+/g, " ").trim();
}

function parseManaged(content) {
  validateMarkers(content);
  const items = new Map([...CATEGORIES.keys()].map((category) => [category, []]));
  if (!content.includes(START_MARKER)) return items;
  const body = content.slice(
    content.indexOf(START_MARKER) + START_MARKER.length,
    content.indexOf(END_MARKER),
  );
  let category = null;
  const seenKeys = new Set();
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = /^###\s+(Commands|Conventions|Pitfalls)$/iu.exec(line);
    if (heading) {
      category = heading[1].toLowerCase();
      continue;
    }
    if (!line.startsWith("- ")) continue;
    if (!category) fail("A managed guidance bullet appears outside a known category.");
    const match = /^-\s+(.+?)(?:\s+<!--\s*mag:key=([a-z0-9][a-z0-9-]{0,63})\s*-->)?$/iu.exec(line);
    if (!match) fail("A managed guidance bullet has an invalid format.");
    const text = match[1].trim();
    const key = match[2] || normalizeKey(null, text);
    if (seenKeys.has(key)) fail(`Duplicate managed guidance key: ${key}`);
    seenKeys.add(key);
    items.get(category).push({ key, text });
  }
  return items;
}

function renderManaged(items, eol) {
  const lines = [START_MARKER, BLOCK_TITLE];
  for (const [category, heading] of CATEGORIES) {
    const entries = items.get(category);
    if (!entries || entries.length === 0) continue;
    lines.push("", `### ${heading}`);
    for (const entry of entries) {
      lines.push(`- ${entry.text} <!-- mag:key=${entry.key} -->`);
    }
  }
  lines.push(END_MARKER);
  return lines.join(eol);
}

function updateManaged(content, eol, candidate) {
  const items = parseManaged(content);
  let existingLocation = null;
  let duplicate = null;
  for (const [category, entries] of items) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.key === candidate.key) existingLocation = { category, index };
      if (canonical(entry.text) === canonical(candidate.text)) duplicate = entry;
    }
  }
  if (duplicate && duplicate.key !== candidate.key) {
    return { content, changed: false, key: duplicate.key };
  }
  if (existingLocation) {
    const old = items.get(existingLocation.category)[existingLocation.index];
    if (existingLocation.category === candidate.category && old.text === candidate.text) {
      return { content, changed: false, key: candidate.key };
    }
    items.get(existingLocation.category).splice(existingLocation.index, 1);
  }
  items.get(candidate.category).push({ key: candidate.key, text: candidate.text });
  const rendered = renderManaged(items, eol);
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER) + END_MARKER.length;
  if (start < 0 || end < END_MARKER.length) fail("Managed guidance block is missing.");
  return {
    content: `${content.slice(0, start)}${rendered}${content.slice(end)}`,
    changed: true,
    key: candidate.key,
  };
}

function dataDirectory(options = {}) {
  return resolve(
    options["data-dir"]
      || process.env.MAG_DATA_DIR
      || process.env.PLUGIN_DATA
      || process.env.CLAUDE_PLUGIN_DATA
      || join(homedir(), ".maintain-agent-guidance"),
  );
}

function stateFile(root, host, options = {}) {
  const id = createHash("sha256").update(`${host}\0${resolve(root).toLowerCase()}`).digest("hex");
  return join(dataDirectory(options), "repos", `${id}.json`);
}

function readState(file) {
  if (!existsSync(file)) return { schemaVersion: 1 };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { schemaVersion: 1 };
  }
}

function writeState(file, state) {
  withLock(file, () => atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`));
}

function promptCandidate(prompt) {
  return DURABLE_PROMPT.test(prompt || "") || CORRECTION_PROMPT.test(prompt || "");
}

function assistantCandidate(message) {
  return DURABLE_ASSISTANT.test(message || "");
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    fail("Hook input is not valid JSON.");
  }
}

function commandContext(options, input = {}) {
  const root = findProjectRoot(options.cwd || input.cwd || process.cwd());
  const host = detectHost(options, input);
  const target = targetPath(root, host, options);
  return { root, host, target };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function enable(options) {
  const context = commandContext(options);
  const changed = mutateTextFile(context.target, enableContent);
  output({ ...context, enabled: true, changed });
}

function disable(options) {
  const context = commandContext(options);
  if (!existsSync(context.target)) {
    output({ ...context, enabled: false, changed: false });
    return;
  }
  const changed = mutateTextFile(context.target, disableContent);
  output({ ...context, enabled: false, changed });
}

function status(options) {
  const context = commandContext(options);
  output({ ...context, enabled: existsSync(context.target) && isEnabled(context.target) });
}

function apply(options) {
  const context = commandContext(options);
  if (!existsSync(context.target) || !isEnabled(context.target)) {
    fail(`Guidance maintenance is not enabled for ${context.target}.`);
  }
  const category = String(options.category || "").toLowerCase();
  if (!CATEGORIES.has(category)) fail("Category must be commands, conventions, or pitfalls.");
  const evidence = String(options.evidence || "").toLowerCase();
  if (!EVIDENCE.has(evidence)) fail("Evidence must be explicit, verified, or repeated.");
  const text = normalizeText(guidanceText(options));
  const key = normalizeKey(options.key, text);
  let result;
  const changed = mutateTextFile(context.target, (content, eol) => {
    result = updateManaged(content, eol, { category, evidence, key, text });
    return result.content;
  });
  output({ ...context, category, evidence, key: result.key, changed });
}

async function hook(options) {
  const input = await readStdinJson();
  const context = commandContext(options, input);
  if (!existsSync(context.target) || !isEnabled(context.target)) return;

  const file = stateFile(context.root, context.host, options);
  const state = readState(file);
  const event = input.hook_event_name;
  const eventTurnId = input.turn_id || input.prompt_id;
  const synthesizedTurnId = !eventTurnId && event === "UserPromptSubmit";
  let turnId = eventTurnId;
  if (synthesizedTurnId) {
    const previousSequence = Number.isSafeInteger(state.turnSequence) ? state.turnSequence : 0;
    state.turnSequence = previousSequence + 1;
    turnId = `${input.session_id || "unknown"}:turn-${state.turnSequence}`;
  }
  turnId ||= state.currentTurnId || input.session_id || "unknown";

  if (event === "UserPromptSubmit") {
    const candidate = promptCandidate(input.prompt);
    if (!candidate) {
      let changed = false;
      if (synthesizedTurnId) {
        state.currentTurnId = turnId;
        changed = true;
      }
      if (state.pendingTurnId && state.pendingTurnId !== turnId) {
        delete state.pendingTurnId;
        delete state.pendingCandidate;
        delete state.promptHash;
        changed = true;
      }
      if (changed) writeState(file, state);
      return;
    }
    state.currentTurnId = turnId;
    state.pendingTurnId = turnId;
    state.pendingCandidate = true;
    state.promptHash = createHash("sha256").update(String(input.prompt || "")).digest("hex");
    writeState(file, state);
    return;
  }

  if (event !== "Stop") return;
  if (input.stop_hook_active) {
    delete state.pendingTurnId;
    delete state.pendingCandidate;
    delete state.promptHash;
    state.lastProcessedTurnId = turnId;
    writeState(file, state);
    return;
  }
  const hasBackgroundWork = Array.isArray(input.background_tasks)
    && input.background_tasks.some((task) => !["completed", "failed", "cancelled"].includes(task.status));
  if (hasBackgroundWork) return;
  if (state.lastAttemptedTurnId === turnId) return;

  const pendingMatches = state.pendingCandidate
    && (!state.pendingTurnId || state.pendingTurnId === turnId);
  const candidate = process.env.MAG_FORCE_CANDIDATE === "1"
    || pendingMatches
    || assistantCandidate(input.last_assistant_message);
  if (!candidate) return;

  state.lastAttemptedTurnId = turnId;
  writeState(file, state);
  output({
    decision: "block",
    reason: "Use the maintain-agent-guidance skill now for this completed turn. The repository is already enabled. Persist only durable, verified guidance; make no change when there is none. Do not repeat the user's answer or rerun project verification.",
  });
}

function help() {
  process.stdout.write(`maintain-guidance commands:\n\n`);
  process.stdout.write(`  enable  --host codex|claude [--cwd PATH] [--target PATH]\n`);
  process.stdout.write(`  disable --host codex|claude [--cwd PATH] [--target PATH]\n`);
  process.stdout.write(`  status  --host codex|claude [--cwd PATH] [--target PATH]\n`);
  process.stdout.write(`  apply   --host HOST --category CATEGORY --key KEY --evidence TYPE (--text TEXT | --text-base64 BASE64)\n`);
  process.stdout.write(`  hook    # reads lifecycle JSON from stdin\n`);
}

async function main() {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (!command || command === "help" || options.help) return help();
  if (command === "enable") return enable(options);
  if (command === "disable") return disable(options);
  if (command === "status") return status(options);
  if (command === "apply") return apply(options);
  if (command === "hook") return hook(options);
  fail(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`maintain-agent-guidance: ${error.message}\n`);
  process.exitCode = 1;
});
