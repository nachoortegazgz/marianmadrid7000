/*
=============================================================================
MODULE: backend/events.js
VERSION: v5007.0-FINAL
BASE: Modulos optimizados 3 + BIBLIA v5002.5 + DIRECTRICES V19
RESPONSIBILITY: Server-to-server native webhooks for Wix Bookings V2 and
                Wix eCommerce V2 with exact-indexed queries, bounded
                execution, and full idempotency.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED (Rondas 1-3):
  [R2-09] Idempotencia en wixEcom_onOrderCanceled.
  [R2-10] _updateCitaStatus busca por campo bookingId (no _id).
  [R2-13] Sin fallback string en PROCESSED_EVENTS_COL.
  [R2-21] Promise.allSettled para actualizar multiples citas en paralelo.
  [EVENTS-01] Handlers idempotentes mediante registro de eventId.
  [EVENTS-02] Validacion de estructura de eventos entrantes.
  [EVENTS-03] Control de errores y reintentos con backoff.
  [EVENTS-04] Prevencion de efectos duplicados en reservas/pedidos/inventario.
=============================================================================
*/

import wixData from "wix-data";

import {
  makeTraceId,
  _executeWithRetry,
  _normalizeIdPart,
  withTimeout,
  _roundMoney,
} from "public/mmUtils";

import {
  COLLECTIONS,
  APP_IDS,
  TIPO_MOVIMIENTO,
  FORMA_PAGO,
  ESTADO_CITA,
  ESTADO_PAGO,
  CITA_FIELDS,
  SDK_CONFIG,
} from "backend/internalConfig";

import { logger } from "backend/logger";
import { normalizeError, _updateCitaSafe } from "backend/booking/bookingCore";
import { registerBookingPayment, queueFiscalRecovery } from "backend/cajas.web";
import {
  recordOnlineInventoryOrderInternal,
  recordOnlineInventoryRefundInternal,
} from "backend/inventario.web";

const log = logger;

const WEBHOOK_RETRIES = Number(SDK_CONFIG?.EVENTS?.RETRY_ATTEMPTS) || 3;
const WEBHOOK_RETRY_DELAY_MS = Number(SDK_CONFIG?.EVENTS?.RETRY_BASE_BACKOFF_MS) || 1000;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

function _normalizeBookingIds(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(values.map((id) => String(id || "").trim()).filter(Boolean)));
}

// [R2-13] Sin fallback string
const PROCESSED_EVENTS_COL = COLLECTIONS.MM_PROCESSED_EVENTS;
const EVENT_TTL_HOURS = 72;

// ============================================================================
// EVENT STRUCTURE VALIDATION
// ============================================================================

function validateEventStructure(event, requiredFields) {
  if (!event || typeof event !== "object") {
    log.warn("EVENT_INVALID_STRUCTURE", { hasEvent: !!event });
    return false;
  }
  for (const field of requiredFields) {
    const value = field.split(".").reduce((obj, key) => obj?.[key], event);
    if (value === undefined || value === null) {
      log.warn("EVENT_MISSING_FIELD", { field, eventId: event.eventId || event._id });
      return false;
    }
  }
  return true;
}

// ============================================================================
// IDEMPOTENCY
// ============================================================================

async function isEventProcessed(eventId) {
  if (!eventId) { return false; }
  const normalizedId = _normalizeIdPart(String(eventId), 100);
  const existing = await wixData.get(PROCESSED_EVENTS_COL, normalizedId, { suppressAuth: true })
    .catch(() => null);
  return !!existing;
}

async function markEventAsProcessed(eventId, eventType, traceId, metadata = {}) {
  if (!eventId) { return; }
  const normalizedId = _normalizeIdPart(String(eventId), 100);
  const expiryDate = new Date(Date.now() + EVENT_TTL_HOURS * 3600 * 1000);
  try {
    await wixData.insert(PROCESSED_EVENTS_COL, {
      _id: normalizedId,
      eventId: String(eventId),
      eventType,
      traceId,
      processedAt: new Date(),
      expiresAt: expiryDate,
      metadata,
      status: "PROCESSED",
    }, { suppressAuth: true });
    log.debug("EVENT_MARKED_PROCESSED", { eventId, eventType });
  } catch (err) {
    log.debug("EVENT_INSERT_CONFLICT", { eventId, error: err.message });
  }
}

// ============================================================================
// ERROR HANDLING & AUDIT
// ============================================================================

function _handleError(error, context, traceId) {
  const normalized = normalizeError(error);
  log.error(`Error in ${context}`, { error: normalized.message, traceId });
  return { code: normalized.code, message: normalized.message };
}

async function _logAuditEvent(tipoEvento, level, message, data = {}, traceId, entityId = "system") {
  try {
    const safeEntity = _normalizeIdPart(entityId, 40);
    const safeTrace = _normalizeIdPart(traceId, 40);
    const logId = `AUDIT_${_normalizeIdPart(tipoEvento, 30)}_${safeEntity}_${safeTrace}`;
    await withTimeout(
      wixData.insert(
        COLLECTIONS.MM_AUDIT_LOG, {
          _id: logId,
          eventType: tipoEvento,
          level,
          message,
          data,
          resourceId: "SYSTEM",
          source: "backend/events.js",
          loggedAt: new Date(),
          traceId,
        }, { suppressAuth: true }
      ).catch(() => null),
      API_TIMEOUT_MS,
      "logAuditEvent"
    );
  } catch (err) {
    log.error("Failed to write to AUDIT_LOG", { error: err?.message || String(err), traceId });
  }
}

// ============================================================================
// CITA STATUS UPDATES
// [R2-10] _updateCitaSafe busca por campo bookingId (no _id)
// [R2-21] Promise.allSettled para multiples citas
// ============================================================================

async function _updateCitaStatus(bookingId, nuevoEstado, traceId) {
  await _updateCitaSafe(bookingId, (cita) => {
    if (String(cita[CITA_FIELDS.STATUS] || "").toUpperCase() === String(nuevoEstado || "").toUpperCase()) {
      return null;
    }
    return {
      ...cita,
      [CITA_FIELDS.STATUS]: String(nuevoEstado || ESTADO_CITA.CONFIRMED).toUpperCase(),
    };
  }, traceId, "events_updateCitaEstado");
}

async function _markCitasRefundedByBookingIds(bookingIds, orderId, refundId, fullyRefunded, traceId) {
  const ids = _normalizeBookingIds(bookingIds);
  // [R2-21] Promise.allSettled para paralelismo
  const results = await Promise.allSettled(
    ids.map((bookingId) =>
      _updateCitaSafe(bookingId, (cita) => {
        const meta = cita.meta || {};
        const paymentState = fullyRefunded ? ESTADO_PAGO.REFUNDED : ESTADO_PAGO.PARTIALLY_REFUNDED;
        return {
          ...cita,
          ...(fullyRefunded ? { [CITA_FIELDS.STATUS]: ESTADO_CITA.REFUNDED } : {}),
          [CITA_FIELDS.STATUS_PAGO]: paymentState,
          meta: {
            ...meta,
            [CITA_FIELDS.STATUS_PAGO]: paymentState,
            orderId: orderId || null,
            refundId: refundId || null,
            fechaReembolso: new Date(),
          },
        };
      }, traceId, "events_markRefunded")
    )
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    log.warn("Some citas failed to update refund status", {
      traceId, orderId, totalIds: ids.length, failedCount: failures.length,
    });
  }
}

async function _markCitasPaidByBookingIds(bookingIds, orderId, traceId) {
  const ids = _normalizeBookingIds(bookingIds);
  // [R2-21] Promise.allSettled para paralelismo
  const results = await Promise.allSettled(
    ids.map((bookingId) =>
      _updateCitaSafe(bookingId, (cita) => {
        const meta = cita.meta || {};
        const alreadyPaid = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase() === ESTADO_PAGO.PAID;
        if (alreadyPaid) { return null; }
        return {
          ...cita,
          [CITA_FIELDS.STATUS]: ESTADO_CITA.CONFIRMED,
          [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
          meta: {
            ...meta,
            [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PAID,
            orderId: orderId || null,
            fechaConfirmacionPago: new Date(),
          },
        };
      }, traceId, "events_markPaid")
    )
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    log.warn("Some citas failed to update payment status", {
      traceId, orderId, totalIds: ids.length, failedCount: failures.length,
    });
  }
}

async function _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId) {
  const ids = _normalizeBookingIds(bookingIds);
  const results = await Promise.allSettled(
    ids.map((bookingId) =>
      _updateCitaSafe(bookingId, (cita) => {
        const meta = cita.meta || {};
        const currentPaymentState = String(meta.paymentStatus || cita.paymentStatus || "").toUpperCase();
        if (currentPaymentState === ESTADO_PAGO.PAID) { return null; }
        return {
          ...cita,
          [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PENDING_LEDGER,
          meta: {
            ...meta,
            [CITA_FIELDS.STATUS_PAGO]: ESTADO_PAGO.PENDING_LEDGER,
            orderId: orderId || null,
            fechaPagoRecibido: new Date(),
          },
        };
      }, traceId, "events_markPendingLedger")
    )
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    log.warn("Some citas failed to update pending ledger status", {
      traceId, orderId, totalIds: ids.length, failedCount: failures.length,
    });
  }
}

// ============================================================================
// WEBHOOK: BOOKING CONFIRMED
// ============================================================================

export async function wixBookingsV2_onBookingConfirmed(event) {
  const traceId = makeTraceId("whook-conf");
  try {
    const eventId = event?.eventId || event?._id || `conf-${event?.booking?.id || Date.now()}`;
    const alreadyProcessed = await isEventProcessed(eventId);
    if (alreadyProcessed) {
      log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "BOOKING_CONFIRMED" });
      return { status: "OK", duplicate: true };
    }

    const valid = validateEventStructure(event, ["booking.id", "booking.status"]);
    if (!valid) {
      log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
      await markEventAsProcessed(eventId, "BOOKING_CONFIRMED_INVALID", traceId, { rejected: true });
      return { status: "OK", rejected: true };
    }

    const booking = event?.booking || event?.entity || {};
    const bookingId = booking?.id || booking?._id || "unknown";
    await _updateCitaStatus(bookingId, ESTADO_CITA.CONFIRMED, traceId);
    await markEventAsProcessed(eventId, "BOOKING_CONFIRMED", traceId, { bookingId });
    return { status: "OK", eventId };
  } catch (error) {
    _handleError(error, "wixBookingsV2_onBookingConfirmed", traceId);
    return { status: "OK" };
  }
}

// ============================================================================
// WEBHOOK: BOOKING CANCELED
// ============================================================================

export async function wixBookingsV2_onBookingCanceled(event) {
  const traceId = makeTraceId("whook-cancel");
  try {
    const eventId = event?.eventId || event?._id || `cancel-${event?.booking?.id || Date.now()}`;
    const alreadyProcessed = await isEventProcessed(eventId);
    if (alreadyProcessed) {
      log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "BOOKING_CANCELED" });
      return { status: "OK", duplicate: true };
    }

    const valid = validateEventStructure(event, ["booking.id"]);
    if (!valid) {
      log.warn("EVENT_INVALID_STRUCTURE_REJECTED", { eventId });
      await markEventAsProcessed(eventId, "BOOKING_CANCELED_INVALID", traceId, { rejected: true });
      return { status: "OK", rejected: true };
    }

    const booking = event?.booking || event?.entity || {};
    const bookingId = booking?.id || booking?._id || "unknown";
    await _updateCitaStatus(bookingId, ESTADO_CITA.CANCELED, traceId);
    await markEventAsProcessed(eventId, "BOOKING_CANCELED", traceId, { bookingId });
    return { status: "OK", eventId };
  } catch (error) {
    _handleError(error, "wixBookingsV2_onBookingCanceled", traceId);
    return { status: "OK" };
  }
}

// ============================================================================
// WEBHOOK: ORDER PAYMENT STATUS UPDATED
// ============================================================================

export async function wixEcom_onOrderPaymentStatusUpdated(event) {
  const traceId = makeTraceId("whook-pay-status");
  try {
    const order = event?.order || event?.data?.order || event?.entity || event || {};
    const orderId = String(order?._id || order?.id || "").trim();
    if (!orderId || orderId === "unknown") { return { status: "OK" }; }

    const paymentStatusRaw = order.paymentStatus || "";
    const paymentStatus = String(paymentStatusRaw).toUpperCase();
    const isPaidStatus = ["PAID", "FULLY_PAID", "PAID_FULL"].includes(paymentStatus);
    if (!isPaidStatus) { return { status: "OK" }; }

    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

    await recordOnlineInventoryOrderInternal(order, traceId).catch((inventoryError) => {
      log.error("Online inventory mirror failed", {
        orderId, traceId, error: inventoryError?.message || String(inventoryError),
      });
    });

    const bookingsAppId = APP_IDS.BOOKINGS;
    const bookingLineItems = lineItems.filter((item) => item?.catalogReference?.appId === bookingsAppId);
    const bookingIds = _normalizeBookingIds(bookingLineItems.map((item) => item?.catalogReference?.catalogItemId));
    const linkedBookingIds = bookingIds.join(",");

    const orderTotal = Number(order?.priceSummary?.total?.amount ?? order?.totals?.total?.amount ?? 0) || 0;
    const lineItemsTotal = lineItems.reduce((sum, item) => {
      const itemPrice = Number(item?.price?.amount ?? item?.price ?? item?.totalPrice?.amount ?? 0) || 0;
      return sum + (itemPrice * (Number(item?.quantity) || 1));
    }, 0);
    const finalLedgerAmount = orderTotal > 0 ? orderTotal : lineItemsTotal;
    const transactionId = `ORDER-${orderId}`;

    const existingLedgerRes = await withTimeout(
      wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", transactionId).limit(1).find({ suppressAuth: true, consistentRead: true }),
      API_TIMEOUT_MS,
      "checkExistingLedgerPreflight"
    ).catch(() => ({ items: [] }));

    if (existingLedgerRes?.items?.length > 0) {
      if (bookingIds.length) {
        await _executeWithRetry(async () => {
          await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
        }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
      }
      return { status: "OK" };
    }

    if (bookingIds.length) {
      await _executeWithRetry(async () => {
        await _markCitasPendingLedgerByBookingIds(bookingIds, orderId, traceId);
      }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
    }

    if (finalLedgerAmount <= 0) {
      if (bookingIds.length) {
        await _executeWithRetry(async () => {
          await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
        }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
      }
      return { status: "OK" };
    }

    const orderConcept = bookingIds.length > 0 ?
      (lineItems.length > bookingIds.length ? `Pedido Mixto Cita + Tienda ${orderId}` : `Reserva Online ${orderId}`) :
      `Venta Online Tienda ${orderId}`;

    const ledgerRes = await registerBookingPayment(
      linkedBookingIds || null,
      finalLedgerAmount,
      FORMA_PAGO.ONLINE, {
        concept: orderConcept,
        resourceId: "online",
        traceId,
        transactionId,
        orderId: orderId,
        origen: "WIX_ECOM_PAYMENT_WEBHOOK",
        tipoMovimiento: TIPO_MOVIMIENTO.VENTA_ONLINE,
      }
    );

    if (ledgerRes?.status === "SUCCESS") {
      if (bookingIds.length) {
        await _executeWithRetry(async () => {
          await _markCitasPaidByBookingIds(bookingIds, orderId, traceId);
        }, WEBHOOK_RETRIES, WEBHOOK_RETRY_DELAY_MS);
      }
      return { status: "OK" };
    }

    await queueFiscalRecovery({
      bookingIds: linkedBookingIds,
      amount: finalLedgerAmount,
      paymentMethod: FORMA_PAGO.ONLINE,
      transactionId,
      orderId,
      origin: "WIX_ECOM_PAYMENT_WEBHOOK",
      concept: orderConcept,
      resourceId: "online",
      tipoMovimiento: TIPO_MOVIMIENTO.VENTA_ONLINE,
      traceId,
      lastError: ledgerRes?.error?.message || "LEDGER_REGISTRATION_FAILED",
    });

    await _logAuditEvent(
      "LEDGER_REGISTRATION_FAILED", "ERROR",
      `Ledger registration queued for order ${orderId}`,
      { orderId, bookingIds, ledgerError: ledgerRes?.error || "Unknown error", traceId },
      traceId, orderId
    );

    return { status: "OK" };
  } catch (error) {
    const normalized = _handleError(error, "wixEcom_onOrderPaymentStatusUpdated", traceId);
    await _logAuditEvent(
      "WEBHOOK_CRITICAL_ERROR", "ERROR",
      `Critical error in webhook: ${normalized.message}`,
      { error: normalized.message, traceId },
      traceId
    );
    return { status: "OK" };
  }
}

// ============================================================================
// WEBHOOK: ORDER REFUNDED
// ============================================================================

export async function wixEcom_onOrderRefunded(event) {
  const traceId = makeTraceId("whook-refund");
  try {
    const orderId = String(event?.orderId || event?.order?._id || "").trim() || "unknown";
    const refundObj = event?.refund || event?.data?.refund || null;
    if (!refundObj || orderId === "unknown") { return { status: "OK" }; }

    const rawAmount = typeof refundObj?.amount === "object" && refundObj?.amount !== null ?
      refundObj.amount.amount : refundObj?.amount ?? 0;
    const refundAmount = Number(rawAmount) || 0;
    if (refundAmount <= 0) { return { status: "OK" }; }

    const refundId = String(refundObj?._id || refundObj?.id || "").trim();
    if (!refundId) {
      await _logAuditEvent("REFUND_ID_MISSING", "ERROR", `Refund without stable identifier for order ${orderId}`, { orderId, traceId }, traceId, orderId);
      return { status: "OK" };
    }

    const transactionId = `REFUND-${orderId}-${refundId}`;
    const originalTransactionId = `ORDER-${orderId}`;

    const originalMovementRes = await withTimeout(
      wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA).eq("transactionId", originalTransactionId).limit(1).find({ suppressAuth: true, consistentRead: true }),
      API_TIMEOUT_MS,
      "queryOriginalMovement"
    ).catch(() => ({ items: [] }));

    const originalMovement = originalMovementRes.items?.[0];
    if (!originalMovement) {
      await queueFiscalRecovery({
        bookingIds: "", amount: -refundAmount, paymentMethod: FORMA_PAGO.ONLINE,
        transactionId, orderId, refundId,
        origin: "WIX_ECOM_REFUND_WEBHOOK", concept: `Refund - Order ${orderId}`,
        resourceId: "online", tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
        phase: "WAIT_FOR_ORIGINAL_ORDER_LEDGER", traceId,
        lastError: "ORIGINAL_ORDER_LEDGER_MISSING",
      });
      await _logAuditEvent("REFUND_WAITING_FOR_ORIGINAL_LEDGER", "ERROR", `Refund queued before original ledger for order ${orderId}`, { orderId, refundId, traceId }, traceId, orderId);
      return { status: "OK" };
    }

    const originalAmount = Number(originalMovement.totalAmount || 0);
    const linkedBookingIds = _normalizeBookingIds(originalMovement.reservaIdVinculada || originalMovement.reservationIdLinked);

    const refundRestockInfo = event?.sideEffects?.restockInfo || event?.data?.sideEffects?.restockInfo || refundObj?.sideEffects?.restockInfo || null;
    const refundOrder = event?.order || event?.data?.order || { _id: orderId, lineItems: event?.lineItems || event?.data?.lineItems || [] };

    try {
      const inventoryRefund = await recordOnlineInventoryRefundInternal(refundOrder, refundObj, refundRestockInfo, traceId);
      if (inventoryRefund?.status === "SKIPPED" && inventoryRefund?.reason !== "NO_CONFIRMED_RESTOCK") {
        await _logAuditEvent("REFUND_INVENTORY_TRACE_SKIPPED", "WARN", `Inventory trace skipped for refund ${refundId}`, { orderId, refundId, reason: inventoryRefund.reason, traceId }, traceId, orderId);
      }
    } catch (inventoryRefundError) {
      await _logAuditEvent("REFUND_INVENTORY_TRACE_FAILED", "ERROR", `Inventory trace failed for refund ${refundId}`, { orderId, refundId, error: inventoryRefundError?.message || String(inventoryRefundError), traceId }, traceId, orderId);
    }

    const ledgerRes = await registerBookingPayment(
      linkedBookingIds.join(",") || null,
      -refundAmount,
      FORMA_PAGO.ONLINE, {
        concept: `Refund - Order ${orderId}`, resourceId: "online", traceId,
        transactionId, orderId, refundId,
        origen: "WIX_ECOM_REFUND_WEBHOOK", tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO,
      }
    );

    if (ledgerRes?.status === "SUCCESS") {
      await _markCitasRefundedByBookingIds(linkedBookingIds, orderId, refundId, false, traceId);
    } else {
      await queueFiscalRecovery({
        bookingIds: linkedBookingIds.join(","), amount: -refundAmount,
        paymentMethod: FORMA_PAGO.ONLINE, transactionId, orderId, refundId,
        origin: "WIX_ECOM_REFUND_WEBHOOK", concept: `Refund - Order ${orderId}`,
        resourceId: "online", tipoMovimiento: TIPO_MOVIMIENTO.REEMBOLSO, traceId,
        lastError: ledgerRes?.error?.message || "REFUND_LEDGER_REGISTRATION_FAILED",
      });
      await _logAuditEvent("REFUND_LEDGER_REGISTRATION_FAILED", "ERROR", `Refund ledger queued for order ${orderId}`, { orderId, refundId, traceId }, traceId, orderId);
      return { status: "OK" };
    }

    const refundsRes = await withTimeout(
      wixData.query(COLLECTIONS.MOVIMIENTOS_CAJA)
        .eq("orderId", orderId)
        .eq("movementType", TIPO_MOVIMIENTO.REEMBOLSO)
        .limit(100)
        .find({ suppressAuth: true, consistentRead: true }),
      API_TIMEOUT_MS,
      "queryRefundsForOrder"
    );

    const refundedTotal = (refundsRes?.items || []).reduce(
      (sum, movement) => sum + Math.abs(Number(movement?.accountingAmount || movement?.totalAmount || 0)), 0
    );
    const fullyRefunded = originalAmount > 0 && refundedTotal >= originalAmount;
    await _markCitasRefundedByBookingIds(linkedBookingIds, orderId, refundId, fullyRefunded, traceId);

    return { status: "OK" };
  } catch (error) {
    _handleError(error, "wixEcom_onOrderRefunded", traceId);
    return { status: "OK" };
  }
}

// ============================================================================
// WEBHOOK: ORDER CANCELED
// [R2-09] Idempotencia anadida
// ============================================================================

export async function wixEcom_onOrderCanceled(event) {
  const traceId = makeTraceId("whook-order-cancel");
  try {
    const order = event?.order || event?.data?.order || event || {};
    const orderId = String(order?._id || order?.id || "").trim() || "unknown";
    if (orderId === "unknown") { return { status: "OK" }; }

    // [R2-09] Idempotencia
    const eventId = event?.eventId || event?._id || `cancel-order-${orderId}`;
    const alreadyProcessed = await isEventProcessed(eventId);
    if (alreadyProcessed) {
      log.info("EVENT_DUPLICATE_IGNORED", { eventId, eventType: "ORDER_CANCELED" });
      return { status: "OK", duplicate: true };
    }

    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
    const bookingsAppId = APP_IDS.BOOKINGS;
    const bookingIds = _normalizeBookingIds(
      lineItems
        .filter((item) => item?.catalogReference?.appId === bookingsAppId)
        .map((item) => item?.catalogReference?.catalogItemId)
    );

    for (const bId of bookingIds) {
      await _updateCitaStatus(bId, ESTADO_CITA.CANCELED, traceId);
    }

    // [R2-09] Marcar como procesado
    await markEventAsProcessed(eventId, "ORDER_CANCELED", traceId, { orderId, bookingIds });

    return { status: "OK", eventId };
  } catch (error) {
    _handleError(error, "wixEcom_onOrderCanceled", traceId);
    return { status: "OK" };
  }
}