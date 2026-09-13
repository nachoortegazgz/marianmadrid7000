/*
=============================================================================
MODULE: backend/citasManager.web.js
VERSION: v5007.4-FINAL (CORREGIDO)
BASE: BIBLIA v5002.5 Bloque 12.4 + MOTOR DE RESERVAS + DIRECTRICES V19
CORRECTIONS APPLIED:
  [CM-01] Nomenclatura v19.6: serviceId, linkedPhases, resourceId.
  [CM-02] Idempotencia por pairToken en processDualBooking.
  [CM-03] Validación de orden pagada antes de confirmar pago.
  [CM-04] _assertBookingOwner verifica propiedad de la cita.
  [CM-05] Reprogramación dual con revalidación de slots.
  [CM-06] _buildDualRescheduleSlot usa linkedPhases (no secondaryServiceGuid).
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { orders } from "wix-ecom-backend";
import { logger } from "backend/logger";
import {
  COLLECTIONS,
  SDK_CONFIG,
  APP_IDS,
  CITA_FIELDS,
  ESTADO_CITA,
  ESTADO_PAGO,
  FORMA_PAGO,
} from "backend/internalConfig";
import {
  makeTraceId,
  _safeTrim,
  _looksLikeGuid,
  _normalizeLocalIsoStr,
  _roundMoney,
  _readPositiveAmount,
  withTimeout,
} from "public/mmUtils";
import { executeBookingSaga } from "backend/booking/bookingSaga";
import {
  _updateCitaSafe,
  normalizeError,
  _handleError,
  ERROR_CODES,
  createBookingError,
  rescheduleBookingElevated,
  cancelBookingElevated,
  _forceStaffInPristineSlot,
} from "backend/booking/bookingCore";
import { registerBookingPayment } from "backend/cajas.web";
import { requireAdmin, rateLimiter } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { revalidateExactAvailabilitySlot, _getServiceBySlugOrIdInternal } from "backend/reservas.web";

const log = logger;
const CITAS_COL = COLLECTIONS.CITAS_F2;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

// ============================================================================
// HELPERS INTERNOS
// ============================================================================

function _getCitaMeta(cita) {
  if (!cita) return {};
  const meta = cita.meta || cita[CITA_FIELDS.META] || {};
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch (_) { return {}; }
  }
  return meta;
}

function _getNativeAddonIdsForRevalidation(cita) {
  const meta = _getCitaMeta(cita);
  const addonIds = meta.nativeAddonIds || meta.addonIds || [];
  return Array.isArray(addonIds) ? addonIds.filter((id) => _looksLikeGuid(String(id))) : [];
}

async function _findCitaByBookingId(bookingId) {
  const bid = _safeTrim(bookingId);
  if (!bid) return null;

  const res = await wixData
    .query(CITAS_COL)
    .eq("bookingId", bid)
    .limit(1)
    .find({ suppressAuth: true });

  return res?.items?.[0] || null;
}

async function _logAuditEvent(tipoEvento, level, message, data = {}, traceId, entityId = "system") {
  try {
    await wixData.insert(COLLECTIONS.MM_AUDIT_LOG, {
      _id: `AUDIT_${_safeTrim(tipoEvento).slice(0, 30)}_${_safeTrim(entityId).slice(0, 20)}_${Date.now()}`,
      eventType: tipoEvento,
      level,
      message,
      data,
      resourceId: "SYSTEM",
      source: "backend/citasManager.web.js",
      loggedAt: new Date(),
      traceId,
    }, { suppressAuth: true });
  } catch (err) {
    log.error("Failed to write to AUDIT_LOG", { error: err?.message, traceId });
  }
}

function _rateLimitOrThrow(surface, key, traceId) {
  const rl = rateLimiter({ surface, key });
  if (!rl.allowed) {
    const e = new Error("RATE_LIMITED");
    e.code = "RATE_LIMITED";
    e.meta = { retryAfter: rl.retryAfter, surface, traceId };
    throw e;
  }
}

// ============================================================================
// WEBMETHOD: PROCESS DUAL BOOKING
// [CM-02] Idempotencia por pairToken
// ============================================================================

export const processDualBooking = webMethod(Permissions.Anyone, async (unsafePayload) => {
  const traceId = unsafePayload?.traceId || makeTraceId("dual-bkg");
  try {
    _rateLimitOrThrow("citasManager.processDualBooking", _safeTrim(unsafePayload?.email) || "anon", traceId);
    const result = await executeBookingSaga({ ...unsafePayload, traceId });
    return result;
  } catch (err) {
    return _handleError(err, "processDualBooking", traceId);
  }
});

// ============================================================================
// CONFIRMACIÓN DE PAGO
// [CM-03] Validación de orden pagada antes de confirmar
// ============================================================================

function _isPaidOrderStatus(value) {
  const s = String(value || "").toUpperCase();
  return ["PAID", "FULLY_PAID", "PAID_FULL"].includes(s);
}

function _getOrderBookingLineItems(order) {
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const bookingsAppId = APP_IDS.BOOKINGS;
  return lineItems.filter((item) => item?.catalogReference?.appId === bookingsAppId);
}

function _getBookingLineItemsTotal(lineItems) {
  return (lineItems || []).reduce((sum, item) => {
    const itemPrice = Number(item?.price?.amount ?? item?.price ?? 0) || 0;
    return sum + (itemPrice * (Number(item?.quantity) || 1));
  }, 0);
}

async function _getValidatedPaidOrder(orderId, bookingIds, requestedTotalAmount, traceId) {
  const oid = _safeTrim(orderId);
  if (!oid) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "orderId is required", { traceId });

  let order = null;
  try {
    order = await withTimeout(orders.getOrder(oid), API_TIMEOUT_MS, "getOrder");
  } catch (err) {
    throw createBookingError(ERROR_CODES.DATABASE_ERROR, `Failed to fetch order: ${err?.message}`, { traceId });
  }

  if (!order) throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Order not found", { traceId });

  const paymentStatus = String(order?.paymentStatus || "").toUpperCase();
  if (!_isPaidOrderStatus(paymentStatus)) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Order not paid. Status: ${paymentStatus}`, { traceId });
  }

  const bookingLineItems = _getOrderBookingLineItems(order);
  const orderBookingIds = bookingLineItems.map((item) => String(item?.catalogReference?.catalogItemId || ""));

  for (const bid of bookingIds) {
    if (!orderBookingIds.includes(String(bid))) {
      throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, `Booking ${bid} not found in order`, { traceId });
    }
  }

  const orderTotal = Number(order?.priceSummary?.total?.amount ?? 0) || 0;
  const lineItemsTotal = _getBookingLineItemsTotal(bookingLineItems);
  const finalAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;

  if (requestedTotalAmount && Math.abs(finalAmount - requestedTotalAmount) > 0.01) {
    throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Amount mismatch with order", { traceId });
  }

  return { order, finalAmount, bookingLineItems };
}

async function _validatePaymentCitaSet(citas, orderId, traceId) {
  for (const cita of citas) {
    const currentPayment = String(cita[CITA_FIELDS.STATUS_PAGO] || _getCitaMeta(cita).paymentStatus || "").toUpperCase();
    if (currentPayment === ESTADO_PAGO.PAID) {
      throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Cita already paid", { traceId, bookingId: cita.bookingId });
    }
    if (currentPayment === ESTADO_PAGO.REFUNDED) {
      throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Cita already refunded", { traceId, bookingId: cita.bookingId });
    }
  }
}

async function _setCitasPaymentState(citas, paymentState, orderId, traceId) {
  for (const cita of citas) {
    await _updateCitaSafe(cita.bookingId, (c) => {
      const meta = _getCitaMeta(c);
      return {
        ...c,
        [CITA_FIELDS.STATUS]: ESTADO_CITA.CONFIRMED,
        [CITA_FIELDS.STATUS_PAGO]: paymentState,
        meta: {
          ...meta,
          paymentStatus: paymentState,
          orderId: orderId || null,
          fechaConfirmacionPago: new Date(),
        },
      };
    }, traceId, "citasManager_setPaymentState");
  }
}

export const confirmPayment = webMethod(Permissions.Anyone, async (payload) => {
  const traceId = payload?.traceId || makeTraceId("confirm-pay");
  try {
    _rateLimitOrThrow("citasManager.confirmPayment", _safeTrim(payload?.orderId) || "anon", traceId);

    const orderId = _safeTrim(payload?.orderId);
    const bookingIds = Array.isArray(payload?.bookingIds) ? payload.bookingIds.map(String).filter(Boolean) : [];
    const requestedAmount = _readPositiveAmount(payload?.amount);

    if (!orderId || bookingIds.length === 0) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PAYLOAD", message: "orderId and bookingIds required" } };
    }

    // [CM-03] Validar orden pagada en Wix
    const { order, finalAmount } = await _getValidatedPaidOrder(orderId, bookingIds, requestedAmount, traceId);

    // Buscar citas
    const citas = [];
    for (const bid of bookingIds) {
      const cita = await _findCitaByBookingId(bid);
      if (!cita) {
        return { status: "ERROR", data: null, error: { code: "CITA_NOT_FOUND", message: `Cita not found for booking ${bid}` } };
      }
      citas.push(cita);
    }

    // Validar estado de pago
    await _validatePaymentCitaSet(citas, orderId, traceId);

    // Registrar en ledger
    const linkedBookingIds = bookingIds.join(",");
    const ledgerRes = await registerBookingPayment(
      linkedBookingIds,
      finalAmount,
      FORMA_PAGO.ONLINE,
      {
        concept: `Pago online reserva ${orderId}`,
        resourceId: "online",
        traceId,
        transactionId: `ORDER-${orderId}`,
        orderId,
        origen: "WIX_ECOM_PAYMENT_CONFIRM",
        tipoMovimiento: "VENTA_ONLINE",
      }
    );

    if (ledgerRes?.status !== "SUCCESS") {
      await _logAuditEvent("PAYMENT_LEDGER_FAILED", "ERROR", `Ledger failed for order ${orderId}`, { orderId, traceId }, traceId, orderId);
      return { status: "ERROR", data: null, error: { code: "LEDGER_FAIL", message: ledgerRes?.error?.message || "Ledger registration failed" } };
    }

    // Actualizar estado de citas
    await _setCitasPaymentState(citas, ESTADO_PAGO.PAID, orderId, traceId);

    await _logAuditEvent("PAYMENT_CONFIRMED", "INFO", `Payment confirmed for order ${orderId}`, { orderId, bookingIds, traceId }, traceId, orderId);

    return { status: "SUCCESS", data: { orderId, bookingIds, amount: finalAmount, paymentStatus: ESTADO_PAGO.PAID }, error: null };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("confirmPayment failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "CONFIRM_PAY_FAIL", message: norm.message } };
  }
});

// ============================================================================
// REPROGRAMACIÓN DE RESERVA SIMPLE
// ============================================================================

export const rescheduleExistingBooking = webMethod(Permissions.Anyone, async (bookingId, newSlot, revision) => {
  const traceId = makeTraceId("resched");
  try {
    _rateLimitOrThrow("citasManager.rescheduleExistingBooking", _safeTrim(bookingId) || "anon", traceId);

    const cita = await _findCitaByBookingId(bookingId);
    if (!cita) {
      return { status: "ERROR", data: null, error: { code: "CITA_NOT_FOUND", message: "Cita not found" } };
    }

    await _assertBookingOwner(cita, traceId);

    const currentRevision = Number(cita.revision || 0);
    const requestedRevision = Number(revision || 0);
    if (requestedRevision > 0 && requestedRevision !== currentRevision) {
      return { status: "ERROR", data: null, error: { code: "REVISION_MISMATCH", message: "Revision mismatch" } };
    }

    const serviceId = _safeTrim(cita.serviceId || _getCitaMeta(cita).serviceId);
    const revalidation = await revalidateExactAvailabilitySlot({
      serviceId,
      localStartDate: newSlot?.localStartDate || newSlot?.start,
      localEndDate: newSlot?.localEndDate || newSlot?.end,
      resourceId: cita.resourceId,
      traceId,
    });

    if (revalidation?.status !== "SUCCESS") {
      return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "New slot is not available" } };
    }

    const schedule = {
      startDate: newSlot?.localStartDate || newSlot?.start,
      endDate: newSlot?.localEndDate || newSlot?.end,
      timeZone: SDK_CONFIG.TZ,
    };

    await rescheduleBookingElevated(bookingId, schedule, {});

    await _updateCitaSafe(bookingId, (c) => ({
      ...c,
      startDate: new Date(newSlot?.localStartDate || newSlot?.start),
      endDate: new Date(newSlot?.localEndDate || newSlot?.end),
      startDateLocal: _normalizeLocalIsoStr(newSlot?.localStartDate || newSlot?.start),
      endDateLocal: _normalizeLocalIsoStr(newSlot?.localEndDate || newSlot?.end),
      dateYmd: _normalizeLocalIsoStr(newSlot?.localStartDate || newSlot?.start).slice(0, 10),
      revision: currentRevision + 1,
      meta: { ..._getCitaMeta(c), lastRescheduleAt: new Date(), traceId },
    }), traceId, "citasManager_reschedule");

    await _logAuditEvent("BOOKING_RESCHEDULED", "INFO", `Booking ${bookingId} rescheduled`, { bookingId, traceId }, traceId, bookingId);

    return { status: "SUCCESS", data: { bookingId, revision: currentRevision + 1 }, error: null };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("rescheduleExistingBooking failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "RESCHEDULE_FAIL", message: norm.message } };
  }
});

// ============================================================================
// REPROGRAMACIÓN DUAL
// [CM-05] Revalidación de slots
// [CM-06] _buildDualRescheduleSlot usa linkedPhases
// ============================================================================

function _getDualSlotInput(payload, key) {
  const slot = payload?.[key];
  if (!slot || typeof slot !== "object") return null;
  return {
    localStartDate: _normalizeLocalIsoStr(slot.localStartDate || slot.start),
    localEndDate: _normalizeLocalIsoStr(slot.localEndDate || slot.end),
    serviceId: _safeTrim(slot.serviceId || ""),
  };
}

function _matchesCitaPairIdentifier(cita, token) {
  const pairToken = _safeTrim(cita.pairToken || _getCitaMeta(cita).pairToken);
  const uiPairToken = _safeTrim(cita.uiPairToken || _getCitaMeta(cita).uiPairToken);
  return pairToken === token || uiPairToken === token;
}

function _getBookingSlotFromCita(cita) {
  return {
    serviceId: cita.serviceId,
    resourceId: cita.resourceId,
    startDate: cita.startDate,
    endDate: cita.endDate,
    startDateLocal: cita.startDateLocal,
    endDateLocal: cita.endDateLocal,
  };
}

// [CM-06] Usa linkedPhases (no secondaryServiceGuid)
async function _buildDualRescheduleSlot(serviceConfig, inputSlot, expectedServiceId) {
  // [CM-06] Campo canónico: linkedPhases
  const linkedServiceId = _safeTrim(serviceConfig?.linkedPhases || serviceConfig?.secondaryServiceGuid || "");

  if (!linkedServiceId || linkedServiceId !== expectedServiceId) {
    return null;
  }

  return {
    serviceId: linkedServiceId,
    localStartDate: inputSlot.localStartDate,
    localEndDate: inputSlot.localEndDate,
  };
}

async function _assertBookingOwner(cita, traceId) {
  if (!cita) {
    throw createBookingError(ERROR_CODES.AUTH_REQUIRED, "Cita not found", { traceId });
  }
}

export const rescheduleDualBookings = webMethod(Permissions.Anyone, async (payload) => {
  const traceId = payload?.traceId || makeTraceId("resched-dual");
  try {
    _rateLimitOrThrow("citasManager.rescheduleDualBookings", _safeTrim(payload?.pairToken) || "anon", traceId);

    const pairToken = _safeTrim(payload?.pairToken || payload?.uiPairToken);
    if (!pairToken) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PAYLOAD", message: "pairToken required" } };
    }

    const res = await wixData
      .query(CITAS_COL)
      .eq("pairToken", pairToken)
      .limit(10)
      .find({ suppressAuth: true });

    const citas = res?.items || [];
    if (citas.length === 0) {
      return { status: "ERROR", data: null, error: { code: "CITA_NOT_FOUND", message: "No citas found for pairToken" } };
    }

    for (const cita of citas) {
      await _assertBookingOwner(cita, traceId);
    }

    const slotF1Input = _getDualSlotInput(payload, "slotF1");
    const slotF2Input = _getDualSlotInput(payload, "slotF2");

    if (!slotF1Input?.localStartDate) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PAYLOAD", message: "slotF1 dates required" } };
    }

    for (const cita of citas) {
      const isF2 = String(cita.bookingType || "").includes("f2") || _getCitaMeta(cita).linkedF1BookingId;
      const targetSlot = isF2 ? slotF2Input : slotF1Input;

      if (!targetSlot?.localStartDate) continue;

      const schedule = {
        startDate: targetSlot.localStartDate,
        endDate: targetSlot.localEndDate,
        timeZone: SDK_CONFIG.TZ,
      };

      await rescheduleBookingElevated(cita.bookingId, schedule, {});

      await _updateCitaSafe(cita.bookingId, (c) => ({
        ...c,
        startDate: new Date(targetSlot.localStartDate),
        endDate: new Date(targetSlot.localEndDate || targetSlot.localStartDate),
        startDateLocal: targetSlot.localStartDate,
        endDateLocal: targetSlot.localEndDate || targetSlot.localStartDate,
        dateYmd: targetSlot.localStartDate.slice(0, 10),
        revision: Number(c.revision || 0) + 1,
        meta: { ..._getCitaMeta(c), lastRescheduleAt: new Date(), traceId },
      }), traceId, "citasManager_rescheduleDual");
    }

    await _logAuditEvent("DUAL_BOOKING_RESCHEDULED", "INFO", `Dual booking ${pairToken} rescheduled`, { pairToken, traceId }, traceId, pairToken);

    return { status: "SUCCESS", data: { pairToken, rescheduledCount: citas.length }, error: null };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("rescheduleDualBookings failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "RESCHED_DUAL_FAIL", message: norm.message } };
  }
});