import { fetch, isMaintenance, riotClientHeaders, safeJson } from "../misc/util.js";
import { handleBadClaims, getUser } from "./auth.js";

export const riotAuthHeaders = (user) => ({
    "Authorization": "Bearer " + user.auth.rso,
    "X-Riot-Entitlements-JWT": user.auth.ent,
    ...riotClientHeaders(),
});

/**
 * Authenticated Riot request that parses the JSON body and runs the shared
 * failure ladder: BAD_CLAIMS (refresh the user's tokens, retry once),
 * maintenance, then networkError when `valid(req, json)` fails.
 *
 * `onResponse(req, json)` runs first; a truthy return is handed back as-is
 * (used for caller-specific statuses such as the shop's 429).
 *
 * Returns { success: true, json, req } or the { success: false, ... } object.
 */
export const riotJson = async (user, url, { valid = (req, json) => json, onResponse, ...opts } = {}, _retried = false) => {
    const req = await fetch(url, { ...opts, headers: riotAuthHeaders(user) });
    const json = safeJson(req.body);

    const early = onResponse?.(req, json);
    if (early) return early;

    if (json?.httpStatus === 400 && json?.errorCode === "BAD_CLAIMS") {
        const result = await handleBadClaims(user);
        if (result.retry && !_retried) return await riotJson(getUser(user), url, { valid, onResponse, ...opts }, true);
        return result;
    }
    if (isMaintenance(json)) return { success: false, maintenance: true };
    if (!valid(req, json)) return { success: false, networkError: true };
    return { success: true, json, req };
};
