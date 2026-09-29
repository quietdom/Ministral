import { removeDupeAlerts } from "../misc/util.js";
import { defaultSettings, clearSettingsCache } from "../misc/settings.js";
import {
    getUserFromDb,
    saveUserToDb,
    deleteUserFromDb,
    deleteAccountFromDb,
    runUserDbTransaction,
    updateSingleAccountInDb
} from "../misc/userDatabase.js";

export { getUserFromDb as readUserJson };

export const getUserJson = (id, account = null) => {
    const user = getUserFromDb(id);
    if (!user) return null;

    account = account || user.currentAccount || 1;
    if (account > user.accounts.length) account = 1;

    return user.accounts[account - 1] || null;
};

// Callers of this helper only touch metadata (e.g. migrating alert channel
// ids), never auth — always preserve whatever's currently in the DB.
export const saveUserJson = (id, json) => {
    if (!json.id) json.id = id;
    saveUserToDb(json, true);
};

export const saveUser = (user) => {
    // A command may have read this user before auth refreshed on another shard
    // (or while rendering the shop). Metadata saves must never write tokens.
    if (user.puuid && updateSingleAccountInDb(user, true)) {
        return;
    }

    runUserDbTransaction(() => {
        if (!getUserFromDb(user.id)) {
            saveUserToDb({
                id: user.id,
                accounts: [user],
                currentAccount: 1,
                settings: defaultSettings
            });
        } else {
            // The account was removed/replaced since the caller read it. Never
            // resurrect it with stale tokens or overwrite another slot (addUser adds accounts).
            console.log(`[saveUser] Account ${user.puuid} of ${user.id} no longer exists, not saving`);
        }
    });
};

export const addUser = (user) => {
    console.log(`[addUser] Saving user ${user.id} to database`);
    runUserDbTransaction(() => {
        const userJson = getUserFromDb(user.id);
        if (userJson) {
            let foundDuplicate = false;
            for (let i = 0; i < userJson.accounts.length; i++) {
                if (userJson.accounts[i].puuid === user.puuid) {
                    const oldUser = userJson.accounts[i];
                    user.alerts = removeDupeAlerts((oldUser?.alerts || []).concat(user.alerts || []));
                    user.lastFetchedData = oldUser?.lastFetchedData;
                    user.lastNoticeSeen = oldUser?.lastNoticeSeen;
                    user.lastSawEasterEgg = oldUser?.lastSawEasterEgg;

                    userJson.accounts[i] = user;
                    userJson.currentAccount = i + 1;
                    foundDuplicate = true;
                    break;
                }
            }

            if (!foundDuplicate) {
                userJson.accounts.push(user);
                userJson.currentAccount = userJson.accounts.length;
            }

            saveUserToDb(userJson);
        } else {
            saveUserToDb({
                id: user.id,
                accounts: [user],
                currentAccount: 1,
                settings: defaultSettings
            });
        }
    });
};

export const deleteUser = (id, accountNumber) => {
    return runUserDbTransaction(() => {
        const userJson = getUserFromDb(id);
        if (!userJson) return null;

        const indexToDelete = (accountNumber || userJson.currentAccount) - 1;
        const userToDelete = userJson.accounts[indexToDelete];
        if (!userToDelete) return null;

        userJson.accounts.splice(indexToDelete, 1);
        if (userJson.accounts.length === 0) {
            deleteUserFromDb(id);
            clearSettingsCache(id);
        } else {
            if (userJson.currentAccount > userJson.accounts.length) {
                userJson.currentAccount = userJson.accounts.length;
            }
            deleteAccountFromDb(userToDelete.puuid);
            saveUserToDb(userJson, true);
            clearSettingsCache(id);
        }

        return userToDelete.username;
    });
};

export const deleteWholeUser = async (id) => {
    deleteUserFromDb(id);
    clearSettingsCache(id);
};

export const getNumberOfAccounts = (id) => {
    const user = getUserFromDb(id);
    if (!user) return 0;
    return user.accounts.length;
};

export const switchAccount = (id, accountNumber) => {
    const userJson = getUserFromDb(id);
    if (!userJson) return null;

    // Validate here rather than at each call site. Both callers can hand this
    // a bad value — `/account 99` resolves to 99, and the account button path
    // parseInt()s a customId segment — and an unvalidated number was written
    // to currentAccount and persisted, leaving a pointer that getUserJson then
    // has to silently paper over on every later read.
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > userJson.accounts.length) return null;

    userJson.currentAccount = accountNumber;
    saveUserToDb(userJson, true);

    return userJson.accounts[accountNumber - 1];
};

export const getAccountWithPuuid = (id, puuid) => {
    const userJson = getUserFromDb(id);
    if (!userJson) return null;
    return userJson.accounts.find(a => a.puuid === puuid) || null;
};

export const findTargetAccountIndex = (id, query) => {
    const userJson = getUserFromDb(id);
    if (!userJson) return null;

    let index = userJson.accounts.findIndex(a => a.username === query || a.puuid === query);
    if (index !== -1) return index + 1;

    return parseInt(query, 10) || null;
};
