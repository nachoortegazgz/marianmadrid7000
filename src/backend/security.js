/*
=============================================================================
MODULE: backend/security.js
VERSION: v5005-5
RESPONSIBILITY: RBAC authorization, persistent blocks and rate limiting.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import { getSecret } from "wix-secrets-backend";
import { currentMember } from "wix-members-backend";
import wixData from "wix-data";

import { SECRETS } from "backend/mmSecrets";
import {
    COLLAB_ROLES,
    COLLECTIONS,
    SDK_CONFIG
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeEmail,
    _safeTrim
} from "public/mmUtils";

import {
    logger,
    ERROR_CODES,
    createBookingError
} from "backend/booking/bookingCore";

const log = logger;

const ROLE_CACHE_TTL_MS = 300000;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const PERSIST_THRESHOLD = 3;
const PERSIST_BLOCK_MS = 60 * 60 * 1000;
const MAX_KEY_LENGTH = 160;
const MAX_CACHE_ENTRIES =
    SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES || 5000;

let cachedAdminEmails = null;
let cachedCajeroEmails = null;
let adminCacheTime = 0;
let cajeroCacheTime = 0;

const rateLimitCache = new Map();
const persistentBlockCache = new Map();

function safeLog(level, message, data = {}) {
    try {
        if (
            log &&
            typeof log[level] === "function"
        ) {
            log[level](message, data);
        }
    } catch (_) {
        return false;
    }

    return true;
}

function normalizeRole(role) {
    if (
        role &&
        typeof role === "object"
    ) {
        return _safeTrim(
            role.name ||
            role.title ||
            role.role ||
            ""
        ).toUpperCase();
    }

    return _safeTrim(role).toUpperCase();
}

function normalizeKey(value, fallback = "anon") {
    const clean = _safeTrim(value)
        .replace(/[\r\n\t]/g, "_")
        .slice(0, MAX_KEY_LENGTH);

    return clean || fallback;
}

function buildRateKey(surface, key) {
    return [
        normalizeKey(surface, "global"),
        normalizeKey(key, "anon")
    ].join(":");
}

function getBlockStorageKey(surface, key) {
    return buildRateKey(surface, key);
}

function normalizeEmailList(rawValue) {
    return String(rawValue || "")
        .split(",")
        .map((email) => _safeEmail(email))
        .filter(Boolean)
        .filter((email, index, list) =>
            list.indexOf(email) === index
        );
}

async function getCachedSecretEmails(
    secretName,
    cacheType
) {
    const now = Date.now();

    if (
        cacheType === "admin" &&
        cachedAdminEmails &&
        now - adminCacheTime < ROLE_CACHE_TTL_MS
    ) {
        return cachedAdminEmails;
    }

    if (
        cacheType === "cajero" &&
        cachedCajeroEmails &&
        now - cajeroCacheTime < ROLE_CACHE_TTL_MS
    ) {
        return cachedCajeroEmails;
    }

    let raw = "";

    try {
        raw = await getSecret(secretName);
    } catch (error) {
        safeLog("warn", "Role email secret lookup failed", {
            cacheType,
            message: error?.message
        });
    }

    const emails = normalizeEmailList(raw);

    if (cacheType === "admin") {
        cachedAdminEmails = emails;
        adminCacheTime = now;
    } else if (cacheType === "cajero") {
        cachedCajeroEmails = emails;
        cajeroCacheTime = now;
    }

    return emails;
}

async function getCachedAdminEmails() {
    return getCachedSecretEmails(
        SECRETS.ADMIN_EMAILS,
        "admin"
    );
}

async function getCachedCajeroEmails() {
    return getCachedSecretEmails(
        SECRETS.CAJERO_EMAILS,
        "cajero"
    );
}

function cleanupRateLimitCache(now) {
    for (const [
            cacheKey,
            entry
        ] of rateLimitCache.entries()) {
        if (
            !entry ||
            now - entry.windowStart >
            RATE_LIMIT_WINDOW_MS * 2
        ) {
            rateLimitCache.delete(cacheKey);
        }
    }

    for (const [
            cacheKey,
            expiresAt
        ] of persistentBlockCache.entries()) {
        if (
            !Number.isFinite(expiresAt) ||
            expiresAt <= now
        ) {
            persistentBlockCache.delete(cacheKey);
        }
    }
}

function enforceCacheLimit(cache) {
    while (cache.size > MAX_CACHE_ENTRIES) {
        const firstKey = cache.keys().next().value;

        if (firstKey === undefined) {
            break;
        }

        cache.delete(firstKey);
    }
}

export async function isKeyPersistentlyBlocked(
    surface,
    key
) {
    const cleanSurface = normalizeKey(
        surface,
        "global"
    );

    const cleanKey = normalizeKey(
        key,
        "anon"
    );

    const storageKey = getBlockStorageKey(
        cleanSurface,
        cleanKey
    );

    const now = Date.now();
    const cachedExpiry =
        persistentBlockCache.get(storageKey);

    if (
        Number.isFinite(cachedExpiry) &&
        cachedExpiry > now
    ) {
        return true;
    }

    if (cachedExpiry) {
        persistentBlockCache.delete(storageKey);
    }

    try {
        const result = await wixData
            .query(COLLECTIONS.RATE_LIMIT_BLOCKS)
            .eq("surface", cleanSurface)
            .eq("key", cleanKey)
            .gt("expiresAt", new Date(now))
            .ascending("expiresAt")
            .limit(1)
            .find({
                suppressAuth: true
            });

        const item = Array.isArray(result?.items) ?
            result.items[0] :
            null;

        if (!item) {
            return false;
        }

        const expiry = new Date(
            item.expiresAt
        ).getTime();

        if (
            !Number.isFinite(expiry) ||
            expiry <= now
        ) {
            return false;
        }

        persistentBlockCache.set(
            storageKey,
            expiry
        );

        enforceCacheLimit(
            persistentBlockCache
        );

        return true;
    } catch (error) {
        safeLog(
            "warn",
            "Persistent block lookup failed", {
                surface: cleanSurface,
                key: cleanKey,
                message: error?.message
            }
        );

        return false;
    }
}

async function persistRateLimitBlock(
    surface,
    key,
    violations,
    traceId
) {
    const cleanSurface = normalizeKey(
        surface,
        "global"
    );

    const cleanKey = normalizeKey(
        key,
        "anon"
    );

    const now = Date.now();
    const expiresAt =
        now + PERSIST_BLOCK_MS;

    const storageKey = getBlockStorageKey(
        cleanSurface,
        cleanKey
    );

    persistentBlockCache.set(
        storageKey,
        expiresAt
    );

    enforceCacheLimit(
        persistentBlockCache
    );

    const itemId = [
            "RL",
            cleanSurface,
            cleanKey,
            now
        ]
        .join("-")
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 100);

    try {
        await wixData.insert(
            COLLECTIONS.RATE_LIMIT_BLOCKS, {
                _id: itemId,
                surface: cleanSurface,
                key: cleanKey,
                violations: Math.max(
                    0,
                    Number(violations) || 0
                ),
                expiresAt: new Date(expiresAt),
                _createdDate: new Date()
            }, {
                suppressAuth: true
            }
        );
    } catch (error) {
        safeLog(
            "warn",
            "Persistent rate limit block write failed", {
                traceId,
                surface: cleanSurface,
                key: cleanKey,
                message: error?.message
            }
        );
    }
}

export function rateLimiter({
        surface,
        key
    } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    const cleanSurface = normalizeKey(
        surface,
        "global"
    );

    const cleanKey = normalizeKey(
        key,
        "anon"
    );

    const cacheKey = buildRateKey(
        cleanSurface,
        cleanKey
    );

    const now = Date.now();

    const max = Math.max(
        1,
        Number(maxRequests) ||
        RATE_LIMIT_MAX_REQUESTS
    );

    const window = Math.max(
        1000,
        Number(windowMs) ||
        RATE_LIMIT_WINDOW_MS
    );

    cleanupRateLimitCache(now);

    let entry = rateLimitCache.get(cacheKey);

    if (
        !entry ||
        now - entry.windowStart >= window
    ) {
        entry = {
            count: 1,
            windowStart: now,
            violations: 0
        };

        rateLimitCache.set(
            cacheKey,
            entry
        );

        enforceCacheLimit(
            rateLimitCache
        );

        return {
            allowed: true,
            retryAfter: 0,
            violations: 0
        };
    }

    entry.count += 1;

    if (entry.count <= max) {
        return {
            allowed: true,
            retryAfter: 0,
            violations: entry.violations || 0
        };
    }

    entry.violations =
        Number(entry.violations || 0) + 1;

    if (
        entry.violations >= PERSIST_THRESHOLD
    ) {
        void persistRateLimitBlock(
            cleanSurface,
            cleanKey,
            entry.violations,
            makeTraceId("rate-limit")
        );
    }

    return {
        allowed: false,
        retryAfter: Math.max(
            0,
            window - (now - entry.windowStart)
        ),
        violations: entry.violations,
        persistent: false
    };
}

export async function enforceRateLimit({
        surface,
        key
    } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    const cleanSurface = normalizeKey(
        surface,
        "global"
    );

    const cleanKey = normalizeKey(
        key,
        "anon"
    );

    const blocked =
        await isKeyPersistentlyBlocked(
            cleanSurface,
            cleanKey
        );

    if (blocked) {
        return {
            allowed: false,
            retryAfter: PERSIST_BLOCK_MS,
            violations: PERSIST_THRESHOLD,
            persistent: true
        };
    }

    return rateLimiter({
            surface: cleanSurface,
            key: cleanKey
        },
        maxRequests,
        windowMs
    );
}

function getMemberRoles(member) {
    return Array.isArray(member?.roles) ?
        member.roles :
        [];
}

async function getCurrentMember() {
    try {
        return await currentMember.getMember({
            fieldsets: ["FULL"]
        });
    } catch (_) {
        return null;
    }
}

function getMemberEmail(member) {
    return _safeEmail(
        member?.loginEmail ||
        member?.contact?.emails?.[0]?.email ||
        ""
    );
}

function hasRole(member, roles) {
    const allowedRoles = roles
        .filter(Boolean)
        .map((role) =>
            String(role).trim().toUpperCase()
        );

    return getMemberRoles(member).some((role) =>
        allowedRoles.includes(
            normalizeRole(role)
        )
    );
}

export async function isAdmin(traceId) {
    const activeTraceId =
        _safeTrim(traceId) ||
        makeTraceId("rbac");

    try {
        const member = await getCurrentMember();

        if (!member) {
            return false;
        }

        const memberEmail =
            getMemberEmail(member);

        const adminEmails =
            await getCachedAdminEmails();

        if (
            memberEmail &&
            adminEmails.includes(memberEmail)
        ) {
            return true;
        }

        return hasRole(member, [
            COLLAB_ROLES.ADMIN
        ]);
    } catch (error) {
        safeLog("error", "isAdmin check failed", {
            traceId: activeTraceId,
            message: error?.message
        });

        return false;
    }
}

export async function isCajero(traceId) {
    const activeTraceId =
        _safeTrim(traceId) ||
        makeTraceId("rbac");

    try {
        const member = await getCurrentMember();

        if (!member) {
            return false;
        }

        const memberEmail =
            getMemberEmail(member);

        const cajeroEmails =
            await getCachedCajeroEmails();

        if (
            memberEmail &&
            cajeroEmails.includes(memberEmail)
        ) {
            return true;
        }

        if (
            hasRole(member, [
                COLLAB_ROLES.ADMIN,
                COLLAB_ROLES.GESTION
            ])
        ) {
            return true;
        }

        return isAdmin(activeTraceId);
    } catch (error) {
        safeLog("error", "isCajero check failed", {
            traceId: activeTraceId,
            message: error?.message
        });

        return false;
    }
}

export async function isStaffCollaborator(
    traceId
) {
    const activeTraceId =
        _safeTrim(traceId) ||
        makeTraceId("rbac");

    try {
        const member = await getCurrentMember();

        if (!member) {
            return false;
        }

        const memberEmail =
            getMemberEmail(member);

        const adminEmails =
            await getCachedAdminEmails();

        const cajeroEmails =
            await getCachedCajeroEmails();

        if (
            memberEmail &&
            (
                adminEmails.includes(memberEmail) ||
                cajeroEmails.includes(memberEmail)
            )
        ) {
            return true;
        }

        return hasRole(member, [
            COLLAB_ROLES.ADMIN,
            COLLAB_ROLES.GESTION,
            COLLAB_ROLES.ESTILISTA
        ]);
    } catch (error) {
        safeLog(
            "error",
            "isStaffCollaborator check failed", {
                traceId: activeTraceId,
                message: error?.message
            }
        );

        return false;
    }
}

function requireAccess(
    accessCheck,
    message,
    traceId
) {
    const activeTraceId =
        _safeTrim(traceId) ||
        makeTraceId("rbac");

    return Promise.resolve(
        accessCheck(activeTraceId)
    ).then((allowed) => {
        if (!allowed) {
            throw createBookingError(
                ERROR_CODES.ACCESS_DENIED,
                message, {
                    traceId: activeTraceId
                }
            );
        }

        return true;
    });
}

export function requireAdmin(traceId) {
    return requireAccess(
        isAdmin,
        "Admin access required",
        traceId
    );
}

export function requireCajero(traceId) {
    return requireAccess(
        isCajero,
        "Cajero access required",
        traceId
    );
}

export function requireMarianManager(traceId) {
    return requireAccess(
        isCajero,
        "Marian manager access required",
        traceId
    );
}

export function clearSecurityCaches() {
    cachedAdminEmails = null;
    cachedCajeroEmails = null;
    adminCacheTime = 0;
    cajeroCacheTime = 0;
    rateLimitCache.clear();
    persistentBlockCache.clear();
}