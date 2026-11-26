import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.ts";

function env(overrides: Record<string, unknown> = {}) {
  let durableRequests = 0;
  const bindings = {
    ASSETS: {fetch: async () => new Response("asset")},
    LAB_SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({fetch: async () => {
        durableRequests += 1;
        return Response.json({ok: true});
      }}),
    },
    ACTION_RATE_LIMITER: {limit: async () => ({success: true})},
    TICK_RATE_LIMITER: {limit: async () => ({success: true})},
    ...overrides,
  };
  return {bindings, durableRequests: () => durableRequests};
}

test("auth reports the Cloudflare Access identity without invoking a lab session", async () => {
  const mock = env();
  const response = await worker.fetch(new Request("https://example.test/api/auth", {
    headers: {"Cf-Access-Authenticated-User-Email": "Student@Example.com"},
  }), mock.bindings as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    authenticated: true,
    email: "student@example.com",
    logout_url: "/cdn-cgi/access/logout",
  });
  assert.equal(mock.durableRequests(), 0);
});

test("action requests return 429 when their identity exceeds the limit", async () => {
  const mock = env({ACTION_RATE_LIMITER: {limit: async () => ({success: false})}});
  const response = await worker.fetch(new Request("https://example.test/api/run", {
    method: "POST",
    headers: {"X-ECU-Session": "12345678-1234-1234-1234-123456789abc"},
    body: "{}",
  }), mock.bindings as never);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(mock.durableRequests(), 0);
});

test("tick requests use the higher-frequency limiter", async () => {
  let actionChecks = 0;
  let tickChecks = 0;
  const mock = env({
    ACTION_RATE_LIMITER: {limit: async () => { actionChecks += 1; return {success: true}; }},
    TICK_RATE_LIMITER: {limit: async () => { tickChecks += 1; return {success: true}; }},
  });
  const response = await worker.fetch(new Request("https://example.test/api/tick", {
    headers: {"X-ECU-Session": "12345678-1234-1234-1234-123456789abc"},
  }), mock.bindings as never);

  assert.equal(response.status, 200);
  assert.equal(tickChecks, 1);
  assert.equal(actionChecks, 0);
  assert.equal(mock.durableRequests(), 1);
});
