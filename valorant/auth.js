import { threadId } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
    fetch,
    safeJson,
    tokenExpiry,
    decodeToken,
    wait,
    getRiotVersionData,
    fetchRiotVersionData
} from "../misc/util.js";
import config from "../misc/config.js";
import { addUser, getAccountWithPuuid, getUserJson } from "./accountSwitcher.js";
import { getUserFromDb, acquireRefreshLock, releaseRefreshLock, updateAccountAuthInDb } from "../misc/userDatabase.js";

export { getAllUserIds as getUserList, getUserIdsWithAlertsOrDailyShop as getAlertUserList } from "../misc/userDatabase.js";

const AUTH_REQUEST_TIMEOUT_MS = 10000;
const refreshBufferMs = () => (config.tokenRefreshBufferMinutes ?? 5) * 60000;
const hasFreshAuth = user => Boolean(user?.auth?.ent && tokenExpiry(user.auth.rso) - Date.now() > refreshBufferMs());
const currentAuthResult = user => hasFreshAuth(getUser(user))
    ? { success: true } : { success: false, networkError: true };

const saveAuth = (user, auth, resetFailures = false) => {
    if (!updateAccountAuthInDb(user, user.auth, auth, resetFailures)) return false;
    user.auth = auth;
    return true;
};

export class User {
    constructor({ id, puuid, auth, alerts = [], username, region, authFailures, lastFetchedData, lastNoticeSeen, lastSawEasterEgg }) {
        this.id = id;
        this.puuid = puuid;
        this.auth = auth;
        this.alerts = alerts || [];
        this.username = username;
        this.region = region;
        this.authFailures = authFailures || 0;
        this.lastFetchedData = lastFetchedData || 0;
        this.lastNoticeSeen = lastNoticeSeen || "";
        this.lastSawEasterEgg = lastSawEasterEgg || 0;
    }
}

export const getUser = (id, account = null) => {
    if (!id) return null;

    if (id instanceof User) {
        const user = id;
        const userJson = getUserFromDb(user.id);
        if (!userJson) return null;

        const userData = userJson.accounts.find(a => a.puuid === user.puuid);
        return userData && new User(userData);
    }

    const userData = getUserJson(id, account);
    return userData ? new User(userData) : null;
};

export const getPuuid = (id, account = null) => {
    const user = getUser(id, account);
    return user ? user.puuid : null;
};

export const authUser = async (id, account = null) => {
    const user = getUser(id, account);
    if (!user || !user.auth || !user.auth.rso) return { success: false };

    const rsoExpiry = tokenExpiry(user.auth.rso);
    const timeRemaining = rsoExpiry - Date.now();
    const minutesRemaining = Math.floor(timeRemaining / 60000);

    if (!config.autoRefreshTokens) {
        if (timeRemaining > 0) {
            if (config.logUrls) console.log(`[authUser] Token valid for ${minutesRemaining} more minutes (${user.username})`);
            return user.auth.ent ? { success: true } : repairEntitlements(user);
        }
        return { success: false };
    }

    const bufferMs = refreshBufferMs();
    if (timeRemaining > bufferMs) {
        if (config.logUrls) console.log(`[authUser] Token valid for ${minutesRemaining} more minutes (${user.username})`);
        return user.auth.ent ? { success: true } : repairEntitlements(user);
    }

    if (config.logUrls) console.log(`[authUser] Token expires in ${minutesRemaining} minutes, refreshing now (${user.username})`);
    return await refreshToken(user);
};

export const getUserInfo = async (user) => {
    const req = await fetch("https://auth.riotgames.com/userinfo", {
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
        headers: {
            'Authorization': "Bearer " + user.auth.rso
        }
    });

    if (req.statusCode !== 200) {
        console.error(`User info status code is ${req.statusCode}`);
        return null;
    }

    const json = safeJson(req.body);
    if (json?.acct) return {
        puuid: json.sub,
        username: json.acct.game_name && json.acct.game_name + "#" + json.acct.tag_line
    };
    return null;
};

const requestEntitlements = async (user) => {
    try {
        const req = await fetch("https://entitlements.auth.riotgames.com/api/token/v1", {
            method: "POST",
            timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': "Bearer " + user.auth.rso
            }
        });

        if (req.statusCode !== 200) {
            console.error(`Entitlements token status code is ${req.statusCode}`);
            if (req.statusCode === 429) return { success: false, rateLimit: Date.now() + retryAfterMs(req) };
            return { success: false, networkError: true, accessRejected: req.statusCode === 401 };
        }

        const token = safeJson(req.body)?.entitlements_token;
        return token ? { success: true, token } : { success: false, networkError: true };
    } catch {
        return { success: false, networkError: true };
    }
};

const fetchEntitlementsToken = async user => (await requestEntitlements(user)).token ?? null;

const repairEntitlements = async (user, allowRefresh = true) => {
    const result = await requestEntitlements(user);
    if (result.success) {
        return saveAuth(user, { ...user.auth, ent: result.token }) ? { success: true } : currentAuthResult(user);
    }
    if (result.accessRejected && allowRefresh && config.autoRefreshTokens && user.auth.refresh_token) {
        return refreshToken(user, null, { force: true });
    }
    return result;
};

const retryAfterMs = req => {
    const value = req.headers?.["retry-after"];
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? delay : 30000;
};

export const getRegion = async (user) => {
    const req = await fetch("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", {
        method: "PUT",
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': "Bearer " + user.auth.rso
        },
        body: JSON.stringify({
            'id_token': user.auth.idt,
        })
    });

    if (req.statusCode !== 200) {
        console.error(`PAS token status code is ${req.statusCode}`);
        return null;
    }

    return safeJson(req.body)?.affinities?.live ?? null;
};

const activeRefreshes = new Map();

/** Test hook: in-flight refresh count. Must be 0 whenever none is running. */
export const activeRefreshCount = () => activeRefreshes.size;

// The lease exceeds the bounded token request. Never refresh without owning it.
// Persist rotated tokens before the separate entitlements request can stall.
const REFRESH_LOCK_TTL_MS = 60000;
const REFRESH_LOCK_MAX_WAIT_MS = 17000;
const REFRESH_LOCK_POLL_MS = 400;

const claimCrossShardRefresh = async (lockKey, owner, user, force) => {
    const deadline = Date.now() + REFRESH_LOCK_MAX_WAIT_MS;
    while (true) {
        if (acquireRefreshLock(lockKey, owner, REFRESH_LOCK_TTL_MS)) return { gotLock: true };
        const freshUser = getUser(user);
        if (hasFreshAuth(freshUser) && (!force || freshUser.auth.rso !== user.auth.rso)) {
            return { gotLock: false, alreadyFresh: true };
        }
        if (Date.now() >= deadline) return { gotLock: false };
        await wait(REFRESH_LOCK_POLL_MS);
    }
};

export const refreshToken = async (id, account = null, { force = false } = {}) => {
    let user = getUser(id, account);
    if (!user) return { success: false };
    if (!force && hasFreshAuth(user)) return { success: true };

    const lockKey = `${user.id}:${user.puuid}`;
    if (activeRefreshes.has(lockKey)) return activeRefreshes.get(lockKey);

    const refreshPromise = (async () => {
        const owner = `${process.pid}-${threadId}-${randomUUID()}`;
        let gotLock = false;
        try {
            // Version discovery can involve network I/O; do it before the lease.
            const userAgent = user.auth?.refresh_token ? await getUserAgent() : null;
            const claim = await claimCrossShardRefresh(lockKey, owner, user, force);
            gotLock = claim.gotLock;
            if (claim.alreadyFresh) return { success: true };
            if (!gotLock) {
                console.warn('[refreshToken] Another refresh is still running; keeping credentials');
                return { success: false, networkError: true };
            }

            // Waiting may cross a rotation, login, account switch or deletion.
            // Always reload by PUUID, never by the currently selected account.
            const previousRso = user.auth?.rso;
            user = getUser(user);
            if (!user) return { success: false };
            if (hasFreshAuth(user) && (!force || user.auth.rso !== previousRso)) return { success: true };
            if (!user.auth?.refresh_token) {
                deleteUserAuth(user);
                return { success: false, authFailure: true };
            }

            const startedAt = Date.now();
            const refreshRes = await refreshWithRefreshToken(user.auth.refresh_token, userAgent);
            if (!refreshRes.success) {
                // If the lease may have expired, another shard may own it now;
                // a late failure must not delete auth. A late success is still
                // saved: the refresh token was rotated, and saveAuth is
                // compare-and-swap so it cannot overwrite a newer login.
                if (Date.now() - startedAt >= REFRESH_LOCK_TTL_MS) return currentAuthResult(user);
                if (refreshRes.invalidToken) {
                    const freshUser = getUser(user);
                    if (JSON.stringify(freshUser?.auth) !== JSON.stringify(user.auth)) return currentAuthResult(user);
                    const age = user.auth.refresh_token_obtained
                        ? `${Math.floor((Date.now() - user.auth.refresh_token_obtained) / 3600000)}h` : 'unknown';
                    console.error(`[refreshToken] User ${user.id}: OAuth ${refreshRes.errorCode} (HTTP ${refreshRes.statusCode}); refresh token age ${age}`);
                    if (!deleteUserAuth(user)) return currentAuthResult(user);
                    return { success: false, authFailure: true };
                }
                if (refreshRes.rateLimit) return { success: false, rateLimit: Date.now() + refreshRes.retryAfter };
                return { success: false, networkError: true };
            }

            const tokenData = refreshRes.tokenData;
            const auth = { ...user.auth, rso: tokenData.access_token };
            if (tokenData.id_token) auth.idt = tokenData.id_token;
            if (tokenData.refresh_token && tokenData.refresh_token !== auth.refresh_token) {
                auth.refresh_token = tokenData.refresh_token;
                auth.refresh_token_obtained = Date.now();
            }
            delete auth.ent;
            // This commit must happen before ANY more network calls. Losing a
            // rotated token during an entitlement outage breaks the next refresh.
            if (!saveAuth(user, auth, true)) return currentAuthResult(user);
            return await repairEntitlements(user, false);
        } catch (error) {
            console.error('[refreshToken] Refresh failed; keeping credentials:', error.message);
            return { success: false, networkError: true };
        } finally {
            if (gotLock) releaseRefreshLock(lockKey, owner);
        }
    })();

    activeRefreshes.set(lockKey, refreshPromise);
    try {
        return await refreshPromise;
    } finally {
        activeRefreshes.delete(lockKey);
    }
};

export const deleteUserAuth = user => saveAuth(user, {});

// BAD_CLAIMS says the API rejected these access/entitlement claims. It does
// not establish that the refresh token is invalid. Only /token can do that.
export const handleBadClaims = async user => {
    const current = getUser(user);
    if (!current?.auth?.rso) return { success: false, authFailure: true };
    if (hasFreshAuth(current) && (current.auth.rso !== user.auth.rso || current.auth.ent !== user.auth.ent)) {
        return { success: false, retry: true };
    }
    const result = tokenExpiry(current.auth.rso) <= Date.now()
        ? await authUser(current) : await repairEntitlements(current);
    return result.success ? { success: false, retry: true } : result;
};

export const getUserAgent = async () => {
    // Riot's client build rotates on every patch and is kept fresh in
    // util.js by a 15min cron + cross-shard broadcast (see bot.js
    // scheduleTasks). Read that cache each call instead of memoizing our
    // own copy here — a private cache would freeze at boot and never pick
    // up later patches, silently sending a stale build to Riot's auth
    // servers for the rest of the process's uptime.
    let versionData = getRiotVersionData();
    if (!versionData) {
        versionData = await fetchRiotVersionData();
    }
    const version = versionData ? (versionData.riotClientBuild || versionData.riotClientVersion) : "release-10.00-shipping-0-0000000";
    return `RiotClient/${version} rso-auth (Windows;10;;Professional, x64)`;
};

export const generateWebAuthUrl = () => {
    const nonce = randomUUID();

    const params = new URLSearchParams({
        client_id: "riot-client",
        redirect_uri: "http://localhost/redirect",
        response_type: "code",
        scope: "openid link ban lol_region account offline_access",
        nonce: nonce
    });

    return {
        url: `https://auth.riotgames.com/authorize?${params.toString()}`,
        nonce: nonce
    };
};

const extractCodeFromUri = (uri) => {
    try {
        const url = new URL(uri);
        return url.searchParams.get("code");
    } catch {
        const match = uri.match(/[?&]code=([^&]+)/);
        return match ? match[1] : null;
    }
};

const exchangeCodeForTokens = async (code) => {
    const req = await fetch("https://auth.riotgames.com/token", {
        method: "POST",
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'user-agent': await getUserAgent()
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code,
            redirect_uri: "http://localhost/redirect",
            client_id: "riot-client"
        }).toString()
    });

    if (req.statusCode !== 200) {
        console.error(`[exchangeCodeForTokens] Token exchange failed with status ${req.statusCode}`);
        return null;
    }

    return safeJson(req.body);
};

export const refreshWithRefreshToken = async (refreshToken, userAgent = null) => {
    try {
        const req = await fetch("https://auth.riotgames.com/token", {
            method: "POST",
            timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'user-agent': userAgent || await getUserAgent()
            },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: "riot-client"
            }).toString()
        });

        if (req.statusCode !== 200) {
            console.error(`[refreshWithRefreshToken] Refresh failed with status ${req.statusCode}`);
            if (req.statusCode === 429) {
                const retryAfter = retryAfterMs(req);
                return { success: false, rateLimit: true, statusCode: 429, retryAfter };
            }

            const errJson = safeJson(req.body);
            const invalidToken = [400, 401].includes(req.statusCode) && ["invalid_grant", "bad_claims"].includes(errJson?.error);
            return { success: false, invalidToken, errorCode: invalidToken ? errJson.error : null, statusCode: req.statusCode };
        }

        const json = safeJson(req.body);
        // A 200 that isn't JSON is not a successful refresh — treat it as
        // transient so the caller keeps the user's credentials.
        if (!json?.access_token) return { success: false, networkError: true };
        return { success: true, tokenData: json };
    } catch (e) {
        console.error(`[refreshWithRefreshToken] Exception during token refresh:`, e);
        return { success: false, networkError: true };
    }
};

export const redeemWebAuthUrl = async (id, callbackUrl) => {
    try {
        const code = extractCodeFromUri(callbackUrl);
        if (!code) {
            return { success: false, error: "Could not extract authorization code from URL. Make sure you copied the full URL from the browser address bar." };
        }

        const tokenData = await exchangeCodeForTokens(code);
        if (!tokenData || !tokenData.access_token) {
            return { success: false, error: "Failed to exchange authorization code for tokens. The code may have expired (they are single-use)." };
        }

        const rso = tokenData.access_token;
        const idt = tokenData.id_token;
        const refresh_token = tokenData.refresh_token;

        const user = new User({ id });
        user.auth = {
            rso: rso,
            idt: idt,
            refresh_token: refresh_token || null,
            refresh_token_obtained: refresh_token ? Date.now() : null
        };

        user.puuid = decodeToken(rso).sub;

        const existingAccount = getAccountWithPuuid(id, user.puuid);
        if (existingAccount) {
            user.username = existingAccount.username;
            user.region = existingAccount.region;
        }

        const [userInfo, entitlements, region] = await Promise.all([
            getUserInfo(user),
            fetchEntitlementsToken(user),
            user.region ? Promise.resolve(user.region) : getRegion(user)
        ]);

        if (!userInfo || !userInfo.username) {
            return { success: false, error: "Could not fetch user info. The token may be invalid or expired." };
        }

        user.username = userInfo.username;
        user.auth.ent = entitlements;
        user.region = region;

        user.lastFetchedData = Date.now();
        user.authFailures = 0;

        addUser(user);

        return { success: true, username: user.username };
    } catch (e) {
        console.error("Error redeeming web auth URL:", e);
        return { success: false, error: e.message || "Unknown error occurred" };
    }
};
