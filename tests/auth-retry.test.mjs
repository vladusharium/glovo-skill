import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthError, ForbiddenError, GlovoClient, setSleepForTests, withRetry } from "../src/glovo/api.mjs";
import { saveSession } from "../src/auth/store.mjs";

function jwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "glovo-auth-retry-"));
const file = path.join(dir, "session.json");
const originalFetch = globalThis.fetch;
const initialRefresh = "refresh-0";

function freshClient() {
  saveSession(file, {
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: initialRefresh,
    customerId: 123,
    location: { cityCode: "BSK", countryCode: "KG", latitude: "0", longitude: "0" },
  });
  return new GlovoClient(file).reload();
}

function mockFetch(targetStatuses) {
  const calls = { refresh: 0, target: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/oauth/refresh")) {
      calls.refresh += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: `refresh-${calls.refresh}`, expiresIn: 3600 }),
      };
    }
    const status = targetStatuses[Math.min(calls.target, targetStatuses.length - 1)];
    calls.target += 1;
    return { ok: status < 400, status, text: async () => (status < 400 ? JSON.stringify({ basketId: "b-1" }) : "Forbidden") };
  };
  return calls;
}

try {
  // Persistent 403 on a fresh token: bounded refreshes, then a non-auth error instead of an endless loop.
  let calls = mockFetch([403]);
  await assert.rejects(
    () => freshClient().call("/v2/baskets/b-1", { method: "PUT", auth: true, body: {} }),
    (error) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal(error.status, 403);
      assert.match(error.message, /PUT \/v2\/baskets\/\[basket\] -> 403: Forbidden after 2 token refreshes/);
      assert.doesNotMatch(error.message, /Run glovo_login/);
      return true;
    },
  );
  assert.deepEqual(calls, { refresh: 2, target: 3 });

  // Persistent 401: same bound, but it is reported as an auth problem.
  calls = mockFetch([401]);
  await assert.rejects(
    () => freshClient().call("/v3/me", { auth: true }),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /\(401\) after 2 token refreshes\. Run glovo_login again\./);
      return true;
    },
  );
  assert.deepEqual(calls, { refresh: 2, target: 3 });

  // A single 403 cured by one refresh still succeeds.
  calls = mockFetch([403, 200]);
  assert.deepEqual(await freshClient().call("/v3/me", { auth: true }), { basketId: "b-1" });
  assert.deepEqual(calls, { refresh: 1, target: 2 });

  // Public endpoints never refresh; a 403 there is not a login problem.
  calls = mockFetch([403]);
  await assert.rejects(() => freshClient().call("/v3/stores/1"), ForbiddenError);
  assert.deepEqual(calls, { refresh: 0, target: 1 });

  // Generic retry wrappers do not multiply non-transient auth failures.
  let attempts = 0;
  setSleepForTests(async () => {});
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1;
      throw new ForbiddenError("forbidden");
    }, { maxRetries: 5 }),
    ForbiddenError,
  );
  assert.equal(attempts, 1);
} finally {
  globalThis.fetch = originalFetch;
  setSleepForTests(null);
  rmSync(dir, { recursive: true, force: true });
}

console.log("auth-retry.test: 401/403 refresh loop bounded at 2 refreshes, 403 after refresh is not reported as login failure");
