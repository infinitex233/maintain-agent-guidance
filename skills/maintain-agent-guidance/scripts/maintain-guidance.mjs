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
import { basename, dirname, join, parse, resolve } from "node:path";

const ENABLED_MARKER = "<!-- maintain-agent-guidance:enabled -->";
const ACTIVATION_START_MARKER = "<!-- maintain-agent-guidance:activation:start -->";
const ACTIVATION_END_MARKER = "<!-- maintain-agent-guidance:activation:end -->";
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
const MAX_GUIDANCE_LENGTH = 240;
const MAX_GUIDANCE_ITEMS = 20;
const MAX_MANAGED_BYTES = 4096;
const MAX_BATCH_ITEMS = 2;

const COMMAND_OPTIONS = new Map([
  ["enable", new Set(["cwd", "host", "help"])],
  ["repair", new Set(["cwd", "host", "help"])],
  ["disable", new Set(["cwd", "host", "help"])],
  ["status", new Set(["cwd", "host", "help"])],
  ["apply", new Set(["cwd", "host", "category", "key", "evidence", "text", "text-base64", "help"])],
  ["apply-batch", new Set(["cwd", "host", "items-base64", "help"])],
  ["reconcile-batch", new Set(["cwd", "host", "operations-base64", "help"])],
  ["remove", new Set(["cwd", "host", "key", "help"])],
  ["help", new Set(["help"])],
]);

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
    if (Object.hasOwn(options, name)) fail(`Duplicate option: --${name}`);
    if (name === "help") {
      options[name] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Option --${name} requires a value.`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function validateOptions(command, options) {
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) fail(`Unknown command: ${command}`);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`Unknown option for ${command}: --${name}`);
  }
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

function validateMarkers(content) {
  const starts = countOf(content, START_MARKER);
  const ends = countOf(content, END_MARKER);
  const enabled = countOf(content, ENABLED_MARKER);
  const activationStarts = countOf(content, ACTIVATION_START_MARKER);
  const activationEnds = countOf(content, ACTIVATION_END_MARKER);
  if (starts !== ends || starts > 1) {
    fail("Managed guidance markers are malformed; refusing to edit the file.");
  }
  if (enabled > 1 || activationStarts > 1 || activationEnds > 1 || activationStarts !== activationEnds) {
    fail("Activation markers are malformed; refusing to edit the file.");
  }
  if (starts === 1 && content.indexOf(START_MARKER) > content.indexOf(END_MARKER)) {
    fail("Managed guidance markers are out of order; refusing to edit the file.");
  }
  if (activationStarts === 1 && content.indexOf(ACTIVATION_START_MARKER) > content.indexOf(ACTIVATION_END_MARKER)) {
    fail("Activation markers are out of order; refusing to edit the file.");
  }
}

function findProjectRoot(cwd) {
  const start = resolve(cwd || process.cwd());
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    fail(`Working directory does not exist or is not a directory: ${start}`);
  }
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current || parse(current).root === current) return start;
    current = parent;
  }
}

function requireHost(options = {}) {
  if (!options.host) fail("Option --host is required; use codex or claude.");
  const host = String(options.host).toLowerCase();
  if (host !== "codex" && host !== "claude") fail(`Unsupported host: ${options.host}`);
  return host;
}

function targetPath(root, host) {
  return join(root, host === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

function shadowingFile(root, host) {
  if (host !== "codex") return null;
  const override = join(root, "AGENTS.override.md");
  if (!existsSync(override) || readText(override).text.trim().length === 0) return null;
  return override;
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
    closeSync(handle);
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

function activationBlock(eol, host) {
  const invocation = host === "claude" ? "/maintain-agent-guidance" : "$maintain-agent-guidance";
  return [
    ACTIVATION_START_MARKER,
    `> Before the final user-facing response for each top-level user task, invoke \`${invocation}\` exactly once. Subagents and delegated tasks must skip this pass. First inspect the current task for new durable repository guidance. If none qualifies, stop with zero tool calls and no file changes. Do not rerun project verification solely for this pass.`,
    ACTIVATION_END_MARKER,
  ].join(eol);
}

function removeSegment(content, eol, startMarker, endMarker) {
  let start = content.indexOf(startMarker);
  if (start < 0) return content;
  let end = content.indexOf(endMarker, start) + endMarker.length;
  if (content.slice(end, end + eol.length) === eol) end += eol.length;
  else if (start >= eol.length && content.slice(start - eol.length, start) === eol) start -= eol.length;
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function removeMarkerLine(content, eol, marker) {
  let start = content.indexOf(marker);
  if (start < 0) return content;
  let end = start + marker.length;
  if (content.slice(end, end + eol.length) === eol) end += eol.length;
  else if (start >= eol.length && content.slice(start - eol.length, start) === eol) start -= eol.length;
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function stripOwnedControl(content, eol, { managed = false } = {}) {
  let next = removeSegment(content, eol, ACTIVATION_START_MARKER, ACTIVATION_END_MARKER);
  if (managed) next = removeSegment(next, eol, START_MARKER, END_MARKER);
  next = removeMarkerLine(next, eol, ENABLED_MARKER);
  return next.replace(/^(?:\r?\n)+/u, "");
}

function enableContent(content, eol, host) {
  validateMarkers(content);
  const items = parseManaged(content);
  assertManagedLimits(items, eol);
  const body = stripOwnedControl(content, eol, { managed: true });
  const control = [ENABLED_MARKER, activationBlock(eol, host), renderManaged(items, eol)].join(eol);
  return body.length > 0 ? `${control}${eol}${eol}${body}` : `${control}${eol}`;
}

function disableContent(content, eol) {
  validateMarkers(content);
  return stripOwnedControl(content, eol);
}

function normalizeText(value) {
  const text = String(value || "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length < 4) fail("Guidance text is too short.");
  if (text.length > MAX_GUIDANCE_LENGTH) {
    fail(`Guidance text exceeds the ${MAX_GUIDANCE_LENGTH} character limit.`);
  }
  if (text.includes("<!--") || text.includes("-->")) fail("Guidance text cannot contain HTML comments.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    fail("Guidance text appears to contain a secret or credential.");
  }
  return text;
}

function decodeBase64(encoded, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded || "")) {
    fail(`${label} base64 is invalid.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) fail(`${label} is not valid UTF-8.`);
  return decoded;
}

function guidanceText(options) {
  if (options.text !== undefined && options["text-base64"] !== undefined) {
    fail("Use either --text or --text-base64, not both.");
  }
  if (options["text-base64"] === undefined) return options.text;
  return decodeBase64(options["text-base64"], "Guidance text");
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

function itemCount(items) {
  let count = 0;
  for (const entries of items.values()) count += entries.length;
  return count;
}

function assertManagedLimits(items, eol) {
  const count = itemCount(items);
  if (count > MAX_GUIDANCE_ITEMS) {
    fail(`Managed guidance cannot exceed ${MAX_GUIDANCE_ITEMS} entries.`);
  }
  for (const entries of items.values()) {
    for (const entry of entries) {
      if (entry.text.length > MAX_GUIDANCE_LENGTH) {
        fail(`Managed guidance contains an item over ${MAX_GUIDANCE_LENGTH} characters.`);
      }
    }
  }
  const bytes = Buffer.byteLength(renderManaged(items, eol), "utf8");
  if (bytes > MAX_MANAGED_BYTES) {
    fail(`Managed guidance cannot exceed ${MAX_MANAGED_BYTES} bytes.`);
  }
}

function replaceManaged(content, rendered) {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER) + END_MARKER.length;
  if (start < 0 || end < END_MARKER.length) fail("Managed guidance block is missing.");
  return `${content.slice(0, start)}${rendered}${content.slice(end)}`;
}

function upsertItems(items, candidate) {
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
    return { changed: false, key: duplicate.key };
  }
  if (existingLocation) {
    const old = items.get(existingLocation.category)[existingLocation.index];
    if (existingLocation.category === candidate.category && old.text === candidate.text) {
      return { changed: false, key: candidate.key };
    }
    items.get(existingLocation.category).splice(existingLocation.index, 1);
  }
  items.get(candidate.category).push({ key: candidate.key, text: candidate.text });
  return { changed: true, key: candidate.key };
}

function removeItem(items, key) {
  for (const entries of items.values()) {
    const index = entries.findIndex((entry) => entry.key === key);
    if (index >= 0) {
      entries.splice(index, 1);
      return { changed: true, key };
    }
  }
  return { changed: false, key };
}

function updateManaged(content, eol, candidate) {
  const items = parseManaged(content);
  const result = upsertItems(items, candidate);
  if (!result.changed) return { content, ...result };
  assertManagedLimits(items, eol);
  const rendered = renderManaged(items, eol);
  return {
    content: replaceManaged(content, rendered),
    ...result,
  };
}

function removeManaged(content, eol, key) {
  const items = parseManaged(content);
  const result = removeItem(items, key);
  if (!result.changed) return { content, ...result };
  return { content: replaceManaged(content, renderManaged(items, eol)), ...result };
}

function reconcileManaged(content, eol, operations) {
  const items = parseManaged(content);
  const results = operations.map((operation) => {
    if (operation.op === "remove") return { op: "remove", evidence: operation.evidence, ...removeItem(items, operation.key) };
    return { op: "upsert", evidence: operation.evidence, ...upsertItems(items, operation) };
  });
  assertManagedLimits(items, eol);
  if (!results.some((result) => result.changed)) return { content, changed: false, results };
  const next = replaceManaged(content, renderManaged(items, eol));
  return { content: next, changed: next !== content, results };
}

function candidateFromOptions(options) {
  const category = String(options.category || "").toLowerCase();
  if (!CATEGORIES.has(category)) fail("Category must be commands, conventions, or pitfalls.");
  const evidence = String(options.evidence || "").toLowerCase();
  if (!EVIDENCE.has(evidence)) fail("Evidence must be explicit, verified, or repeated.");
  if (category === "commands" && evidence === "repeated") {
    fail("Command evidence must be explicit or verified.");
  }
  const text = normalizeText(guidanceText(options));
  if (!options.key) fail("Option --key is required.");
  const key = normalizeKey(options.key, text);
  return { category, evidence, key, text };
}

function batchCandidates(options) {
  if (!options["items-base64"]) fail("Option --items-base64 is required.");
  let items;
  try {
    items = JSON.parse(decodeBase64(options["items-base64"], "Batch items"));
  } catch (error) {
    if (/base64|UTF-8/u.test(error.message)) throw error;
    fail(`Batch items JSON is invalid: ${error.message}`);
  }
  if (!Array.isArray(items) || items.length === 0) fail("Batch items must be a non-empty array.");
  if (items.length > MAX_BATCH_ITEMS) fail(`Apply at most ${MAX_BATCH_ITEMS} candidates per completion pass.`);
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("Each batch item must be an object.");
    return candidateFromOptions(item);
  });
}

function validateOperationFields(item, allowed, index) {
  for (const name of Object.keys(item)) {
    if (!allowed.has(name)) fail(`Unknown field in reconciliation operation ${index + 1}: ${name}`);
  }
}

function reconciliationOperations(options) {
  if (!options["operations-base64"]) fail("Option --operations-base64 is required.");
  let items;
  try {
    items = JSON.parse(decodeBase64(options["operations-base64"], "Reconciliation operations"));
  } catch (error) {
    if (/base64|UTF-8/u.test(error.message)) throw error;
    fail(`Reconciliation operations JSON is invalid: ${error.message}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    fail("Reconciliation operations must be a non-empty array.");
  }
  if (items.length > MAX_BATCH_ITEMS) {
    fail(`Reconcile at most ${MAX_BATCH_ITEMS} operations per completion pass.`);
  }
  const seenKeys = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("Each reconciliation operation must be an object.");
    }
    const op = String(item.op || "").toLowerCase();
    let operation;
    if (op === "upsert") {
      validateOperationFields(item, new Set(["op", "category", "key", "evidence", "text", "text-base64"]), index);
      operation = { op, ...candidateFromOptions(item) };
    } else if (op === "remove") {
      validateOperationFields(item, new Set(["op", "key", "evidence"]), index);
      if (!item.key) fail("A remove operation requires a key.");
      const evidence = String(item.evidence || "").toLowerCase();
      if (evidence !== "explicit" && evidence !== "verified") {
        fail("Remove evidence must be explicit or verified.");
      }
      operation = { op, key: normalizeKey(item.key, "unused"), evidence };
    } else {
      fail(`Operation ${index + 1} must use op upsert or remove.`);
    }
    if (seenKeys.has(operation.key)) fail(`Duplicate reconciliation key: ${operation.key}`);
    seenKeys.add(operation.key);
    return operation;
  });
}

function commandContext(options) {
  const root = findProjectRoot(options.cwd || process.cwd());
  const host = requireHost(options);
  const target = targetPath(root, host);
  return { root, host, target };
}

function inspectContent(content, eol, host) {
  try {
    validateMarkers(content);
  } catch (error) {
    return { state: "broken", enabled: false, reason: error.message };
  }
  const enabled = countOf(content, ENABLED_MARKER);
  const activationStarts = countOf(content, ACTIVATION_START_MARKER);
  const activationEnds = countOf(content, ACTIVATION_END_MARKER);
  const managedStarts = countOf(content, START_MARKER);
  const managedEnds = countOf(content, END_MARKER);
  if (enabled === 0 && activationStarts === 0 && activationEnds === 0) {
    return { state: "disabled", enabled: false };
  }
  if (enabled !== 1 || activationStarts !== 1 || activationEnds !== 1 || managedStarts !== 1 || managedEnds !== 1) {
    return { state: "broken", enabled: false, reason: "Owned control markers are incomplete." };
  }
  const expectedPrefix = `${ENABLED_MARKER}${eol}${activationBlock(eol, host)}${eol}${START_MARKER}`;
  if (!content.startsWith(expectedPrefix)) {
    return { state: "broken", enabled: false, reason: "Owned control block is not canonical." };
  }
  try {
    const items = parseManaged(content);
    assertManagedLimits(items, eol);
    return {
      state: "active",
      enabled: true,
      entries: itemCount(items),
      managedBytes: Buffer.byteLength(renderManaged(items, eol), "utf8"),
    };
  } catch (error) {
    return { state: "broken", enabled: false, reason: error.message };
  }
}

function inspectContext(context) {
  const shadowedBy = shadowingFile(context.root, context.host);
  if (shadowedBy) return { state: "shadowed", enabled: false, shadowedBy };
  if (!existsSync(context.target)) return { state: "disabled", enabled: false };
  const current = readText(context.target);
  return inspectContent(current.text, current.eol, context.host);
}

function ensureWritableHost(context) {
  const shadowedBy = shadowingFile(context.root, context.host);
  if (shadowedBy) fail(`${context.target} is shadowed by ${shadowedBy}.`);
}

function ensureActiveContent(content, eol, context) {
  const inspection = inspectContent(content, eol, context.host);
  if (inspection.state !== "active") {
    fail(`Guidance maintenance is not active for ${context.target}: ${inspection.state}.`);
  }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function enable(options) {
  const context = commandContext(options);
  ensureWritableHost(context);
  const changed = mutateTextFile(context.target, (content, eol) => {
    const inspection = inspectContent(content, eol, context.host);
    if (inspection.state === "active") return content;
    if (inspection.state !== "disabled") {
      fail(`Cannot enable guidance from ${inspection.state} state; run repair explicitly.`);
    }
    return enableContent(content, eol, context.host);
  });
  output({ ...context, state: "active", enabled: true, changed });
}

function repair(options) {
  const context = commandContext(options);
  ensureWritableHost(context);
  const changed = mutateTextFile(context.target, (content, eol) => {
    const inspection = inspectContent(content, eol, context.host);
    if (inspection.state === "active") return content;
    if (inspection.state !== "broken") {
      fail(`Cannot repair guidance from ${inspection.state} state; run enable for disabled maintenance.`);
    }
    return enableContent(content, eol, context.host);
  });
  output({ ...context, state: "active", enabled: true, changed });
}

function disable(options) {
  const context = commandContext(options);
  if (!existsSync(context.target)) {
    output({ ...context, state: "disabled", enabled: false, changed: false });
    return;
  }
  const changed = mutateTextFile(context.target, disableContent);
  output({ ...context, state: "disabled", enabled: false, changed });
}

function status(options) {
  const context = commandContext(options);
  output({ ...context, ...inspectContext(context) });
}

function apply(options) {
  const context = commandContext(options);
  ensureWritableHost(context);
  const candidate = candidateFromOptions(options);
  let result;
  const changed = mutateTextFile(context.target, (content, eol) => {
    ensureActiveContent(content, eol, context);
    result = updateManaged(content, eol, candidate);
    return result.content;
  });
  output({ ...context, category: candidate.category, evidence: candidate.evidence, key: result.key, changed });
}

function applyBatch(options) {
  const context = commandContext(options);
  ensureWritableHost(context);
  const candidates = batchCandidates(options);
  const results = [];
  const changed = mutateTextFile(context.target, (content, eol) => {
    ensureActiveContent(content, eol, context);
    let next = content;
    for (const candidate of candidates) {
      const result = updateManaged(next, eol, candidate);
      results.push({
        category: candidate.category,
        evidence: candidate.evidence,
        key: result.key,
        changed: result.changed,
      });
      next = result.content;
    }
    return next;
  });
  output({ ...context, changed, results });
}

function reconcileBatch(options) {
  const context = commandContext(options);
  ensureWritableHost(context);
  const operations = reconciliationOperations(options);
  let result;
  const changed = mutateTextFile(context.target, (content, eol) => {
    ensureActiveContent(content, eol, context);
    result = reconcileManaged(content, eol, operations);
    return result.content;
  });
  output({ ...context, changed, results: result.results });
}

function remove(options) {
  const context = commandContext(options);
  if (!options.key) fail("Option --key is required.");
  const key = normalizeKey(options.key, "unused");
  if (!existsSync(context.target)) {
    output({ ...context, key, changed: false });
    return;
  }
  let result;
  const changed = mutateTextFile(context.target, (content, eol) => {
    result = removeManaged(content, eol, key);
    return result.content;
  });
  output({ ...context, key, changed });
}

function help() {
  process.stdout.write("maintain-guidance commands:\n\n");
  process.stdout.write("  enable      --host codex|claude [--cwd PATH]\n");
  process.stdout.write("  repair      --host codex|claude [--cwd PATH]\n");
  process.stdout.write("  disable     --host codex|claude [--cwd PATH]\n");
  process.stdout.write("  status      --host codex|claude [--cwd PATH]\n");
  process.stdout.write("  apply       --host HOST --category CATEGORY --key KEY --evidence TYPE (--text TEXT | --text-base64 BASE64)\n");
  process.stdout.write("  apply-batch --host HOST --items-base64 BASE64_JSON [--cwd PATH]\n");
  process.stdout.write("  reconcile-batch --host HOST --operations-base64 BASE64_JSON [--cwd PATH]\n");
  process.stdout.write("  remove      --host HOST --key KEY [--cwd PATH]\n");
  process.stdout.write("\nreconcile-batch JSON operations (maximum 2):\n");
  process.stdout.write('  {"op":"upsert","category":"conventions","key":"stable-key","evidence":"explicit","text":"Durable guidance."}\n');
  process.stdout.write('  {"op":"remove","key":"stable-key","evidence":"explicit"}\n');
}

async function main() {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (!command) return help();
  validateOptions(command, options);
  if (command === "help" || options.help) return help();
  if (command === "enable") return enable(options);
  if (command === "repair") return repair(options);
  if (command === "disable") return disable(options);
  if (command === "status") return status(options);
  if (command === "apply") return apply(options);
  if (command === "apply-batch") return applyBatch(options);
  if (command === "reconcile-batch") return reconcileBatch(options);
  if (command === "remove") return remove(options);
}

main().catch((error) => {
  process.stderr.write(`maintain-agent-guidance: ${error.message}\n`);
  process.exitCode = 1;
});
