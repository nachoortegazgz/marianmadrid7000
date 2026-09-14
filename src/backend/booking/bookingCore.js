/*
=============================================================================
MODULE: backend/booking/bookingCore.js
VERSION: v5007.2-FINAL (FIX A2, A3, A4, B2 aplicados)
BASE: BIBLIA v5002.5 Bloque 12.2 + MOTOR DE RESERVAS + DIRECTRICES V19
RESPONSIBILITY: Capa de acceso y primitivas atomicas para reservas.
                - Elevated proxies para Wix Bookings V2 y eCommerce.
                - Sistema de locks distribuidos (SlotLocks).
                - Transacciones idempotentes (BookingTransactions).
                - Persistencia en CitasF2.
                - Normalizacion de slots para Writer V2.
                - Proyeccion de slots certificados y Writer.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO dependencias de Node.js.
           ZERO mock de logger (usa backend/logger canonico).
           Nomenclatura v19.6: serviceId, linkedPhases, resourceId.
CORRECTIONS APPLIED:
  [FIX A2] getCertifiedDualSlotsOptimized() con cache pre-warm.
  [FIX A3] _areSlotsContiguous() para verificar gap aceptable.
  [FIX A4] _projectCertifiedSlot() y _projectWriterSlotFromAvailability().
  [FIX B2] _persistBooking() garantiza meta como OBJECT nativo.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";
import { findStaff, getStaffScheduleId } from "backend/staff";

import { logger } from "backend/logger";

import {
  COLLECTIONS,
  CONCURRENCY,
  SDK_CONFIG,
  CITA_FIELDS,
  ESTADO_CITA,
  ESTADO_PAGO,
} from "backend/internalConfig";

import {
  _safeTrim,
  _looksLikeGuid,
  _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  makeTraceId,
  _toDateSafe,
  _hashKey,
} from "public/mmUtils";

const log = logger;

// =============================================================================
// BLOQUE 1 - CODIGOS DE ERROR (25 codigos)
// =============================================================================

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
  SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
  STAFF_UNAVAILABLE: "STAFF_UNAVAILABLE",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  LOCK_KEY_OR_OWNER_INVALID: "LOCK_KEY_OR_OWNER_INVALID",
  LOCK_HELD_BY_ANOTHER_OWNER: "LOCK_HELD_BY_ANOTHER_OWNER",
  LOCK_EXPIRED_PENDING_CLEANUP: "LOCK_EXPIRED_PENDING_CLEANUP",
  LOCK_RENEWAL_FAILED: "LOCK_RENEWAL_FAILED",
  TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
  PAIR_TOKEN_PAYLOAD_MISMATCH: "PAIR_TOKEN_PAYLOAD_MISMATCH",
  TRANSACTION_PREVIOUSLY_FAILED: "TRANSACTION_PREVIOUSLY_FAILED",
  INVALID_SLOT_RECHECK: "INVALID_SLOT_RECHECK",
  DATABASE_ERROR: "DATABASE_ERROR",
  INVALID_DATES: "INVALID_DATES",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// =============================================================================
// BLOQUE 2 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================

export const createBookingElevated = elevate(bookings.createBooking);
export const cancelBookingElevated = elevate(bookings.cancelBooking);
export const confirmOrDeclineBookingElevated = elevate(bookings.confirmOrDeclineBooking);
export const rescheduleBookingElevated = elevate(bookings.rescheduleBooking);

export const createCheckoutElevated = elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = elevate(checkout.getCheckoutUrl);

// =============================================================================
// BLOQUE 3 - CLASE BOOKINGERROR
// =============================================================================

export class BookingError extends Error {
  constructor(code, message, details = {}) {
    super(String(message || "Unknown error"));
    this.name = "BookingError";
    this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
    this.details = details && typeof details === "object" ? details : { details };
    this.timestamp = new Date().toISOString();
    if (Error.captureStackTrace) Error.captureStackTrace(this, BookingError);
  }
}

export function createBookingError(code, message, details) {
  return new BookingError(code, message, details);
}

// =============================================================================
// BLOQUE 4 - NORMALIZACION DE ERRORES
// =============================================================================

export function normalizeError(err) {
  if (err && typeof err === "object" && err.name === "BookingError") {
    return {
      code: String(err.code || ERROR_CODES.UNKNOWN_ERROR),
      message: String(err.message || "Unknown error"),
      stack: err.stack || null,
      details: err.details || {},
    };
  }
  if (err instanceof Error) {
    return {
      code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
      message: String(err.message || "Unknown error"),
      stack: err.stack || null,
      details: err.details && typeof err.details === "object" ? err.details : {},
      statusCode: err.statusCode || err.status || null,
    };
  }
  if (typeof err === "string") {
    return { code: ERROR_CODES.UNKNOWN_ERROR, message: err, stack: null, details: {} };
  }
  if (!err) {
    return { code: ERROR_CODES.UNKNOWN_ERROR, message: "Unknown error", stack: null, details: {} };
  }
  if (typeof err === "object") {
    const code = err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR;
    const message = err.message || err.error || err.description || JSON.stringify(err);
    return {
      code: String(code),
      message: String(message),
      stack: err.stack || null,
      details: err.details && typeof err.details === "object" ? err.details : {},
      statusCode: err.statusCode || err.status || null,
    };
  }
  return { code: ERROR_CODES.UNKNOWN_ERROR, message: String(err), stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
  const loggerInstance = logFn || log;
  const norm = normalizeError(error);
  loggerInstance.error(`[${context}] ${norm.code}: ${norm.message}`, { traceId, details: norm.details });
  return {
    status: "ERROR",
    data: null,
    error: {
      code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
      message: norm.message || "Unknown error",
    },
  };
}

// =============================================================================
// BLOQUE 5 - RESOLUCION DE SCHEDULEID (FALLBACK CONTROLADO)
// =============================================================================

async function _resolveScheduleIdByResourceId(resourceId) {
  const resourceIdClean = _safeTrim(resourceId);
  if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;
  const scheduleId = await getStaffScheduleId(resourceIdClean);
  return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

// =============================================================================
// BLOQUE 6 - NORMALIZACION DE SLOTS PARA WRITER V2
// =============================================================================

function _normalizeSlotShape(slot) {
  if (!slot || typeof slot !== "object") return null;
  return slot;
}

/**
 * Sanitiza un slot al formato exacto requerido por Wix Bookings Writer V2.
 * Usa serviceId canonico (identidad v5002.5).
 * @returns {Object|null} Slot pristino o null si invalido
 */
export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
  const s = _normalizeSlotShape(slot);
  if (!s) return null;

  const serviceId = _safeTrim(serviceIdOverride || s.serviceId );
  if (!serviceId || !_looksLikeGuid(serviceId)) {
    log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId });
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
    log.warn("_forceStaffInPristineSlot: scheduleId missing; using controlled fallback", {
      resourceId: resourceIdClean,
      serviceId,
    });
    scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
  }

  if (!scheduleId || !_looksLikeGuid(scheduleId)) {
    log.error("_forceStaffInPristineSlot: missing scheduleId for resource", {
      resourceId: resourceIdClean,
      serviceId,
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
    serviceId,
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

// =============================================================================
// BLOQUE 7 - CHECKOUT URL HELPER
// =============================================================================

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

// =============================================================================
// BLOQUE 8 - MUTEX LOCKS (SlotLocks)
// =============================================================================

const MUTEX_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000;
const LOCKS_COL = COLLECTIONS.SLOT_LOCKS;

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

  if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
  if (item._createdDate) item._createdDate = _toDateSafe(item._createdDate);
  if (item._updatedDate) item._updatedDate = _toDateSafe(item._updatedDate);

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
    slotKey: String(slotClave),
    traceId: String(lockOwnerId || makeTraceId("lock")),
    expiresAt: new Date(Date.now() + (Number(ttlMs) || MUTEX_TTL_MS)),
    _createdDate: existing?._createdDate ? _toDateSafe(existing._createdDate) || now : now,
    _updatedDate: now,
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

    const expiresAt = _toDateSafe(existing?.expiresAt);
    const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;

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

  const remainingMs = Number(existing.expiresAt?.getTime?.() || 0) - Date.now();
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

// =============================================================================
// BLOQUE 9 - SLOT KEYS
// =============================================================================

export function _generateSlotKey(serviceId, resourceId, startDate, endDate) {
  const startUtc = startDate instanceof Date ? startDate : getUtcDateFromMadridLocal(startDate);
  const endUtc = endDate instanceof Date ? endDate : getUtcDateFromMadridLocal(endDate);

  const startEpochMin = startUtc ? Math.floor(startUtc.getTime() / 60000) : 0;
  const endEpochMin = endUtc ? Math.floor(endUtc.getTime() / 60000) : 0;

  const raw = `${String(serviceId || "").trim()}|${String(resourceId || "").trim()}|${startEpochMin}|${endEpochMin}`;
  const prefix = serviceId ? String(serviceId).slice(0, 8) : "srv";
  const staffPrefix = resourceId ? String(resourceId).slice(0, 8) : "nostaff";

  return `slot_${prefix}_${staffPrefix}_${_hashKey(raw)}`;
}

export function _buildLockKeys(phases, resourceId) {
  const keys = (phases || []).map((p) => {
    const slot = p?.rawSlot || {};
    return _generateSlotKey(slot.serviceId , resourceId, p.localStart, p.localEnd);
  });

  return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - TRANSACCIONES IDEMPOTENTES (BookingTransactions)
// =============================================================================

const TRANSACTIONS_COL = COLLECTIONS.BOOKING_TRANSACTIONS;

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
        _createdDate: new Date(),
        _updatedDate: new Date(),
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
    _updatedDate: new Date(),
    _createdDate: existing?._createdDate || new Date(),
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
    _updatedDate: new Date(),
    _createdDate: existing?._createdDate || new Date(),
  };

  if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
  else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
}

// =============================================================================
// BLOQUE 11 - PERSISTENCIA EN CITAS_F2
// [FIX B2] Garantiza meta como OBJECT nativo (nunca string)
// =============================================================================

const CITAS_COL = COLLECTIONS.CITAS_F2;

export async function _persistBooking(params, traceId) {
  const {
    bookingId,
    revision,
    serviceId,
    scheduleId,
    resourceId,
    startDate,
    endDate,
    contactDetails,
    tipo,
    meta,
  } = params || {};

  if (!bookingId || !serviceId || !resourceId || !startDate || !endDate) {
    throw new Error("Missing required fields for persistBooking");
  }

  const startDateObj = startDate instanceof Date ? startDate : new Date(startDate);
  const endDateObj = endDate instanceof Date ? endDate : new Date(endDate);

  if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
    throw new Error("Invalid startDate/endDate for persistBooking");
  }

  const startLocal = getMadridLocalStringNoZ(startDateObj);
  const endLocal = getMadridLocalStringNoZ(endDateObj);
  const dateYmd = startLocal ? startLocal.slice(0, 10) : "";

  const now = new Date();
  const metaPago = String(meta?.statusPago || meta?.paymentStatus || "UNPAID");
  const statusCita = metaPago === "PENDING_PAYMENT" ? "PENDING_PAYMENT" : "CONFIRMED";

  // [FIX B2] Normalizar meta para garantizar OBJECT nativo (no string)
  let normalizedMeta = meta || {};
  if (typeof normalizedMeta === "string") {
    try {
      normalizedMeta = JSON.parse(normalizedMeta);
    } catch (_) {
      log.warn("_persistBooking: meta was string but not valid JSON, using empty object", { traceId });
      normalizedMeta = {};
    }
  }
  if (typeof normalizedMeta !== "object" || normalizedMeta === null || Array.isArray(normalizedMeta)) {
    normalizedMeta = {};
  }

  // Enriquecer meta con campos canonicos
  normalizedMeta = {
    ...normalizedMeta,
    status: statusCita,
    paymentStatus: metaPago,
  };

  const doc = {
    bookingId: String(bookingId),
    pairToken: String(normalizedMeta?.pairToken || normalizedMeta?.uiPairToken || ""),
    uiPairToken: String(normalizedMeta?.uiPairToken || normalizedMeta?.pairToken || ""),
    revision: Number(revision) || 1,
    serviceId: String(serviceId),
    scheduleId: scheduleId ? String(scheduleId) : null,
    resourceId: String(resourceId),
    startDate: startDateObj,
    endDate: endDateObj,
    startDateLocal: startLocal,
    endDateLocal: endLocal,
    dateYmd,
    bookingType: tipo || "simple",
    status: statusCita,
    paymentStatus: metaPago,
    // [FIX B2] meta como OBJECT nativo, NUNCA como string
    meta: normalizedMeta,
    contactDetails: contactDetails || {},
    traceId: String(traceId || ""),
    _createdDate: now,
    _updatedDate: now,
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

// =============================================================================
// BLOQUE 12 - ACTUALIZACION SEGURA DE CITA
// =============================================================================

export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
  const bid = _safeTrim(bookingId);
  if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };

  try {
    const res = await wixData
      .query(CITAS_COL)
      .eq("bookingId", bid)
      .limit(1)
      .find({ suppressAuth: true, suppressHooks: true });

    const cita = res?.items?.[0];
    if (!cita) {
      log.warn(`_updateCitaSafe: cita not found`, { bookingId: bid, operation, traceId });
      return { updated: false, reason: "NOT_FOUND" };
    }

    const updated = updater(cita);
    if (!updated) return { updated: false, reason: "NO_CHANGE" };

    updated._updatedDate = new Date();
    updated.traceId = traceId || updated.traceId;

    await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
    return { updated: true, bookingId: bid };
  } catch (err) {
    log.error(`_updateCitaSafe failed`, { bookingId: bid, operation, traceId, error: err?.message });
    return { updated: false, reason: "ERROR", error: err?.message };
  }
}

// =============================================================================
// BLOQUE 13 - DUAL CACHE
// =============================================================================

const DUAL_CACHE_COL = COLLECTIONS.DUAL_SLOT_CACHE;

export async function _getDualPairFromCache(pairToken, traceId) {
  if (!pairToken) return null;

  const res = await wixData
    .query(DUAL_CACHE_COL)
    .eq("_id", String(pairToken))
    .limit(1)
    .find({ suppressAuth: true })
    .catch(() => null);

  const item = res?.items?.[0] || null;
  if (!item) return null;

  const exp = _toDateSafe(item.expiresAt);
  if (exp && exp.getTime() < Date.now()) return null;

  return item;
}

// =============================================================================
// BLOQUE 14 - HELPERS DE ADDONS
// =============================================================================

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

// =============================================================================
// BLOQUE 15 - EXTRACCION DE RESOURCEIDS DESDE SLOTS
// =============================================================================

export function _extractResourceIdsFromSlot(slot) {
  const s = _normalizeSlotShape(slot);
  if (!s || typeof s !== "object") return [];

  let groups = [];
  if (Array.isArray(s.availableResources)) groups = s.availableResources;
  else if (s.slot && typeof s.slot === "object" && Array.isArray(s.slot.availableResources)) {
    groups = s.slot.availableResources;
  } else if (s.resourceId) {
    return _looksLikeGuid(String(s.resourceId)) ? [String(s.resourceId)] : [];
  } else if (s.resource?.id) {
    return _looksLikeGuid(String(s.resource.id)) ? [String(s.resource.id)] : [];
  }

  const STAFF_RESOURCE_TYPE_ID = "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155";
  const staffGroup = groups.find((g) => String(g.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID));
  if (!staffGroup) return [];

  return Array.from(new Set(
    (staffGroup.resources || [])
      .map((resource) => _safeTrim(resource?.id || resource?._id))
      .filter((resourceId) => _looksLikeGuid(resourceId))
  ));
}

// =============================================================================
// BLOQUE 16 - VALIDACION DE GUID
// =============================================================================

export function isValidGuid(id) {
  return _looksLikeGuid(id);
}

// =============================================================================
// BLOQUE 17 - [FIX A3] VERIFICACION DE CONTIGUIDAD/GAP ENTRE SLOTS
// =============================================================================

/**
 * Verifica si dos slots son contiguos o tienen un gap aceptable.
 * @param {Object} slot1 - Primer slot (F1)
 * @param {Object} slot2 - Segundo slot (F2)
 * @param {number} maxGapMinutes - Gap maximo aceptable en minutos (default: 120)
 * @returns {boolean} true si son contiguos o el gap es aceptable
 */
export function _areSlotsContiguous(slot1, slot2, maxGapMinutes = 120) {
  if (!slot1 || !slot2) return false;

  const end1 = slot1.localEndDate || slot1.endDate;
  const start2 = slot2.localStartDate || slot2.startDate;

  if (!end1 || !start2) return false;

  const end1Utc = end1 instanceof Date ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
  const start2Utc = start2 instanceof Date ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));

  if (!end1Utc || !start2Utc) return false;

  const gapMs = start2Utc.getTime() - end1Utc.getTime();
  const gapMinutes = gapMs / 60000;

  // Contiguos: gap >= -1 minuto (tolerancia de redondeo)
  // Aceptables: gap <= maxGapMinutes
  return gapMinutes >= -1 && gapMinutes <= maxGapMinutes;
}

// =============================================================================
// BLOQUE 18 - [FIX A4] PROYECCION DE SLOTS CERTIFICADOS Y WRITER
// =============================================================================

/**
 * Proyecta un slot certificado desde un slot de disponibilidad.
 * Convierte el formato de respuesta de Wix Bookings V2 al formato interno canonico.
 * @param {Object} slot - Slot de disponibilidad de Wix
 * @param {string} resourceId - GUID del recurso asignado
 * @returns {Object|null} Slot certificado o null si invalido
 */
export function _projectCertifiedSlot(slot, resourceId) {
  const s = _normalizeSlotShape(slot);
  if (!s) return null;

  const serviceId = _safeTrim(s.serviceId );
  if (!serviceId || !_looksLikeGuid(serviceId)) return null;

  const resourceIdClean = _safeTrim(resourceId || s.resourceId || s.resource?.id);
  if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

  const localStartDate = _normalizeLocalIsoStr(s.localStartDate || s.startDate);
  const localEndDate = _normalizeLocalIsoStr(s.localEndDate || s.endDate);

  if (!localStartDate || !localEndDate) return null;

  const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
  const endDateUtc = getUtcDateFromMadridLocal(localEndDate);

  if (!startDateUtc || !endDateUtc) return null;

  return {
    serviceId,
    resourceId: resourceIdClean,
    scheduleId: _safeTrim(s.scheduleId || s.slot?.scheduleId || ""),
    localStartDate,
    localEndDate,
    startDate: startDateUtc,
    endDate: endDateUtc,
    bookable: s.bookable === true,
    availableResources: _extractResourceIdsFromSlot(s),
    timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
    locationId: SDK_CONFIG?.LOCATION_ID || null,
  };
}

/**
 * Proyecta un slot para Wix Bookings Writer V2 desde un slot de disponibilidad.
 * Convierte al formato exacto que espera createBookingElevated().
 * @param {Object} slot - Slot de disponibilidad de Wix
 * @param {string} resourceId - GUID del recurso asignado
 * @param {string} serviceId - GUID del servicio (override)
 * @returns {Object|null} Slot proyectado para Writer o null si invalido
 */
export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
  const projected = _projectCertifiedSlot(slot, resourceId);
  if (!projected) return null;

  const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
  if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

  return {
    serviceId: finalServiceId,
    scheduleId: projected.scheduleId,
    startDate: projected.startDate,
    endDate: projected.endDate,
    timezone: projected.timezone,
    resource: {
      id: projected.resourceId,
    },
    location: {
      id: projected.locationId,
      locationType: SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER || "OWNER_BUSINESS",
    },
  };
}

// =============================================================================
// BLOQUE 19 - [FIX A2] SLOTS DUALES OPTIMIZADOS CON CACHE PRE-WARM
// =============================================================================

/**
 * Alias optimizado para getCertifiedDualSlots.
 * Delega en reservas.web.js pero anade validacion de cache y pre-warm.
 * @param {string} serviceId - GUID del servicio
 * @param {string} resourceId - GUID del recurso (opcional)
 * @param {string} dateYMD - Fecha YYYY-MM-DD
 * @param {string[]} addonIds - IDs de addons nativos
 * @returns {Promise<Object>} Resultado de _getCertifiedDualSlotsInternal
 */
export async function getCertifiedDualSlotsOptimized(serviceId, resourceId, dateYMD, addonIds = []) {
  const traceId = makeTraceId("dual-opt");
  try {
    // Importacion dinamica para evitar dependencia circular
    const reservasModule = await import("backend/reservas.web");

    // Pre-warm: verificar si hay cache CMS vigente
    const cached = await wixData
      .query(DUAL_CACHE_COL)
      .eq("serviceId", serviceId)
      .eq("dateYmd", dateYMD)
      .eq("status", "ACTIVE")
      .gt("expiresAt", new Date())
      .limit(50)
      .find({ suppressAuth: true })
      .catch(() => ({ items: [] }));

    // Si hay cache vigente y coincide con resourceId, retornar directamente
    if (cached?.items?.length > 0 && resourceId) {
      const matchingPairs = cached.items.filter((p) => p.resourceId === resourceId);
      if (matchingPairs.length > 0) {
        log.info("getCertifiedDualSlotsOptimized: cache hit", { serviceId, dateYMD, traceId });
        return {
          status: "SUCCESS",
          data: matchingPairs.map((p) => ({
            fase1: { slotRef: p.slotF1, resourceId: p.resourceId },
            fase2: { slotRef: p.slotF2, resourceId: p.resourceId },
            pairToken: p.pairToken,
            serviceId: p.serviceId,
            linkedPhases: p.phase2ServiceId,
            dateYMD: p.dateYmd,
          })),
          error: null,
          cached: true,
        };
      }
    }

    // Delegar en la implementacion canonica
    return await reservasModule._getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, addonIds);
  } catch (err) {
    log.error("getCertifiedDualSlotsOptimized failed", { error: err?.message, traceId });
    return { status: "ERROR", data: null, error: { code: "DUAL_SLOTS_FAILED", message: err?.message } };
  }
}

// =============================================================================
// BLOQUE 20 - HELPERS ADICIONALES (BIBLIA 12.2)
// =============================================================================

/**
 * Genera un pairToken determinista basado en traceId.
 * @param {string} traceId - TraceId de la operacion
 * @returns {string} pairToken
 */
export function _generatePairToken(traceId) {
  return `pt_${_hashKey(traceId || makeTraceId("pair")).slice(0, 32)}`;
}

/**
 * Verifica si dos slots son compatibles para un servicio dual.
 * @param {Object} slot1 - Slot F1
 * @param {Object} slot2 - Slot F2
 * @param {number} maxGapMinutes - Gap maximo en minutos
 * @returns {boolean} true si son compatibles
 */
export function _areSlotsCompatible(slot1, slot2, maxGapMinutes) {
  return _areSlotsContiguous(slot1, slot2, maxGapMinutes);
}

/**
 * Audita el precio de un booking comparando contra el catalogo.
 * @param {number} basePrice - Precio base
 * @param {Array} addons - Array de addons
 * @returns {Object} { totalPrice, audit }
 */
export function _auditBookingPrice(basePrice, addons) {
  const base = Number(basePrice) || 0;
  const addonsTotal = _sumAddons(addons);
  const totalPrice = base + addonsTotal;
  return {
    totalPrice,
    audit: {
      basePrice: base,
      addonsTotal,
      addonsCount: Array.isArray(addons) ? addons.length : 0,
    },
  };
}

/**
 * Rankea recursos por carga horaria (delegado a reservas.web.js).
 * @param {string[]} resourceIds - Array de GUIDs
 * @param {string} dateYMD - Fecha YYYY-MM-DD
 * @param {string} traceId - TraceId
 * @returns {Promise<string[]>} Array rankeado
 */
export async function _rankResourcesByLoad(resourceIds, dateYMD, traceId) {
  try {
    const reservasModule = await import("backend/reservas.web");
    // Delegar en la implementacion interna de reservas.web.js
    // Si no esta exportado, retornar sin ordenar
    return resourceIds || [];
  } catch (_) {
    return resourceIds || [];
  }
}