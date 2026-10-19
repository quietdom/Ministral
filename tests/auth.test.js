import test, { describe } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import config from "../misc/config.js";
import { setRiotVersionData, getRiotVersionData, fetch } from "../misc/util.js";
import { noteRateLimit } from "../misc/rateLimit.js";
import { initUserDatabase, closeUserDatabase, saveUserToDb, acquireRefreshLock, releaseRefreshLock } from "../misc/userDatabase.js";
import { saveUser, switchAccount } from "../valorant/accountSwitcher.js";
import { getUser, authUser, refreshToken, handleBadClaims, deleteUserAuth } from "../valorant/auth.js";

const jwt = (seconds = 3600) => `x.${Buffer.from(JSON.stringify({ sub: "test-puuid", exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.y`;
const seed = (auth = { rso: jwt(-10), ent: "old-ent", refresh_token: "refresh-1" }) => {
    saveUserToDb({ id: "test-user", currentAccount: 1, settings: {}, accounts: [
        { id: "test-user", puuid: "test-puuid", username: "Test#000", region: "ap", auth, alerts: [] }
    ] });
    return getUser("test-user");
};

// Exercise the real HTTP wrapper and SQLite persistence with a fake Riot server.
// Unexpected requests fail; no real credentials or network are used.
const mockRiot = (t, handler) => {
    const calls = [];
    t.mock.method(https, "request", (url, options, callback) => {
        const request = new EventEmitter();
        let body = "";
        request.write = chunk => { body += chunk; };
        request.destroy = error => { if (error) request.emit("error", error); };
        request.end = () => { queueMicrotask(async () => {
            const call = { url, options, body: new URLSearchParams(body) };
            calls.push(call);
            try {
                const result = await handler(call);
                assert.ok(result, `Unexpected request: ${url}`);
                if (result.error) return request.emit("error", result.error);
                const response = new EventEmitter();
                response.statusCode = result.status ?? 200;
                response.headers = result.headers ?? {};
                callback(response);
                response.emit("data", Buffer.from(typeof result.body === "string" ? result.body : JSON.stringify(result.body)));
                response.emit("end");
            } catch (error) { request.emit("error", error); }
        }); };
        return request;
    });
    return calls;
};

describe("authentication lifecycle", () => {
test.beforeEach(t => {
    const savedConfig = { ...config };
    const savedVersion = getRiotVersionData();
    t.after(() => {
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, savedConfig);
        setRiotVersionData(savedVersion);
    });
    for (const host of ["auth.riotgames.com", "entitlements.auth.riotgames.com"]) {
        noteRateLimit({ statusCode: 429, headers: { "retry-after": "-1" }, body: "" }, host);
    }
    assert.equal(initUserDatabase(":memory:"), true);
    config.autoRefreshTokens = true;
    config.tokenRefreshBufferMinutes = 5;
    config.logUrls = false;
    setRiotVersionData({ riotClientBuild: "test-build" });
});
test.afterEach(() => {
    closeUserDatabase();
    // Remove rate limits without allowing one test to affect the next.
    for (const host of ["auth.riotgames.com", "entitlements.auth.riotgames.com"]) {
        noteRateLimit({ statusCode: 429, headers: { "retry-after": "-1" }, body: "" }, host);
    }
});

test("saving a notice from before refresh cannot restore the old refresh token", async t => {
    const staleUser = seed();
    mockRiot(t, ({ url }) => url.endsWith("/token")
        ? { body: { access_token: jwt(), refresh_token: "refresh-2" } }
        : { body: { entitlements_token: "new-ent" } });
    assert.equal((await refreshToken("test-user")).success, true);
    staleUser.lastNoticeSeen = "new notice";
    saveUser(staleUser);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
    assert.equal(getUser("test-user").lastNoticeSeen, "new notice");
});

test("saving a removed account never overwrites or deletes the account now in its slot", () => {
    const removed = seed();
    saveUserToDb({ id: "test-user", currentAccount: 1, settings: {}, accounts: [
        { ...removed, puuid: "other-puuid", username: "Other#000", auth: { rso: jwt(), ent: "other-ent", refresh_token: "other-refresh" } }
    ] });
    removed.username = "Stale#000";
    saveUser(removed, 1);
    const accounts = getUser("test-user", 1);
    assert.equal(accounts.puuid, "other-puuid");
    assert.equal(accounts.username, "Other#000");
    assert.equal(accounts.auth.refresh_token, "other-refresh");
    assert.ok(!getUser(removed));
});

test("an entitlement outage after BAD_CLAIMS preserves the login", async t => {
    const user = seed({ rso: jwt(), ent: "stale-ent", refresh_token: "refresh-1" });
    mockRiot(t, () => ({ status: 503, body: "Service unavailable" }));
    const result = await handleBadClaims(user);
    assert.equal(result.authFailure, undefined);
    assert.equal(result.networkError, true);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-1");
});

test("rotated credentials are saved before the entitlement request completes", async t => {
    seed();
    let storedDuringEntitlement;
    mockRiot(t, ({ url }) => {
        if (url.endsWith("/token")) return { body: { access_token: jwt(), refresh_token: "refresh-2" } };
        storedDuringEntitlement = getUser("test-user").auth.refresh_token;
        return { status: 503, body: "Service unavailable" };
    });
    const result = await refreshToken("test-user");
    assert.equal(storedDuringEntitlement, "refresh-2");
    assert.equal(result.success, false);
    assert.equal(result.authFailure, undefined);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
    assert.equal(getUser("test-user").auth.ent, undefined);
});

test("a waiting refresh reloads its original account after another shard rotates it", async t => {
    const original = seed();
    const lockKey = `${original.id}:${original.puuid}`;
    acquireRefreshLock(lockKey, "other-shard", 60000);
    const calls = mockRiot(t, () => ({ status: 400, body: { error: "invalid_grant" } }));
    const pending = refreshToken("test-user");
    await new Promise(resolve => setImmediate(resolve));
    seed({ rso: jwt(), ent: "new-ent", refresh_token: "refresh-2" });
    releaseRefreshLock(lockKey, "other-shard");
    assert.equal((await pending).success, true);
    assert.equal(calls.length, 0);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
});

test("stale auth failures cannot erase a newer login", () => {
    const old = seed();
    seed({ rso: jwt(), ent: "new-ent", refresh_token: "refresh-2" });
    deleteUserAuth(old);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
});

test("expired access with missing entitlements refreshes first, then fetches entitlements", async t => {
    seed({ rso: jwt(-10), refresh_token: "refresh-1" });
    const calls = mockRiot(t, ({ url, options, body }) => {
        if (url.endsWith("/token")) {
            assert.equal(body.get("grant_type"), "refresh_token");
            assert.equal(body.get("refresh_token"), "refresh-1");
            return { body: { access_token: jwt(), refresh_token: "refresh-2" } };
        }
        assert.equal(options.headers.Authorization, `Bearer ${getUser("test-user").auth.rso}`);
        return { body: { entitlements_token: "new-ent" } };
    });
    assert.equal((await authUser("test-user")).success, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith("/token"));
    assert.ok(calls[1].url.includes("entitlements.auth"));
});

test("valid access with missing entitlements does not need another refresh", async t => {
    seed({ rso: jwt(), refresh_token: "refresh-2" });
    const calls = mockRiot(t, () => ({ body: { entitlements_token: "recovered-ent" } }));
    assert.equal((await authUser("test-user")).success, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("entitlements.auth"));
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
});

test("concurrent refresh callers use a rotating token only once", async t => {
    seed();
    const calls = mockRiot(t, ({ url }) => url.endsWith("/token")
        ? { body: { access_token: jwt(), refresh_token: "refresh-2" } }
        : { body: { entitlements_token: "new-ent" } });
    const results = await Promise.all(Array.from({ length: 8 }, () => refreshToken("test-user")));
    assert.ok(results.every(result => result.success));
    assert.equal(calls.filter(call => call.url.endsWith("/token")).length, 1);
});

test("refresh errors distinguish outages from an explicit invalid grant", async t => {
    for (const response of [
        { status: 503, body: { error: "invalid_grant" } },
        { status: 401, body: "<html>Blocked</html>" },
        { status: 400, body: { error: "invalid_client" } },
        { status: 200, body: {} },
        { status: 429, headers: { "retry-after": "1" }, body: {} },
        { error: new Error("Simulated connection reset") },
        { status: 400, body: { error: "invalid_grant" } }
    ]) {
        await t.test(`HTTP ${response.status ?? "network"} ${response.body?.error ?? ""}`, async sub => {
            seed();
            noteRateLimit({ statusCode: 429, headers: { "retry-after": "-1" }, body: "" }, "auth.riotgames.com");
            mockRiot(sub, () => response);
            const result = await refreshToken("test-user");
            const invalid = response.status === 400 && response.body?.error === "invalid_grant";
            assert.equal(result.success, false);
            assert.equal(Boolean(result.authFailure), invalid);
            assert.equal(Boolean(getUser("test-user").auth.refresh_token), !invalid);
            if (response.status === 429) assert.ok(result.rateLimit > Date.now());
        });
    }
});

test("entitlements 401 forces access refresh even before its local expiry", async t => {
    const oldAccess = jwt();
    seed({ rso: oldAccess, ent: "old-ent", refresh_token: "refresh-1" });
    const calls = mockRiot(t, ({ url, options }) => {
        if (url.endsWith("/token")) return { body: { access_token: jwt(7200), refresh_token: "refresh-2" } };
        if (options.headers.Authorization === `Bearer ${oldAccess}`) return { status: 401, body: {} };
        return { body: { entitlements_token: "new-ent" } };
    });
    assert.deepEqual(await handleBadClaims(getUser("test-user")), { success: false, retry: true });
    assert.equal(calls.length, 3);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
});

test("a late invalid_grant preserves a login made during the request", async t => {
    seed();
    mockRiot(t, () => {
        seed({ rso: jwt(), ent: "new-login-ent", refresh_token: "new-login-refresh" });
        return { status: 400, body: { error: "invalid_grant" } };
    });
    assert.equal((await refreshToken("test-user")).success, true);
    assert.equal(getUser("test-user").auth.refresh_token, "new-login-refresh");
});

test("a late entitlement response preserves a newer login", async t => {
    const old = seed({ rso: jwt(), ent: "old-ent", refresh_token: "refresh-1" });
    mockRiot(t, () => {
        seed({ rso: jwt(7200), ent: "new-login-ent", refresh_token: "new-login-refresh" });
        return { body: { entitlements_token: "late-ent" } };
    });
    assert.equal((await handleBadClaims(old)).retry, true);
    assert.equal(getUser(old).auth.ent, "new-login-ent");
    assert.equal(getUser(old).auth.refresh_token, "new-login-refresh");
});

test("entitlement repair during rotation cannot cause the replacement refresh token to be lost", async t => {
    const original = seed({ rso: jwt(), ent: "old-ent", refresh_token: "refresh-1" });
    mockRiot(t, async ({ url }) => {
        if (url.endsWith("/token")) {
            assert.equal((await handleBadClaims(original)).retry, true);
            return { body: { access_token: jwt(7200), refresh_token: "refresh-2" } };
        }
        return { body: { entitlements_token: "repaired-ent" } };
    });
    assert.equal((await refreshToken(original.id, null, { force: true })).success, true);
    assert.equal(getUser(original).auth.refresh_token, "refresh-2");
});

test("switching accounts during refresh cannot redirect the refresh to another account", async t => {
    const first = seed();
    saveUserToDb({ id: first.id, currentAccount: 1, settings: {}, accounts: [first,
        { ...first, puuid: "second-puuid", username: "Second#000", auth: { rso: jwt(), ent: "second-ent", refresh_token: "second-refresh" } }
    ] });
    mockRiot(t, ({ url }) => {
        if (url.endsWith("/token")) {
            switchAccount(first.id, 2);
            return { body: { access_token: jwt(), refresh_token: "refresh-2" } };
        }
        return { body: { entitlements_token: "new-ent" } };
    });
    assert.equal((await refreshToken(first.id)).success, true);
    assert.equal(getUser(first).auth.refresh_token, "refresh-2");
    assert.equal(getUser(first.id).auth.refresh_token, "second-refresh");
});

test("timing out on another shard's lease never sends a competing refresh", async t => {
    const user = seed();
    const realNow = Date.now();
    acquireRefreshLock(`${user.id}:${user.puuid}`, "other-shard", 60000);
    let reads = 0;
    t.mock.method(Date, "now", () => realNow + Math.min(reads++ * 5000, 40000));
    const calls = mockRiot(t, () => ({ status: 400, body: { error: "invalid_grant" } }));
    const result = await refreshToken(user.id);
    assert.equal(result.networkError, true);
    assert.equal(calls.length, 0);
    assert.equal(getUser(user).auth.refresh_token, "refresh-1");
});

test("a successful refresh that outlives the lease is still saved", async t => {
    seed();
    const realNow = Date.now();
    let offset = 0;
    t.mock.method(Date, "now", () => realNow + offset);
    mockRiot(t, ({ url }) => {
        if (!url.endsWith("/token")) return { body: { entitlements_token: "new-ent" } };
        offset = 61000; // suspended past the 60s lease during the request
        return { body: { access_token: jwt(7200), refresh_token: "refresh-2" } };
    });
    assert.equal((await refreshToken("test-user")).success, true);
    assert.equal(getUser("test-user").auth.refresh_token, "refresh-2");
});

test("HTTP deadline aborts a stalled authentication request", async t => {
    let destroyed = false;
    t.mock.method(https, "request", () => {
        const request = new EventEmitter();
        request.write = () => {};
        request.end = () => {};
        request.destroy = error => { destroyed = true; request.emit("error", error); };
        return request;
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(fetch("https://auth.riotgames.com/token", { timeoutMs: 10 }), { code: "ETIMEDOUT" });
        assert.equal(destroyed, true);
    } finally { clearTimeout(keepAlive); }
});
});
