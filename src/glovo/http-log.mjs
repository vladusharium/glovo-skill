import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const FILE_PATTERN = /^glovo-http-(\d{4}-\d{2}-\d{2})\.log$/;
const SECRET_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|session[-_]?key|code[-_]?verifier)/i;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const REDACTED = "[redacted]";

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function redactString(value) {
  return String(value).replace(JWT, REDACTED).replace(BEARER, `Bearer ${REDACTED}`);
}

export function redactSecrets(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (depth > 40) return "[depth]";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) && item != null && item !== "" ? REDACTED : redactSecrets(item, depth + 1)]));
}

export function redactHeaders(headers) {
  const entries = typeof headers?.entries === "function" ? [...headers.entries()] : Object.entries(headers || {});
  return Object.fromEntries(entries.map(([key, value]) => [key, SECRET_KEY.test(key) ? REDACTED : redactString(value)]));
}

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, REDACTED);
    }
    return redactString(url.toString());
  } catch {
    return redactString(raw);
  }
}

export function redactBody(text, maxChars) {
  if (text == null || text === "") return undefined;
  let body;
  try {
    body = redactSecrets(JSON.parse(text));
  } catch {
    body = redactString(text);
  }
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  if (serialized.length <= maxChars) return body;
  return { truncated: true, length: serialized.length, head: serialized.slice(0, maxChars) };
}

// Appends one JSON line per Glovo request/response to <dir>/glovo-http-YYYY-MM-DD.log
// and deletes daily files older than `retentionDays` (today counts as day one).
export function createHttpLog({ dir, retentionDays = 3, maxBodyChars = 128 * 1024, now = Date.now } = {}) {
  if (!dir) throw new Error("HTTP log directory is required.");
  let prunedFor = null;

  const prune = (today) => {
    if (prunedFor === today) return;
    prunedFor = today;
    const cutoff = new Date(`${today}T00:00:00`);
    cutoff.setDate(cutoff.getDate() - (Math.max(1, retentionDays) - 1));
    const oldest = localDate(cutoff.getTime());
    try {
      for (const name of readdirSync(dir)) {
        const match = FILE_PATTERN.exec(name);
        if (match && match[1] < oldest) rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      // A failed cleanup is retried on the next day change; keep writing.
    }
  };

  const write = (entry) => {
    try {
      const ts = now();
      const today = localDate(ts);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
      prune(today);
      const file = path.join(dir, `glovo-http-${today}.log`);
      appendFileSync(file, `${JSON.stringify({ ts: new Date(ts).toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break a Glovo request.
    }
  };

  return {
    dir,
    maxBodyChars,
    write,
    record({ method, url, requestHeaders, requestBody, status, responseHeaders, responseBody, durationMs, error, attempt }) {
      write({
        method,
        url: redactUrl(url),
        ...(attempt ? { attempt } : {}),
        request: {
          headers: redactHeaders(requestHeaders),
          ...(requestBody === undefined ? {} : { body: redactBody(requestBody, maxBodyChars) }),
        },
        ...(status === undefined
          ? {}
          : { response: { status, headers: redactHeaders(responseHeaders), body: redactBody(responseBody, maxBodyChars) } }),
        ...(error ? { error: redactString(error) } : {}),
        duration_ms: durationMs,
      });
    },
  };
}
