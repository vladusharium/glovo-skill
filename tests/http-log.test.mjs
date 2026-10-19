import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlovoClient } from "../src/glovo/api.mjs";
import { saveSession } from "../src/auth/store.mjs";
import { createHttpLog } from "../src/glovo/http-log.mjs";

function jwt(exp, salt) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, salt })).toString("base64url");
  return `${header}.${payload}.signature${salt}`;
}

function day(offset, base) {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const root = mkdtempSync(path.join(os.tmpdir(), "glovo-http-log-"));
const logDir = path.join(root, "logs");
const sessionFile = path.join(root, "session.json");
const originalFetch = globalThis.fetch;
const now = new Date(2026, 9, 19, 12, 0, 0).getTime();

const oldAccess = jwt(Math.floor(Date.now() / 1000) - 60, "old");
const newAccess = jwt(Math.floor(Date.now() / 1000) + 3600, "new");
const oldRefresh = "opaque-refresh-token-old-123";
const newRefresh = "opaque-refresh-token-new-456";

try {
  mkdirSync(logDir, { recursive: true });
  for (const offset of [-5, -3, -2, -1]) writeFileSync(path.join(logDir, `glovo-http-${day(offset, now)}.log`), "{}\n");
  writeFileSync(path.join(logDir, "unrelated.txt"), "keep");

  saveSession(sessionFile, {
    accessToken: oldAccess,
    refreshToken: oldRefresh,
    customerId: 123,
    location: { cityCode: "BSK", countryCode: "KG", latitude: "0", longitude: "0" },
  });
  const httpLog = createHttpLog({ dir: logDir, retentionDays: 3, now: () => now });
  const client = new GlovoClient(sessionFile, { httpLog }).reload();

  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/oauth/refresh")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json", "set-cookie": "sid=cookie-secret" }),
        text: async () => JSON.stringify({ access: { accessToken: newAccess, refreshToken: newRefresh, expiresIn: 3600 } }),
      };
    }
    assert.equal(options.headers.Authorization, newAccess);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json", server: "cart-api" }),
      text: async () => JSON.stringify({ basketId: "b-1", products: [], note: `echo Bearer ${newAccess}` }),
    };
  };

  await client.call("/v2/baskets/b-1?access_token=query-secret&storeAddressId=2", { method: "PUT", auth: true, body: { basketId: "b-1", products: [], idToken: "body-secret" } });

  const files = readdirSync(logDir).sort();
  assert.deepEqual(files, [`glovo-http-${day(-2, now)}.log`, `glovo-http-${day(-1, now)}.log`, `glovo-http-${day(0, now)}.log`, "unrelated.txt"]);

  const text = readFileSync(path.join(logDir, `glovo-http-${day(0, now)}.log`), "utf8");
  for (const secret of [oldAccess, newAccess, oldRefresh, newRefresh, "cookie-secret", "query-secret", "body-secret", "signatureold", "signaturenew"]) {
    assert.equal(text.includes(secret), false, `log leaked ${secret.slice(0, 12)}`);
  }
  const entries = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  const [refresh, put] = entries;
  assert.equal(refresh.method, "POST");
  assert.match(refresh.url, /\/oauth\/refresh$/);
  assert.equal(refresh.request.body.refreshToken, "[redacted]");
  assert.equal(refresh.response.status, 200);
  assert.equal(refresh.response.body.access.accessToken, "[redacted]");
  assert.equal(refresh.response.headers["set-cookie"], "[redacted]");
  assert.equal(put.method, "PUT");
  assert.match(put.url, /access_token=%5Bredacted%5D&storeAddressId=2$/);
  assert.equal(put.request.headers.Authorization, "[redacted]");
  assert.ok(put.request.headers["Glovo-Request-Id"]);
  assert.deepEqual(put.request.body, { basketId: "b-1", products: [], idToken: "[redacted]" });
  assert.equal(put.response.status, 200);
  assert.equal(put.response.headers.server, "cart-api");
  assert.equal(put.response.body.note, "echo Bearer [redacted]");
  assert.equal(typeof put.duration_ms, "number");
  assert.equal(put.ts, new Date(now).toISOString());

  // Network failures are logged too, and the original error still reaches the caller.
  globalThis.fetch = async () => {
    throw new Error(`connect ECONNREFUSED while sending ${newAccess}`);
  };
  await assert.rejects(() => client.call("/v3/stores/1"), /ECONNREFUSED/);
  const failure = JSON.parse(readFileSync(path.join(logDir, `glovo-http-${day(0, now)}.log`), "utf8").trim().split("\n").at(-1));
  assert.equal(failure.response, undefined);
  assert.equal(failure.error, "connect ECONNREFUSED while sending [redacted]");

  // Large bodies are truncated, never dropped silently.
  const small = createHttpLog({ dir: logDir, maxBodyChars: 32, now: () => now });
  small.record({ method: "GET", url: "https://api.glovoapp.com/x", requestHeaders: {}, status: 200, responseHeaders: {}, responseBody: JSON.stringify({ text: "x".repeat(200) }), durationMs: 1 });
  const truncated = JSON.parse(readFileSync(path.join(logDir, `glovo-http-${day(0, now)}.log`), "utf8").trim().split("\n").at(-1));
  assert.equal(truncated.response.body.truncated, true);
  assert.equal(truncated.response.body.head.length, 32);

  // A broken log directory never breaks requests.
  const blocked = path.join(root, "blocked");
  writeFileSync(blocked, "not a directory");
  createHttpLog({ dir: blocked }).record({ method: "GET", url: "https://api.glovoapp.com/x", requestHeaders: {} });
  assert.equal(existsSync(path.join(blocked, "glovo-http")), false);
} finally {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}

console.log("http-log.test: requests/responses logged daily with 3-day retention and no tokens, cookies, or secret params");
