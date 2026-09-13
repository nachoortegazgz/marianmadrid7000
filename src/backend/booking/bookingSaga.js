/**
* =============================================================================
* MODULE: backend/booking/bookingCore.js
* VERSION: v19.5.5-native-slot-schedule-priority
* RESPONSIBILITY: Elevated proxies, slot sanitization, mutex locks, atomic
* transactions, persistence, and error handling.
* STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
* HISTORIAL:
* - v19.5.5-native-slot-schedule-priority: Uses scheduleId from the exact Time Slots V2 response before controlled MAPA_STAFF fallback.
* - v19.5.4-writer-location-context: Uses the Bookings Writer V2 location enum from the dedicated SSOT context.
* - v19.5.3: Replaces fixed duplicate-transaction polling with bounded SSOT backoff and jitter.
* - v19.4.4: Replaced the deprecated staff SDK lookup with MAPA_STAFF scheduleId SSOT and persisted primaryServiceGuid.
* - v19.2.0-concurrency-hardened: Uses insert-only lock acquisition, consistent reads, and payload-hash idempotency.
* - v19.1.2-v2-contract-aligned: Removed duplicate payment-status metadata keys.
* - v19.1.1-v2-contract-aligned: Normalized Slot V2 and checkout URL contracts.
* =============================================================================
*/
import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";
import { findStaff } from "backend/staff";

import {
    COLLECTIONS,
    CONCURRENCY,
    SDK_CONFIG,
    _safeTrim,
    _looksLikeGuid,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    makeTraceId,
    _toDateSafe,
    _hashKey,
} from "public/mmUtils";

export const logger = {
    error: (msg, data) => console.error("[bookingCore] ERROR:", msg, data),
    warn: (msg, data) => console.warn("[bookingCore] WARN:", msg, data),
    info: (msg, data) => console.log("[bookingCore] INFO:", msg, data),
};

const log = logger;

// -----------------------------------------------------------------------------
// Error codes (exported; used by cajas.web.js and others)
// -----------------------------------------------------------------------------
export const ERROR_CODES = Object.freeze({
    INVALID_PAYLOAD: "INVALID_PAYLOAD",
    TOKEN_BUSY: "TOKEN_BUSY",
    FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
    FISCAL_VIOLATION: "FISCAL_VIOLATION",
    BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
    CHECKOUT_FAILED: "CHECKOUT_FAILED",
    INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    ACCESS_DENIED: "ACCESS_DENIED",
    INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
    RATE_LIMITED: "RATE_LIMITED",
});

// -----------------------------------------------------------------------------
// Elevated proxies (Bookings V2 + eCom backend)
// -----------------------------------------------------------------------------
export const createBookingElevated = elevate(bookings.createBooking);
export const cancelBookingElevated = elevate(bookings.cancelBooking);
export const confirmOrDeclineBookingElevated = elevate(bookings.confirmOrDeclineBooking);
export const rescheduleBookingElevated = elevate(bookings.rescheduleBooking);

export const createCheckoutElevated = elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = elevate(checkout.getCheckoutUrl);

// -----------------------------------------------------------------------------
// Controlled scheduleId fallback from MAPA_STAFF (backend-only; no PII in logs)
// -----------------------------------------------------------------------------
async function _resolveScheduleIdByResourceId(resourceId) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const staff = await findStaff(resourceIdClean).catch(() => null);
    const scheduleId = _safeTrim(staff?.scheduleId);
    return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

// -----------------------------------------------------------------------------
// Slot normalization helpers
// -----------------------------------------------------------------------------
function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    return slot;
}

/**
* Sanitizes a slot to the exact shape required by Wix Bookings Writer V2.
* Returns null if any required field is missing or invalid.
*
* NOTE: The exact Time Slots V2 scheduleId is preferred. The backend fallback is used only when Wix omits it.
*/
export async function _forceStaffInPristineSlot(slot, resourceId, serviceGuidOverride, defaultDurationMinutes) {
    const s = _normalizeSlotShape(slot);
    if (!s) return null;

    const primaryServiceGuid = _safeTrim(serviceGuidOverride || s.primaryServiceGuid);
    if (!primaryServiceGuid || !_looksLikeGuid(primaryServiceGuid)) {
        log.error("_forceStaffInPristineSlot: invalid primaryServiceGuid", { primaryServiceGuid });
        return null;
    }

    const resourceIdClean = _safeTrim(resourceId || s.resourceId || s.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceIdClean });
        return null;
    }

    let scheduleId = _safeTrim(
        s.scheduleId ||
        s.slot?.scheduleId ||
        s.schedule?.id ||
        s.resource?.scheduleId ||
        ""
    );

    if (!scheduleId) {
        log.warn("_forceStaffInPristineSlot: Time Slots V2 scheduleId missing; using controlled fallback", {
            resourceId: resourceIdClean,
            primaryServiceGuid,
        });
        scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    }

    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.error("_forceStaffInPristineSlot: missing scheduleId for resource", {
            resourceId: resourceIdClean,
            primaryServiceGuid,
        });
        return null;
    }

    let localStartDate = "";
    const rawStart = s.localStartDate || s.startDate;
    if (rawStart instanceof Date) localStartDate = getMadridLocalStringNoZ(rawStart);
    else if (typeof rawStart === "string" && rawStart.endsWith("Z")) {
        const utcDt = new Date(rawStart);
        localStartDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localStartDate = _safeTrim(rawStart);

    if (!localStartDate) return null;

    let localEndDate = "";
    const rawEnd = s.localEndDate || s.endDate;
    if (rawEnd instanceof Date) localEndDate = getMadridLocalStringNoZ(rawEnd);
    else if (typeof rawEnd === "string" && rawEnd.endsWith("Z")) {
        const utcDt = new Date(rawEnd);
        localEndDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localEndDate = _safeTrim(rawEnd);

    if (!localEndDate) {
        const startUtc = getUtcDateFromMadridLocal(localStartDate);
        if (!startUtc) return null;

        const durationMin = Number(defaultDurationMinutes || CONCURRENCY?.DEFAULT_DURATION_MIN || 30);
        const endUtc = new Date(startUtc.getTime() + durationMin * 60 * 1000);
        localEndDate = getMadridLocalStringNoZ(endUtc);
    }

    const startDate = getUtcDateFromMadridLocal(localStartDate);
    const endDate = getUtcDateFromMadridLocal(localEndDate);
    if (!startDate || !endDate) return null;

    const locationId = _safeTrim(SDK_CONFIG?.LOCATION_ID);
    const locationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER);
    const timezone = _safeTrim(SDK_CONFIG?.TZ);

    if (!locationId || !locationType || !timezone) {
        log.error("_forceStaffInPristineSlot: incomplete SDK_CONFIG", {
            locationId: Boolean(locationId),
            locationType: Boolean(locationType),
            timezone: Boolean(timezone),
        });
        return null;
    }

    return {
        serviceId: primaryServiceGuid,
        scheduleId,
        startDate,
        endDate,
        timezone,
        resource: {
            id: resourceIdClean,
        },
        location: {
            id: locationId,
            locationType,
        },
    };
}

// -----------------------------------------------------------------------------
// Checkout URL helper (stable)
// -----------------------------------------------------------------------------
export function _extractCheckoutId(checkoutSession) {
    return checkoutSession?.checkout?._id || checkoutSession?._id || null;
}

export async function getCheckoutUrlSafe(checkoutSessionOrId) {
    const direct = checkoutSessionOrId?.checkoutUrl || checkoutSessionOrId?.checkout?.checkoutUrl || null;
    if (direct) return direct;

    const checkoutId =
        typeof checkoutSessionOrId === "string" ? checkoutSessionOrId : _extractCheckoutId(checkoutSessionOrId);

    if (!checkoutId) return null;

    try {
        const result = await getCheckoutUrlElevated(checkoutId, {});
        return result?.checkoutUrl || null;
    } catch (error) {
        log.warn("getCheckoutUrlSafe failed", { checkoutId, error: error?.message });
        return null;
    }
}

// -----------------------------------------------------------------------------
// Mutex locks (stable _id derived from slotClave)
// -----------------------------------------------------------------------------
const MUTEX_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 120000;
const LOCKS_COL = COLLECTIONS.LOCKS;

export function _safeLockId(key) {
    const k = String(key || "").trim();
    if (!k) return "";
    return `lk_${_hashKey(k)}_${k.slice(0, 24)}`;
}

async function _getLock(slotClave) {
    const k = String(slotClave || "");
    if (!k) return null;

    const id = _safeLockId(k);
    const item = await wixData
        .get(LOCKS_COL, id, { suppressAuth: true, consistentRead: true })
        .catch(() => null);

    if (!item) return null;

    if (item.expiraFecha) item.expiraFecha = _toDateSafe(item.expiraFecha);
    if (item.createdAt) item.createdAt = _toDateSafe(item.createdAt);
    if (item.updatedAt) item.updatedAt = _toDateSafe(item.updatedAt);

    return item;
}

function _isDuplicateItemError(error) {
    const message = String(error?.message || "");
    return message.includes("WDE0123") || message.includes("WD_ITEM_ALREADY_EXISTS") || message.includes("Duplicated");
}

function _buildLockDocument(slotClave, lockOwnerId, ttlMs, existing = null) {
    const now = new Date();
    const safeId = _safeLockId(slotClave);
    if (!safeId) throw new Error("LOCK_KEY_INVALID");

    return {
        ...(existing || {}),
        _id: safeId,
        slotClave: String(slotClave),
        traceId: String(lockOwnerId || makeTraceId("lock")),
        expiraFecha: new Date(Date.now() + (Number(ttlMs) || MUTEX_TTL_MS)),
        createdAt: existing?.createdAt ? _toDateSafe(existing.createdAt) || now : now,
        updatedAt: now,
    };
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    const k = String(slotClave || "");
    const owner = String(lockOwnerId || "").trim();
    if (!k || !owner) return { ok: false, message: "LOCK_KEY_OR_OWNER_INVALID" };

    try {
        const lockDocument = _buildLockDocument(k, owner, ttlMs);
        await wixData.insert(LOCKS_COL, lockDocument, { suppressAuth: true });
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, lockOwnerId: owner, error: error?.message });
            return { ok: false, message: error?.message || "Lock acquisition failed" };
        }

        const existing = await _getLock(k);
        if (existing?.traceId === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok ? { ok: true, renewed: true } : { ok: false, message: "LOCK_RENEWAL_FAILED" };
        }

        const expiraFecha = _toDateSafe(existing?.expiraFecha);
        const expired = expiraFecha ? expiraFecha.getTime() < Date.now() : false;

        return {
            ok: false,
            message: expired ? "LOCK_EXPIRED_PENDING_CLEANUP" : "LOCK_HELD_BY_ANOTHER_OWNER",
            retryAfterMs: expired ? Number(CONCURRENCY?.LOCK_CLEANUP_GRACE_MS) || 60000 : 0,
        };
    }
}

export async function _unlockSlotKey(slotClave, lockOwnerId) {
    const owner = String(lockOwnerId || "").trim();
    const existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    if (!owner || existing.traceId !== owner) return { ok: false, skipped: true };

    const remainingMs = Number(existing.expiraFecha?.getTime?.() || 0) - Date.now();
    const safeReleaseWindowMs = Number(CONCURRENCY?.LOCK_RELEASE_MIN_REMAINING_MS) || 15000;

    if (remainingMs <= safeReleaseWindowMs) {
        return { ok: false, skipped: true, reason: "LOCK_RELEASE_WINDOW_EXPIRED" };
    }

    await wixData.remove(LOCKS_COL, existing._id, { suppressAuth: true });
    return { ok: true };
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs) {
    try {
        const owner = String(lockOwnerId || "").trim();
        const existing = await _getLock(slotClave);
        if (!existing || !owner || existing.traceId !== owner) return { ok: false };

        const updated = _buildLockDocument(slotClave, owner, ttlMs, existing);
        await wixData.update(LOCKS_COL, updated, { suppressAuth: true });
        return { ok: true };
    } catch (error) {
        log.error("_renewLock failed", { slotClave, lockOwnerId, error: error?.message });
        return { ok: false };
    }
}

// -----------------------------------------------------------------------------
// Dual cache
// -----------------------------------------------------------------------------
const DUAL_CACHE_COL = COLLECTIONS.DUAL_CACHE;

export async function _getDualPairFromCache(pairToken, traceId) {
    if (!pairToken) return null;

    // Avoid wixData.get() to prevent noisy WDE0073 logs on cache misses.
    const res = await wixData
        .query(DUAL_CACHE_COL)
        .eq("_id", String(pairToken))
        .limit(1)
        .find({ suppressAuth: true })
        .catch(() => null);

    const item = res?.items?.[0] || null;
    if (!item) return null;

    const exp = _toDateSafe(item.expiraFecha);
    if (exp && exp.getTime() < Date.now()) return null;

    return item;
}

// -----------------------------------------------------------------------------
// Slot keys
// -----------------------------------------------------------------------------
export function _generateSlotKey(primaryServiceGuid, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date ? startDate : getUtcDateFromMadridLocal(startDate);
    const endUtc = endDate instanceof Date ? endDate : getUtcDateFromMadridLocal(endDate);

    const startEpochMin = startUtc ? Math.floor(startUtc.getTime() / 60000) : 0;
    const endEpochMin = endUtc ? Math.floor(endUtc.getTime() / 60000) : 0;

    const raw = `${String(primaryServiceGuid || "").trim()}|${String(resourceId || "").trim()}|${startEpochMin}|${endEpochMin}`;
    const prefix = primaryServiceGuid ? String(primaryServiceGuid).slice(0, 8) : "srv";
    const staffPrefix = resourceId ? String(resourceId).slice(0, 8) : "nostaff";

    return `slot_${prefix}_${staffPrefix}_${_hashKey(raw)}`;
}

export function _buildLockKeys(phases, resourceId) {
    const keys = (phases || []).map((p) => {
        const slot = p?.rawSlot || {};
        return _generateSlotKey(slot.primaryServiceGuid, resourceId, p.localStart, p.localEnd);
    });

    return Array.from(new Set(keys)).sort();
}

// -----------------------------------------------------------------------------
// Transactions (idempotency)
// -----------------------------------------------------------------------------
export const TRANSACTIONS_COL = COLLECTIONS.TRANSACTIONS;

const TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY?.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY?.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    const id = String(pairToken || "");
    if (!id) return null;

    return await wixData.get(TRANSACTIONS_COL, id, { suppressAuth: true, consistentRead: true }).catch(() => null);
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = String(pairToken || "");
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    try {
        await wixData.insert(
            TRANSACTIONS_COL,
            {
                _id: id,
                pairToken: id,
                status: "PENDING",
                payloadHash,
                traceId,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            { suppressAuth: true }
        );

        return { success: true, isNew: true };
    } catch (error) {
        if (_isDuplicateItemError(error)) {
            const startTime = Date.now();
            let pollAttempt = 0;

            while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
                const existing = await _getTransactionById(id);
                if (existing) {
                    if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                        return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                    }
                    if (existing.status === "COMPLETED") return { success: true, isNew: false, existing };
                    if (existing.status === "FAILED") {
                        return { success: false, error: "TRANSACTION_PREVIOUSLY_FAILED", existing };
                    }
                }

                const elapsedMs = Date.now() - startTime;
                const remainingMs = TRANSACTION_MAX_WAIT_MS - elapsedMs;
                const exponentialDelayMs = TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3));
                const jitteredDelayMs = Math.floor(exponentialDelayMs * (0.5 + Math.random()));
                const waitMs = Math.max(0, Math.min(jitteredDelayMs, remainingMs));

                if (waitMs <= 0) break;

                pollAttempt++;
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }

            const existing = await _getTransactionById(id);
            if (existing) {
                if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                    return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                }
                return { success: true, isNew: false, existing, timeout: true };
            }

            return { success: false, error: "TRANSACTION_TIMEOUT" };
        }

        throw error;
    }
}

export async function _completeTransaction(pairToken, result) {
    const id = String(pairToken || "");
    if (!id) return;

    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;

    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "COMPLETED",
        result,
        updatedAt: new Date(),
        createdAt: existing?.createdAt || new Date(),
    };

    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true });
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true });
}

export async function _failTransaction(pairToken, errorMessage) {
    const id = String(pairToken || "");
    if (!id) return;

    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;

    const doc = {
        ...(existing || {}),
        _id: id,
        pairToken: id,
        status: "FAILED",
        error: String(errorMessage || "UNKNOWN_ERROR"),
        updatedAt: new Date(),
        createdAt: existing?.createdAt || new Date(),
    };

    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
}

// -----------------------------------------------------------------------------
// Persist booking (CMS) - CitasF2 aligned fields
// -----------------------------------------------------------------------------
const CITAS_COL = COLLECTIONS.CITAS;

export async function _persistBooking(params, traceId) {
    const {
        bookingId,
        revision,
        primaryServiceGuid,
        scheduleId,
        resourceId,
        startDate,
        endDate,
        contactDetails,
        tipo,
        meta,
    } = params || {};

    if (!bookingId || !primaryServiceGuid || !resourceId || !startDate || !endDate) {
        throw new Error("Missing required fields for persistBooking");
    }

    const startDateObj = startDate instanceof Date ? startDate : new Date(startDate);
    const endDateObj = endDate instanceof Date ? endDate : new Date(endDate);

    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
        throw new Error("Invalid startDate/endDate for persistBooking");
    }

    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const endLocal = getMadridLocalStringNoZ(endDateObj);
    const fechaYmdMadrid = startLocal ? startLocal.slice(0, 10) : "";

    const now = new Date();
    const metaPago = String(meta?.statusPago || "UNPAID");
    const statusCita = metaPago === "PENDING_PAYMENT" ? "PENDING_PAYMENT" : "CONFIRMED";

    const doc = {
        bookingId: String(bookingId),
        pairToken: String(meta?.pairToken || meta?.uiPairToken || ""),
        uiPairToken: String(meta?.uiPairToken || meta?.pairToken || ""),
        revision: Number(revision) || 1,
        primaryServiceGuid: String(primaryServiceGuid),
        scheduleId: scheduleId ? String(scheduleId) : null,
        resourceId: String(resourceId),
        startDate: startDateObj,
        endDate: endDateObj,
        startDateLocal: startLocal,
        endDateLocal: endLocal,
        fechaYmdMadrid,
        tipo: tipo || "simple",

        // CitasF2 fields
        status: statusCita,
        statusPago: metaPago,

        // Keep meta for saga/debug + compatibility inside meta only
        meta: {
            ...(meta || {}),
            status: statusCita,
            estado: statusCita,
            statusPago: metaPago,
        },

        contactDetails: contactDetails || {},
        traceId: String(traceId || ""),
        fechaCreacion: now,
        fechaActualizacion: now,
    };

    if (!doc.pairToken) throw new Error("Missing pairToken for persistBooking");

    const existing = await wixData
        .query(CITAS_COL)
        .eq("bookingId", String(bookingId))
        .limit(1)
        .find({ suppressAuth: true, suppressHooks: true })
        .catch(() => null);

    if (existing?.items?.length > 0) {
        const existingDoc = existing.items[0];
        const updated = { ...existingDoc, ...doc };

        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;

        const item = await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { created: false, item };
    }

    const item = await wixData.insert(CITAS_COL, doc, { suppressAuth: true, suppressHooks: true });
    return { created: true, item };
}

// -----------------------------------------------------------------------------
// Addons helpers (exported for saga)
// -----------------------------------------------------------------------------
export function _normalizeAddons(addons) {
    if (!Array.isArray(addons)) return [];

    return addons.map((a) => ({
        id: a.id || a._id || "",
        nombre: a.nombre || a.name || "Complemento",
        precio: Number(a.precio || a.price || 0),
    }));
}

export function _sumAddons(addons) {
    if (!Array.isArray(addons)) return 0;
    return addons.reduce((acc, a) => acc + Number(a.precio || a.price || 0), 0);
}

// -----------------------------------------------------------------------------
// Errors + PII sanitization
// -----------------------------------------------------------------------------
export class BookingError extends Error {
    constructor(code, message, details = {}) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || "UNKNOWN_ERROR");
        this.details = details && typeof details === "object" ? details : { details };
        this.timestamp = new Date().toISOString();
        if (Error.captureStackTrace) Error.captureStackTrace(this, BookingError);
    }
}

export function createBookingError(code, message, details) {
    return new BookingError(code, message, details);
}

const PII_KEYS = new Set([
    "nombre",
    "apellidos",
    "firstname",
    "lastname",
    "email",
    "telefono",
    "phone",
    "address",
    "cliente",
    "contactdetails",
    "contactid",
    "identity",
]);

function _sanitizeDetails(details) {
    if (!details) return details;
    if (Array.isArray(details)) return details.map((v) => _sanitizeDetails(v));
    if (typeof details !== "object") return details;

    const sanitized = {};
    for (const [key, value] of Object.entries(details)) {
        const k = String(key || "").toLowerCase();
        if (PII_KEYS.has(k)) sanitized[key] = "[REDACTED]";
        else if (typeof value === "object" && value !== null) sanitized[key] = _sanitizeDetails(value);
        else sanitized[key] = value;
    }

    return sanitized;
}

export function normalizeError(err) {
    if (err && typeof err === "object" && err.name === "BookingError") {
        return {
            code: String(err.code || "UNKNOWN_ERROR"),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details || {},
        };
    }

    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || "UNKNOWN_ERROR"),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details && typeof err.details === "object" ? err.details : {},
            statusCode: err.statusCode || err.status || null,
        };
    }

    if (typeof err === "string") return { code: "UNKNOWN_ERROR", message: err, stack: null, details: {} };
    if (!err) return { code: "UNKNOWN_ERROR", message: "Unknown error", stack: null, details: {} };

    if (typeof err === "object") {
        const code = err.code || err.errorCode || err.name || "UNKNOWN_ERROR";
        const message = err.message || err.error || err.description || JSON.stringify(err);
        const details = err.details && typeof err.details === "object" ? err.details : {};

        return {
            code: String(code),
            message: String(message),
            stack: err.stack || null,
            details,
            statusCode: err.statusCode || err.status || null,
        };
    }

    return { code: "UNKNOWN_ERROR", message: String(err), stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    const sanitizedDetails = _sanitizeDetails(norm.details || {});

    loggerInstance.error(`[${context}] ${norm.code}: ${norm.message}`, { traceId, details: sanitizedDetails });

    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || "UNKNOWN_ERROR",
            message: norm.message || "Unknown error",
            ...(Object.keys(sanitizedDetails).length ? { details: sanitizedDetails } : {}),
        },
    };
}
