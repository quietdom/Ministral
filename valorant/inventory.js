import { itemTypes, userRegion } from "../misc/util.js";
import { authUser, getUser } from "./auth.js";
import { riotJson } from "./riot.js";
import config from "../misc/config.js";

export const getItemEntitlements = async (user, itemTypeId) => {
    const res = await riotJson(user, `https://pd.${userRegion(user)}.a.pvp.net/store/v1/entitlements/${user.puuid}/${itemTypeId}`);
    return res.success ? { success: true, entitlements: res.json } : res;
};

const skinCache = {};

export const getSkins = async (user, account = null) => {
    if (user.puuid in skinCache) {
        const cached = skinCache[user.puuid];
        const expiresIn = cached.timestamp - Date.now() + config.loadoutCacheExpiration;
        if (expiresIn <= 0) {
            delete skinCache[user.puuid];
        } else {
            return { success: true, skins: cached.skins };
        }
    }

    const authResult = await authUser(user.id, account);
    if (!authResult.success) return authResult;

    const data = await getItemEntitlements(user, itemTypes.SKIN);
    if (!data.success) return data;

    const skins = data.entitlements.Entitlements.map(ent => ent.ItemID);

    const skinData = {
        skins: skins,
        timestamp: Date.now()
    };

    skinCache[user.puuid] = skinData;

    return {
        success: true,
        skins: skins
    };
};

const loadoutCache = {};

export const getLoadout = async (user, account = null) => {
    if (user.puuid in loadoutCache) {
        const cached = loadoutCache[user.puuid];
        const expiresIn = cached.timestamp - Date.now() + config.loadoutCacheExpiration;
        if (expiresIn <= 0) {
            delete loadoutCache[user.puuid];
        } else {
            return { success: true, loadout: cached.loadout, favorites: cached.favorites };
        }
    }

    const authResult = await authUser(user.id, account);
    if (!authResult.success) return authResult;

    user = getUser(user.id, account);

    const base = `https://pd.${userRegion(user)}.a.pvp.net`;
    const res = await riotJson(user, `${base}/personalization/v2/players/${user.puuid}/playerloadout`);
    if (!res.success) return res;

    const res2 = await riotJson(user, `${base}/favorites/v1/players/${user.puuid}/favorites`);
    if (!res2.success) return res2;

    const loadoutData = {
        loadout: res.json,
        favorites: res2.json,
        timestamp: Date.now()
    };

    loadoutCache[user.puuid] = loadoutData;

    return {
        success: true,
        loadout: res.json,
        favorites: res2.json
    };
};