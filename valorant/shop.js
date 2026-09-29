import { authUser, getUser, getPuuid } from "./auth.js";
import { fetch, isSameDay, userRegion } from "../misc/util.js";
import { riotJson } from "./riot.js";
import { addBundleData, getSkin, addPricesFromShop, getBundle, getItem } from "./cache.js";
import { addStore } from "../misc/stats.js";
import config from "../misc/config.js";
import { deleteUser, saveUser } from "./accountSwitcher.js";

const memoryShopCache = new Map();

const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
const RADIANITE = "e59aa87c-4cbf-517a-5983-6e81511be9b7";
const KC = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";

const formatBundle = async (rawBundle) => {
    const bundle = {
        uuid: rawBundle.DataAssetID,
        expires: Math.floor(Date.now() / 1000) + rawBundle.DurationRemainingInSeconds,
        items: []
    };

    let price = 0;
    let basePrice = 0;
    for (const rawItem of rawBundle.Items) {
        const item = {
            uuid: rawItem.Item.ItemID,
            type: rawItem.Item.ItemTypeID,
            item: await getItem(rawItem.Item.ItemID, rawItem.Item.ItemTypeID),
            amount: rawItem.Item.Amount,
            price: rawItem.DiscountedPrice,
            basePrice: rawItem.BasePrice,
            discount: rawItem.DiscountPercent
        };

        price += item.price;
        basePrice += item.basePrice;
        bundle.items.push(item);
    }

    bundle.price = price;
    bundle.basePrice = basePrice;
    return bundle;
};

export const formatNightMarket = (rawNightMarket) => {
    if (!rawNightMarket) return null;

    return {
        offers: rawNightMarket.BonusStoreOffers.map(offer => ({
            uuid: offer.Offer.OfferID,
            realPrice: offer.Offer.Cost[VP],
            nmPrice: offer.DiscountCosts[VP],
            percent: offer.DiscountPercent
        })),
        expires: Math.floor(Date.now() / 1000) + rawNightMarket.BonusStoreRemainingDurationInSeconds
    };
};

const getShop = async (id, account = null) => {
    const authSuccess = await authUser(id, account);
    if (!authSuccess.success) return authSuccess;

    const user = getUser(id, account);
    if (config.logUrls) console.log(`Fetching shop for ${user.username}...`);

    // Riot answers an outage with an HTML error page, not JSON — parsing that
    // unguarded threw out of getShop and took /shop, /alerts and the nightly
    // alert run with it. A body we can't parse is a network error, and so is a
    // 200 without the shop payload (callers reach into json.SkinsPanelLayout).
    const res = await riotJson(user, `https://pd.${userRegion(user)}.a.pvp.net/store/v3/storefront/${user.puuid}`, {
        method: "POST",
        body: JSON.stringify({}),
        valid: (req, json) => req.statusCode === 200 && json?.SkinsPanelLayout,
        onResponse: (req, json) => {
            if (req.statusCode !== 429 && json?.httpStatus !== 429 && json?.errorCode !== "RATE_LIMITED") return;
            const retryAfterHeader = req.headers?.['retry-after'];
            const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 30000;
            return { success: false, rateLimit: Date.now() + retryAfter };
        }
    });
    if (!res.success) return res;
    const json = res.json;

    try {
        await addStore(user.puuid, json.SkinsPanelLayout.SingleItemOffers);
    } catch (e) {
        console.error("Error adding shop stats:", e);
    }

    addShopCache(user.puuid, json);
    addPricesFromShop(json);

    Promise.all(json.FeaturedBundle.Bundles.map(rawBundle => formatBundle(rawBundle))).then(async bundles => {
        for (const bundle of bundles)
            await addBundleData(bundle);
    }).catch(e => console.error("Error processing shop bundles:", e?.message || e));

    return { success: true, shop: json };
};

export const getOffers = async (id, account = null) => {
    const puuid = getPuuid(id, account);
    if (!puuid) return { success: false, error: "User not found" };

    const shopCache = await getShopCache(puuid, "offers");
    if (shopCache) return { success: true, cached: true, ...shopCache.offers };

    const resp = await getShop(id, account);
    if (!resp.success) return resp;

    return await easterEggOffers(id, account, {
        success: true,
        offers: resp.shop.SkinsPanelLayout.SingleItemOffers,
        expires: Math.floor(Date.now() / 1000) + resp.shop.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds,
        accessory: formatAccessory(resp.shop, Date.now())
    });
};

export const getBundles = async (id, account = null) => {
    const puuid = getPuuid(id, account);
    if (!puuid) return { success: false, error: "User not found" };

    const shopCache = await getShopCache(puuid, "bundles");
    if (shopCache) {
        let complete = true;
        for (const bundleCache of shopCache.bundles) {
            const bundle = await getBundle(bundleCache.uuid);
            if (!bundle || !bundle.items) {
                complete = false;
                break;
            }
        }
        if (complete) return { success: true, bundles: shopCache.bundles };
    }

    const resp = await getShop(id, account);
    if (!resp.success) return resp;

    const formatted = await Promise.all(resp.shop.FeaturedBundle.Bundles.map(rawBundle => formatBundle(rawBundle)));
    return { success: true, bundles: formatted };
};

export const getNightMarket = async (id, account = null) => {
    const puuid = getPuuid(id, account);
    if (!puuid) return { success: false, error: "User not found" };

    const shopCache = await getShopCache(puuid, "night_market");
    if (shopCache) return { success: true, ...shopCache.night_market };

    const resp = await getShop(id, account);
    if (!resp.success) return resp;

    if (!resp.shop.BonusStore) return {
        success: true,
        offers: false
    };

    return { success: true, ...formatNightMarket(resp.shop.BonusStore) };
};

export const getBalance = async (id, account = null) => {
    const authSuccess = await authUser(id, account);
    if (!authSuccess.success) return authSuccess;

    const user = getUser(id, account);
    console.log(`Fetching balance for ${user.username}...`);

    const res = await riotJson(user, `https://pd.${userRegion(user)}.a.pvp.net/store/v1/wallet/${user.puuid}`, {
        valid: (req, json) => req.statusCode === 200 && json?.Balances
    });
    if (!res.success) return res;

    const { Balances } = res.json;
    return {
        success: true,
        vp: Balances[VP],
        rad: Balances[RADIANITE],
        kc: Balances[KC]
    };
};

let nextNMTimestamp = null, nextNMTimestampUpdated = 0;
export const getNextNightMarketTimestamp = async () => {
    if (nextNMTimestampUpdated > Date.now() - 5 * 60 * 1000) return nextNMTimestamp;

    try {
        const req = await fetch("https://gist.githubusercontent.com/mistralwz/17bb10db4bb77df5530024bcb0385042/raw/nmdate.txt");
        const [timestamp] = req.body.split("\n");
        nextNMTimestamp = parseInt(timestamp, 10);
        if (isNaN(nextNMTimestamp) || nextNMTimestamp < Date.now() / 1000) nextNMTimestamp = null;
        nextNMTimestampUpdated = Date.now();
    } catch (e) {
        console.error("Failed to fetch next night market timestamp:", e);
    }
    return nextNMTimestamp;
};

export let NMTimestamp = null;

const getShopCache = async (puuid, target = "offers", print = true) => {
    if (!config.useShopCache) return null;

    try {
        const shopCache = memoryShopCache.get(puuid);
        if (!shopCache) return null;

        let expiresTimestamp;
        if (target === "offers") expiresTimestamp = shopCache[target].expires;
        else if (target === "night_market") expiresTimestamp = shopCache[target] ? shopCache[target].expires : getMidnightTimestamp(shopCache.timestamp);
        else if (target === "bundles") expiresTimestamp = Math.min(...shopCache.bundles.map(bundle => bundle.expires), get9PMTimetstamp(Date.now()));
        else if (target === "all") {
            const nmExpires = shopCache.night_market ? shopCache.night_market.expires : getMidnightTimestamp(shopCache.timestamp);
            expiresTimestamp = Math.min(shopCache.offers.expires, ...shopCache.bundles.map(bundle => bundle.expires), get9PMTimetstamp(Date.now()), nmExpires);
        }

        if (Date.now() / 1000 > expiresTimestamp) {
            memoryShopCache.delete(puuid);
            return null;
        }

        if (print) console.log(`Fetched shop cache for user ${puuid}`);

        if (!shopCache.offers.accessory) {
            memoryShopCache.delete(puuid);
            return null;
        }

        return shopCache;
    } catch (e) {
        console.error(`Failed to get shop cache for ${puuid}:`, e);
    }
    return null;
};

const formatAccessory = (shopJson, now) => ({
    offers: ((shopJson.AccessoryStore && shopJson.AccessoryStore.AccessoryStoreOffers) || []).map(rawAccessory => ({
        cost: rawAccessory.Offer?.Cost ? rawAccessory.Offer.Cost[KC] : 0,
        rewards: rawAccessory.Offer?.Rewards || [],
        contractID: rawAccessory.ContractID
    })),
    expires: Math.floor(now / 1000) + (shopJson.AccessoryStore ? shopJson.AccessoryStore.AccessoryStoreRemainingDurationInSeconds : 0)
});

const addShopCache = async (puuid, shopJson) => {
    if (!config.useShopCache) return;

    const now = Date.now();
    const shopCache = {
        offers: {
            offers: shopJson.SkinsPanelLayout ? shopJson.SkinsPanelLayout.SingleItemOffers : [],
            expires: Math.floor(now / 1000) + (shopJson.SkinsPanelLayout ? shopJson.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds : 0),
            accessory: formatAccessory(shopJson, now)
        },
        bundles: (shopJson.FeaturedBundle?.Bundles || []).map(rawBundle => ({
            uuid: rawBundle.DataAssetID,
            expires: Math.floor(now / 1000) + rawBundle.DurationRemainingInSeconds,
        })),
        night_market: formatNightMarket(shopJson.BonusStore),
        timestamp: now
    };

    if (shopJson.BonusStore) NMTimestamp = now;

    memoryShopCache.set(puuid, shopCache);
    console.log(`Added shop cache for user ${puuid}`);
};

export const clearShopMemoryCache = async () => {
    const memoryEntries = memoryShopCache.size;
    memoryShopCache.clear();
    console.log(`Cleared shop memory cache (${memoryEntries} entries)`);
};

const utcTimestamp = (timestamp, hour) => {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 59, 59, 999) / 1000;
};
const getMidnightTimestamp = (timestamp) => utcTimestamp(timestamp, 23);
const get9PMTimetstamp = (timestamp) => utcTimestamp(timestamp, 20);

const easterEggOffers = async (id, account, offers) => {
    try {
        const _offers = { ...offers, offers: [...offers.offers] };
        const user = getUser(id, account);

        const sawEasterEgg = isSameDay(user.lastSawEasterEgg, Date.now());
        const isApril1st = new Date().getMonth() === 3 && new Date().getDate() === 1;
        if (isApril1st && !sawEasterEgg) {
            for (const [i, uuid] of Object.entries(_offers.offers)) {
                const skin = await getSkin(uuid);
                const defaultSkin = await getSkin(skin.defaultSkinUuid);
                _offers.offers[i] = defaultSkin.uuid;
            }

            user.lastSawEasterEgg = Date.now();
            saveUser(user);
            return _offers;
        }
    } catch (e) {
        console.error("Easter egg error:", e);
    }
    return offers;
};
