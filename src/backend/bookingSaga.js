/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5007.4-FINAL (FIX A5 y FIX E-34 aplicados)
BASE: BIBLIA v5002.5 Bloque 12.3 + MOTOR DE RESERVAS + DIRECTRICES V19
RESPONSIBILITY: Orquestador transaccional. Implementa el patron Saga con
                compensaciones para reservas simples y duales. Gestiona locks,
                heartbeat, idempotencia y creacion paralela F1+F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Nomenclatura v19.6: serviceId, linkedPhases, resourceId.
CORRECTIONS APPLIED:
  [FIX A5] Importacion y re-export correcto de _extractCheckoutId.
  [SAGA-01] linkedPhases como fuente primaria de F2.
  [SAGA-02] Idempotencia triple capa: pairToken + BookingTransactions + CitasF2.
  [SAGA-03] Locks con heartbeat cada 15s.
  [SAGA-04] Compensacion: cancelBookingElevated + CompensacionesPendientes.
  [SAGA-05] Revalidacion en tiempo real antes de locks (skipCache: true).
  [SAGA-06] Jitter de 400-1000ms en F2 para reducir contencion API.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";

import { logger } from "backend/logger";

import {
  COLLECTIONS,
  CONCURRENCY,
  SDK_CONFIG,
  CITA_FIELDS,
  ESTADO_CITA,
  ESTADO_PAGO,
  FORMA_PAGO,
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _looksLikeGuid,
  _stableSerialize,
  _hashKey,
  _generateUUID,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  _normalizeLocalIsoStr,
  withTimeout,
  _executeWithRetry,
} from "public/mmUtils";

import {
  createBookingElevated,
  cancelBookingElevated,
  confirmOrDeclineBookingElevated,
  createCheckoutElevated,
  getCheckoutUrlElevated,
  _lockSlotKeyOrFail,
  _unlockSlotKey,
  _renewLock,
  _initTransaction,
  _completeTransaction,
  _failTransaction,
  _persistBooking,
  _forceStaffInPristineSlot,
  _buildLockKeys,
  _getDualPairFromCache,
  createBookingError,
  normalizeError,
  _handleError,
  ERROR_CODES,
  _updateCitaSafe,
  _extractCheckoutId, // [FIX A5] Añadido a la importación para evitar no-undef
} from "backend/booking/bookingCore";

// [FIX A5] Re-export de _extractCheckoutId para cumplir BIBLIA 12.3
export { _extractCheckoutId };

import {
  _resolveServiceIdInternal,
  _invalidateCachesInternal,
  _listTimeSlotsV2,
  _resolveStaffForSlotInternal,
} from "backend/reservas.web";

const log = logger;

const LOCK_TTL_MS = Number(CONCURRENCY?.MUTEX_TTL_MS) || 300000;
const HEARTBEAT_MS = Number(CONCURRENCY?.HEARTBEAT_MS) || 15000;
const CITAS_COL = COLLECTIONS.CITAS_F2;
const COMPENSACIONES_COL = COLLECTIONS.COMPENSACIONES_PENDIENTES;

// =============================================================================
// BLOQUE 1 — PAIR TOKEN DETERMINISTA
// =============================================================================

function _resolveStablePairToken({ serviceId, resourceId, f1Start, f2Start, email, existingPairToken }) {
  const existing = _safeTrim(existingPairToken);
  if (existing) return existing;

  const emailHash = _hashKey(_safeTrim(email).toLowerCase());
  const payload = _stableSerialize({
    serviceId: _safeTrim(serviceId),
    resourceId: _safeTrim(resourceId),
    f1Start: _safeTrim(f1Start),
    f2Start: _safeTrim(f2Start || ""),
  });
  const hash = _hashKey(`${payload}|${emailHash}`);
  return `pt_${hash.slice(0, 32)}`;
}

// =============================================================================
// BLOQUE 2 — NORMALIZACION DE META PERSISTIDA
// =============================================================================

export function _normalizePersistedMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  try {
    if (typeof meta === "string") return JSON.parse(meta);
    return meta;
  } catch (_) {
    return {};
  }
}

// =============================================================================
// BLOQUE 3 — LIBERACION DE LOCKS (BEST EFFORT)
// =============================================================================

async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
  for (const key of lockKeys || []) {
    try {
      await _unlockSlotKey(key, lockOwnerId);
    } catch (e) {
      log.warn("_bestEffortUnlockAll: failed to unlock", { key, error: e?.message });
    }
  }
}

// =============================================================================
// BLOQUE 4 — COMPENSACION DE BOOKINGS CREADOS
// =============================================================================

async function _compensateCreatedBookings(createdBookings, traceId) {
  for (const booking of createdBookings || []) {
    const bookingId = booking?.bookingId || booking?.id;
    if (!bookingId) continue;
    try {
      await cancelBookingElevated(bookingId, { suppressAuth: true });
      log.info("Compensated booking cancelled", { bookingId, traceId });
    } catch (cancelErr) {
      log.error("Compensation cancel failed; queuing", { bookingId, traceId, error: cancelErr?.message });
      try {
        await wixData.insert(COMPENSACIONES_COL, {
          _id: `COMP_${bookingId}_${Date.now()}`,
          kind: "BOOKING_CANCEL",
          bookingId,
          phase: booking?.phase || "UNKNOWN",
          status: "PENDING",
          attempts: 0,
          amount: 0,
          paymentMethod: null,
          transactionId: null,
          orderId: null,
          refundId: null,
          concept: "Compensacion de booking fallido",
          movementType: null,
          alertRequired: true,
          lastError: cancelErr?.message || "UNKNOWN",
          traceId,
          _createdDate: new Date(),
          _updatedDate: new Date(),
        }, { suppressAuth: true });
      } catch (queueErr) {
        log.error("Failed to queue compensation", { bookingId, traceId, error: queueErr?.message });
      }
    }
  }
}

// =============================================================================
// BLOQUE 5 — SAGA ORCHESTRATOR
// =============================================================================

export class BookingSagaOrchestrator {
  constructor(traceId) {
    this.traceId = traceId;
    this.steps = [];
    this.completedSteps = [];
  }

  addStep(name, executeFn, compensateFn) {
    this.steps.push({ name, executeFn, compensateFn });
  }

  async execute() {
    for (const step of this.steps) {
      try {
        log.info(`Saga step: ${step.name}`, { traceId: this.traceId });
        const result = await step.executeFn();
        this.completedSteps.push({ ...step, result });
      } catch (error) {
        log.error(`Saga step failed: ${step.name}`, { traceId: this.traceId, error: error?.message });
        await this._compensate();
        throw error;
      }
    }
    return this.completedSteps.map((s) => s.result);
  }

  async _compensate() {
    const reversed = [...this.completedSteps].reverse();
    for (const step of reversed) {
      if (step.compensateFn) {
        try {
          log.info(`Saga compensating: ${step.name}`, { traceId: this.traceId });
          await step.compensateFn(step.result);
        } catch (compErr) {
          log.error(`Saga compensation failed: ${step.name}`, { traceId: this.traceId, error: compErr?.message });
        }
      }
    }
  }
}

// =============================================================================
// BLOQUE 6 — EXECUTE BOOKING SAGA (FUNCION PRINCIPAL)
// =============================================================================

export async function executeBookingSaga(unsafePayload) {
  const traceId = unsafePayload?.traceId || makeTraceId("saga");
  const metaCita = _normalizePersistedMeta(unsafePayload?.metaCita || unsafePayload?.meta || {});

  try {
    // =========================================================================
    // FASE 0: VALIDACION Y RESOLUCION
    // =========================================================================

    const email = _safeTrim(unsafePayload?.email || metaCita.email || unsafePayload?.contactDetails?.email);
    if (!email) {
      throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Email is required", { traceId });
    }

    const rawServiceId = _safeTrim(
      unsafePayload?.serviceId ||
      metaCita.serviceId ||
      unsafePayload?.primaryServiceId ||
      metaCita.primaryServiceId ||
      unsafePayload?.primaryServiceGuid ||
      metaCita.primaryServiceGuid
    );
    const serviceId = await _resolveServiceIdInternal(rawServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
      throw createBookingError(ERROR_CODES.SERVICE_NOT_FOUND, "Service not found", { traceId, rawServiceId });
    }

    const serviceRes = await import("backend/reservas.web").then((m) => m._getServiceBySlugOrIdInternal(serviceId, traceId));
    const serviceConfig = serviceRes?.data || {};
    const isDual = serviceConfig.allowCombine === true && !!serviceConfig.linkedPhases;

    const linkedPhases = isDual ? serviceConfig.linkedPhases : null;

    const requestedResourceId = _safeTrim(unsafePayload?.resourceId || metaCita.resourceId);
    const slotF1Input = unsafePayload?.slotF1 || {};
    const slotF2Input = unsafePayload?.slotF2 || {};

    const f1LocalStart = _normalizeLocalIsoStr(slotF1Input.localStartDate || slotF1Input.start || metaCita.f1Start);
    const f1LocalEnd = _normalizeLocalIsoStr(slotF1Input.localEndDate || slotF1Input.end || metaCita.f1End);

    if (!f1LocalStart || !f1LocalEnd) {
      throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "F1 slot dates are required", { traceId });
    }

    let f2LocalStart = "";
    let f2LocalEnd = "";
    if (isDual) {
      f2LocalStart = _normalizeLocalIsoStr(slotF2Input.localStartDate || slotF2Input.start || metaCita.f2Start);
      f2LocalEnd = _normalizeLocalIsoStr(slotF2Input.localEndDate || slotF2Input.end || metaCita.f2End);

      if (!f2LocalStart) {
        const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
        const exposureMs = Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
        const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
        const phase2Ms = Math.max(0, Number(serviceConfig.phase2Duration || 30)) * 60 * 1000;
        const f2EndUtc = new Date(f2StartUtc.getTime() + phase2Ms);
        f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
        f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
      }
    }

    const pairToken = _resolveStablePairToken({
      serviceId,
      resourceId: requestedResourceId,
      f1Start: f1LocalStart,
      f2Start: f2LocalStart,
      email,
      existingPairToken: unsafePayload?.pairToken || metaCita.pairToken,
    });

    // =========================================================================
    // FASE 1: VERIFICAR IDEMPOTENCIA EN CITAS_F2
    // =========================================================================

    const existingCitaRes = await wixData
      .query(CITAS_COL)
      .eq("pairToken", pairToken)
      .limit(1)
      .find({ suppressAuth: true, suppressHooks: true })
      .catch(() => ({ items: [] }));

    if (existingCitaRes?.items?.length > 0) {
      const existingCita = existingCitaRes.items[0];
      const existingPaymentStatus = String(
        existingCita[CITA_FIELDS.STATUS_PAGO] ||
        existingCita.meta?.paymentStatus ||
        existingCita.estadoPago ||
        ""
      ).toUpperCase();

      if (existingPaymentStatus === ESTADO_PAGO.PENDING_PAYMENT) {
        log.info("Idempotent duplicate: PENDING_PAYMENT, returning existing checkout", { pairToken, traceId });
        return {
          status: "SUCCESS",
          data: {
            requiresPayment: true,
            checkoutUrl: existingCita.meta?.checkoutUrl || null,
            pairToken,
            idempotent: true,
          },
          error: null,
        };
      }

      log.info("Idempotent duplicate: existing cita found", { pairToken, traceId, status: existingCita.status });
      return {
        status: "SUCCESS",
        data: {
          bookingId: existingCita.bookingId,
          pairToken,
          status: existingCita.status,
          idempotent: true,
        },
        error: null,
      };
    }

    // =========================================================================
    // FASE 2: INICIALIZAR TRANSACCION EN BOOKING_TRANSACTIONS
    // =========================================================================

    const payloadHash = _hashKey(_stableSerialize({
      serviceId,
      resourceId: requestedResourceId,
      f1LocalStart,
      f1LocalEnd,
      f2LocalStart,
      f2LocalEnd,
      email,
    }));

    const txResult = await _initTransaction(pairToken, payloadHash, traceId);
    if (!txResult.success) {
      if (txResult.error === "PAIR_TOKEN_PAYLOAD_MISMATCH") {
        throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Payload mismatch for existing pairToken", { traceId });
      }
      if (txResult.error === "TRANSACTION_PREVIOUSLY_FAILED") {
        throw createBookingError(ERROR_CODES.BOOKING_CREATION_FAILED, "Previous transaction failed", { traceId });
      }
      if (txResult.existing?.status === "COMPLETED") {
        return { status: "SUCCESS", data: txResult.existing.result, error: null, idempotent: true };
      }
      throw createBookingError(ERROR_CODES.TOKEN_BUSY, "Transaction in progress or timeout", { traceId });
    }

    // =========================================================================
    // FASE 3: REVALIDACION EN TIEMPO REAL
    // =========================================================================

    const resourceValidation = await _resolveStaffForSlotInternal({
      serviceId,
      f1Start: f1LocalStart,
      f1End: f1LocalEnd,
      f2Start: isDual ? f2LocalStart : null,
      f2End: isDual ? f2LocalEnd : null,
      requestedResourceId: requestedResourceId || null,
      traceId,
    });

    if (resourceValidation?.status !== "SUCCESS") {
      await _failTransaction(pairToken, resourceValidation?.error?.code || "SLOT_UNAVAILABLE");
      throw createBookingError(
        resourceValidation?.error?.code || ERROR_CODES.SLOT_UNAVAILABLE,
        resourceValidation?.error?.message || "Slot no longer available",
        { traceId }
      );
    }

    const finalResourceId = resourceValidation.data.resourceId;
    const validatedSlotF1 = resourceValidation.data.slotF1;
    const validatedSlotF2 = resourceValidation.data.slotF2;

    // =========================================================================
    // FASE 4: ADQUIRIR LOCKS + HEARTBEAT
    // =========================================================================

    const phases = [{ rawSlot: { ...validatedSlotF1, serviceId }, localStart: f1LocalStart, localEnd: f1LocalEnd }];
    if (isDual && f2LocalStart) {
      phases.push({ rawSlot: { serviceId: linkedPhases }, localStart: f2LocalStart, localEnd: f2LocalEnd });
    }

    const lockKeys = _buildLockKeys(phases, finalResourceId);
    const lockOwnerId = pairToken;
    let heartbeatInterval = null;

    const saga = new BookingSagaOrchestrator(traceId);
    const createdBookings = [];

    saga.addStep(
      "LockSlots",
      async () => {
        for (const lockKey of lockKeys) {
          const lockResult = await _lockSlotKeyOrFail(lockKey, lockOwnerId, LOCK_TTL_MS);
          if (!lockResult?.ok) {
            throw createBookingError(ERROR_CODES.TOKEN_BUSY, `Lock failed: ${lockResult?.message}`, { traceId, lockKey });
          }
        }

        heartbeatInterval = setInterval(() => {
          lockKeys.forEach((key) => _renewLock(key, lockOwnerId, LOCK_TTL_MS).catch(() => {}));
        }, HEARTBEAT_MS);

        return { lockKeys };
      },
      async () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        await _bestEffortUnlockAll(lockKeys, lockOwnerId);
      }
    );

    saga.addStep(
      "CreateBookings",
      async () => {
        const pristineF1 = await _forceStaffInPristineSlot(validatedSlotF1, finalResourceId, serviceId, serviceConfig.phase1Duration);
        if (!pristineF1) {
          throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Failed to build pristine slot F1", { traceId });
        }

        const contactDetails = {
          firstName: _safeTrim(unsafePayload?.firstName || metaCita.firstName || ""),
          lastName: _safeTrim(unsafePayload?.lastName || metaCita.lastName || ""),
          email,
          phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
        };

        const f1Payload = {
          serviceId,
          bookedEntity: { slot: pristineF1 },
          contactDetails,
          options: { flowControlSettings: { skipAvailabilityValidation: false } },
        };

        let bookingF1 = null;
        let bookingF2 = null;

        if (isDual && f2LocalStart && validatedSlotF2) {
          const createF1 = async () => {
            const res = await createBookingElevated(f1Payload);
            bookingF1 = res?.booking || res;
            createdBookings.push({ bookingId: bookingF1?.id || bookingF1?._id, phase: "F1" });
            return bookingF1;
          };

          const createF2 = async () => {
            await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));

            const pristineF2 = await _forceStaffInPristineSlot(validatedSlotF2, finalResourceId, linkedPhases, serviceConfig.phase2Duration);
            if (!pristineF2) {
              throw createBookingError(ERROR_CODES.INVALID_PAYLOAD, "Failed to build pristine slot F2", { traceId });
            }

            const f2Payload = {
              serviceId: linkedPhases,
              bookedEntity: { slot: pristineF2 },
              contactDetails,
              options: { flowControlSettings: { skipAvailabilityValidation: false } },
            };

            const res = await createBookingElevated(f2Payload);
            bookingF2 = res?.booking || res;
            createdBookings.push({ bookingId: bookingF2?.id || bookingF2?._id, phase: "F2" });
            return bookingF2;
          };

          await Promise.all([createF1(), createF2()]);
        } else {
          const res = await createBookingElevated(f1Payload);
          bookingF1 = res?.booking || res;
          createdBookings.push({ bookingId: bookingF1?.id || bookingF1?._id, phase: "F1" });
        }

        return { bookingF1, bookingF2, createdBookings };
      },
      async () => {
        await _compensateCreatedBookings(createdBookings, traceId);
      }
    );

    const paymentMethod = _safeTrim(
      unsafePayload?.metodoPago ||
      unsafePayload?.paymentMethod ||
      metaCita.paymentMethod ||
      metaCita.metodoPago ||
      "PRESENCIAL"
    ).toUpperCase();
    const isOnline = paymentMethod === FORMA_PAGO.ONLINE;

    saga.addStep(
      isOnline ? "CreateCheckout" : "ConfirmPresencial",
      async () => {
        if (isOnline) {
          const bookingIds = createdBookings.map((b) => b.bookingId).filter(Boolean);
          const checkoutPayload = {
            lineItems: bookingIds.map((bookingId) => ({
              catalogReference: {
                appId: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
                catalogItemId: bookingId,
                options: {},
              },
              quantity: 1,
            })),
            channelType: "WEB",
          };

          const checkoutRes = await createCheckoutElevated(checkoutPayload);
          const checkoutUrl = await getCheckoutUrlElevated(_extractCheckoutId(checkoutRes));

          return { requiresPayment: true, checkoutUrl, bookingIds };
        } else {
          for (const booking of createdBookings) {
            await confirmOrDeclineBookingElevated(booking.bookingId, { paymentStatus: "NOT_PAID" });
          }
          return { requiresPayment: false, bookingIds: createdBookings.map((b) => b.bookingId) };
        }
      },
      async () => {
        // No hay compensacion para checkout (pago no procesado aun)
      }
    );

    // =========================================================================
    // FASE 5: EJECUTAR SAGA
    // =========================================================================

    const results = await saga.execute();

    // =========================================================================
    // FASE 6: PERSISTIR EN CITAS_F2 + COMPLETAR TRANSACCION
    // =========================================================================

    const bookingF1 = createdBookings.find((b) => b.phase === "F1");
    const bookingF2 = createdBookings.find((b) => b.phase === "F2");

    const paymentStatus = isOnline ? ESTADO_PAGO.PENDING_PAYMENT : ESTADO_PAGO.UNPAID;
    const citaStatus = isOnline ? ESTADO_CITA.PENDING_PAYMENT : ESTADO_CITA.CONFIRMED;

    await _persistBooking({
      bookingId: bookingF1?.bookingId,
      revision: 1,
      serviceId,
      scheduleId: null,
      resourceId: finalResourceId,
      startDate: getUtcDateFromMadridLocal(f1LocalStart),
      endDate: getUtcDateFromMadridLocal(f1LocalEnd),
      contactDetails: { email },
      tipo: isDual ? "dual" : "simple",
      meta: {
        pairToken,
        uiPairToken: unsafePayload?.uiPairToken || pairToken,
        paymentStatus,
        status: citaStatus,
        f1Start: f1LocalStart,
        f1End: f1LocalEnd,
        f2Start: f2LocalStart || null,
        f2End: f2LocalEnd || null,
        checkoutUrl: results?.[2]?.checkoutUrl || null,
      },
    }, traceId);

    if (isDual && bookingF2?.bookingId) {
      await _persistBooking({
        bookingId: bookingF2.bookingId,
        revision: 1,
        serviceId: linkedPhases,
        scheduleId: null,
        resourceId: finalResourceId,
        startDate: getUtcDateFromMadridLocal(f2LocalStart),
        endDate: getUtcDateFromMadridLocal(f2LocalEnd),
        contactDetails: { email },
        tipo: "dual_f2",
        meta: {
          pairToken,
          uiPairToken: unsafePayload?.uiPairToken || pairToken,
          paymentStatus,
          status: citaStatus,
          linkedF1BookingId: bookingF1?.bookingId,
        },
      }, traceId);
    }

    const finalResult = {
      bookingIds: createdBookings.map((b) => b.bookingId),
      pairToken,
      requiresPayment: isOnline,
      checkoutUrl: results?.[2]?.checkoutUrl || null,
      status: citaStatus,
    };

    await _completeTransaction(pairToken, finalResult);

    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    await _bestEffortUnlockAll(lockKeys, lockOwnerId);

    const madridDateYMD = f1LocalStart.slice(0, 10);
    await _invalidateCachesInternal(serviceId, madridDateYMD, finalResourceId, traceId);

    log.info("executeBookingSaga completed", {
      traceId,
      pairToken,
      isDual,
      bookingIds: createdBookings.map((b) => b.bookingId),
      requiresPayment: isOnline,
    });

    return { status: "SUCCESS", data: finalResult, error: null };

  } catch (error) {
    const norm = normalizeError(error);
    log.error("executeBookingSaga failed", { code: norm.code, error: norm.message, traceId });
    return {
      status: "ERROR",
      data: null,
      error: { code: norm.code || ERROR_CODES.UNKNOWN_ERROR, message: norm.message },
    };
  }
}