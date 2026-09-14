/*
=============================================================================
MODULE: backend/booking/bookingSaga.js
VERSION: v5007.5-SSOT (HAL-S1..S12 + HAL-MAP alignment)
SSOT: SSOT CONSOLIDADO v5002.6 | ESQUEMA CMS v5002.5 | DOSSIER RESERVAS v0609
MISSION: Orquestador transaccional. Saga compensable para reservas simples
         y duales con gap de exposicion. Gestiona locks, heartbeat,
         idempotencia triple capa y creacion paralela F1+F2.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Nomenclatura v19.6: serviceId, linkedPhases, resourceId.
=============================================================================
INVENTARIO DE FUNCIONES:
  [EXPORT] _normalizePersistedMeta(meta)
  [INTERNAL] _resolveStablePairToken({serviceId, resourceId, f1Start, f2Start, email, existingPairToken})
  [INTERNAL] _bestEffortUnlockAll(lockKeys, lockOwnerId)
  [INTERNAL] _compensateCreatedBookings(createdBookings, traceId)
  [CLASS]  BookingSagaOrchestrator
  [EXPORT] executeBookingSaga(unsafePayload)
=============================================================================
DEPENDENCIAS:
  - backend/internalConfig.js (COLLECTIONS, CONCURRENCY, ESTADOCITA, ESTADOPAGO, FORMA_PAGO)
  - backend/booking/bookingCore.js (primitivas atomicas, locks, transacciones, logger)
  - backend/reservas.web.js (resolucion de servicios, slots, invalidacion cache)
  - public/mmUtils.js (makeTraceId, helpers seguros)
  - wix-bookings.v2, wix-ecom-backend, wix-auth, wix-data
=============================================================================
COLECCIONES QUE ESCRIBE: CitasF2, BookingTransactions, SlotLocks,
                         CompensacionesPendientes, DualSlotCache
COLECCIONES QUE LEE: ServiciosCatalogo, MapaStaff, CitasF2, BookingTransactions
=============================================================================
HISTORIAL DE CAMBIOS:
  v5007.5 | 2026-09-14 | Alineacion SSOT v5002.6 completa. Eliminados todos
          |            | los fallbacks legacy. Campos canonicos al primer nivel
          |            | de CitasF2. Import corregido a bookingCore.logger.
          |            | Dynamic import eliminado. Enum CANCEL_BOOKING alineado.
  v5007.4 | 2026-09-14 | Fix HAL-S1 (syntax trailing ||). Correcciones HAL-S2
          |            | a HAL-S12 aplicadas.
  v5007.3 | 2026-09-10 | FIX A5: import _extractCheckoutId desde bookingCore.
  v5002.5 | 2026-09-10 | Fix S-01: linkedPhases como fuente primaria de F2.
  v5002.3 | 2026-09-06 | Version inicial del dossier.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";

import {
  COLLECTIONS,
  CONCURRENCY,
  SDK_CONFIG,
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
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  _normalizeLocalIsoStr,
} from "public/mmUtils";

// [HAL-S4 FIX] logger imported from bookingCore.js (no backend/logger module exists in SSOT inventory)
import {
  logger,
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
  ERROR_CODES,
  _extractCheckoutId,
} from "backend/booking/bookingCore";

export { _extractCheckoutId };

// [HAL-S10 FIX] Static import replaces redundant dynamic import
import {
  _resolveServiceIdInternal,
  _invalidateCachesInternal,
  _getServiceBySlugOrIdInternal,
  _resolveStaffForSlotInternal,
} from "backend/reservas.web";

const log = logger;

const LOCKTTLMS = Number(CONCURRENCY?.MUTEXTTLMS) || 300000;
const HEARTBEATMS = Number(CONCURRENCY?.HEARTBEATMS) || 15000;
const CITASCOL = COLLECTIONS.CITASF2;
const COMPENSACIONESCOL = COLLECTIONS.COMPENSACIONESPENDIENTES;

// =============================================================================
// BLOCK 1 - DETERMINISTIC PAIR TOKEN
// =============================================================================
function _resolveStablePairToken({ serviceId, resourceId, f1Start, f2Start, email, existingPairToken }) {
  const existing = _safeTrim(existingPairToken);
  if (existing) return existing;

  const emailHash = hashKey(safeTrim(email).toLowerCase());
  const payload = _stableSerialize({
    serviceId: _safeTrim(serviceId),
    resourceId: _safeTrim(resourceId),
    f1Start: _safeTrim(f1Start),
    f2Start: _safeTrim(f2Start || ""),
  });
  const hash = _hashKey(payload + "|" + emailHash);
  return "pt_" + hash.slice(0, 32);
}

// =============================================================================
// BLOCK 2 - PERSISTED META NORMALIZATION
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
// BLOCK 3 - BEST-EFFORT LOCK RELEASE
// =============================================================================
async function _bestEffortUnlockAll(lockKeys, lockOwnerId) {
  for (const key of lockKeys || []) {
    try {
      await _unlockSlotKey(key, lockOwnerId);
    } catch (e) {
      log.warn("_bestEffortUnlockAll: failed to unlock", { key: key, error: e?.message });
    }
  }
}

// =============================================================================
// BLOCK 4 - BOOKING COMPENSATION
// =============================================================================
async function _compensateCreatedBookings(createdBookings, traceId) {
  for (const booking of createdBookings || []) {
    const bookingId = booking?.bookingId || booking?.id;
    if (!bookingId) continue;
    try {
      await cancelBookingElevated(bookingId, { suppressAuth: true });
      log.info("Compensated booking cancelled", { bookingId: bookingId, traceId: traceId });
    } catch (cancelErr) {
      log.error("Compensation cancel failed; queuing", {
        bookingId: bookingId,
        traceId: traceId,
        error: cancelErr?.message,
      });
      try {
        // [HAL-S12 FIX] kind aligned with internalConfig enum CANCEL_BOOKING
        await wixData.insert(
          COMPENSACIONES_COL,
          {
            id: "COMP" + bookingId + "_" + Date.now(),
            kind: "CANCEL_BOOKING",
            bookingId: bookingId,
            phase: booking?.phase || "UNKNOWN",
            status: "PENDING",
            attempts: 0,
            amount: 0,
            paymentMethod: null,
            transactionId: null,
            orderId: null,
            refundId: null,
            concept: "Booking compensation after saga failure",
            movementType: null,
            alertRequired: true,
            lastError: cancelErr?.message || "UNKNOWN",
            traceId: traceId,
            _createdDate: new Date(),
            _updatedDate: new Date(),
          },
          { suppressAuth: true }
        );
      } catch (queueErr) {
        log.error("Failed to queue compensation", {
          bookingId: bookingId,
          traceId: traceId,
          error: queueErr?.message,
        });
      }
    }
  }
}

// =============================================================================
// BLOCK 5 - SAGA ORCHESTRATOR
// =============================================================================
export class BookingSagaOrchestrator {
  constructor(traceId) {
    this.traceId = traceId;
    this.steps = [];
    this.completedSteps = [];
  }

  addStep(name, executeFn, compensateFn) {
    this.steps.push({ name: name, executeFn: executeFn, compensateFn: compensateFn });
  }

  async execute() {
    for (const step of this.steps) {
      try {
        log.info("Saga step: " + step.name, { traceId: this.traceId });
        const result = await step.executeFn();
        this.completedSteps.push(Object.assign({}, step, { result: result }));
      } catch (error) {
        log.error("Saga step failed: " + step.name, {
          traceId: this.traceId,
          error: error?.message,
        });
        await this._compensate();
        throw error;
      }
    }
    return this.completedSteps.map(function (s) { return s.result; });
  }

  async _compensate() {
    const reversed = [].concat(this.completedSteps).reverse();
    for (const step of reversed) {
      if (step.compensateFn) {
        try {
          log.info("Saga compensating: " + step.name, { traceId: this.traceId });
          await step.compensateFn(step.result);
        } catch (compErr) {
          log.error("Saga compensation failed: " + step.name, {
            traceId: this.traceId,
            error: compErr?.message,
          });
        }
      }
    }
  }
}

// =============================================================================
// BLOCK 6 - EXECUTE BOOKING SAGA (MAIN FUNCTION)
// =============================================================================
export async function executeBookingSaga(unsafePayload) {
  const traceId = unsafePayload?.traceId || makeTraceId("saga");
  const metaCita = _normalizePersistedMeta(unsafePayload?.metaCita || unsafePayload?.meta || {});

  try {
    // =========================================================================
    // PHASE 0: VALIDATION AND RESOLUTION
    // =========================================================================
    const email = _safeTrim(
      unsafePayload?.email || metaCita.email || unsafePayload?.contactDetails?.email
    );
    if (!email) {
      throw createBookingError(ERRORCODES.INVALIDPAYLOAD, "Email is required", { traceId: traceId });
    }

    // [HAL-S1 FIX] Trailing || removed, default empty string added
    // [HAL-S5 FIX] primaryServiceId legacy fallback removed (R7 zero legacy)
    const rawServiceId = _safeTrim(
      unsafePayload?.serviceId ||
      metaCita.serviceId ||
      ""
    );
    const serviceId = await _resolveServiceIdInternal(rawServiceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
      throw createBookingError(ERRORCODES.SERVICENOT_FOUND, "Service not found", {
        traceId: traceId,
        rawServiceId: rawServiceId,
      });
    }

    // [HAL-S10 FIX] Static import used instead of redundant dynamic import
    const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
    const serviceConfig = serviceRes?.data || {};
    const isDual = serviceConfig.allowCombine === true && !!serviceConfig.linkedPhases;
    const linkedPhases = isDual ? serviceConfig.linkedPhases : null;

    const requestedResourceId = _safeTrim(unsafePayload?.resourceId || metaCita.resourceId);
    const slotF1Input = unsafePayload?.slotF1 || {};
    const slotF2Input = unsafePayload?.slotF2 || {};

    const f1LocalStart = _normalizeLocalIsoStr(
      slotF1Input.localStartDate || slotF1Input.start || metaCita.f1Start
    );
    const f1LocalEnd = _normalizeLocalIsoStr(
      slotF1Input.localEndDate || slotF1Input.end || metaCita.f1End
    );

    if (!f1LocalStart || !f1LocalEnd) {
      throw createBookingError(ERRORCODES.INVALIDPAYLOAD, "F1 slot dates are required", {
        traceId: traceId,
      });
    }

    let f2LocalStart = "";
    let f2LocalEnd = "";
    if (isDual) {
      f2LocalStart = _normalizeLocalIsoStr(
        slotF2Input.localStartDate || slotF2Input.start || metaCita.f2Start
      );
      f2LocalEnd = _normalizeLocalIsoStr(
        slotF2Input.localEndDate || slotF2Input.end || metaCita.f2End
      );

      if (!f2LocalStart) {
        const f1EndUtc = getUtcDateFromMadridLocal(f1LocalEnd);
        const exposureMs = Math.max(0, Number(serviceConfig.exposureDuration || 0))  60  1000;
        const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
        const phase2Ms = Math.max(0, Number(serviceConfig.phase2Duration || 30))  60  1000;
        const f2EndUtc = new Date(f2StartUtc.getTime() + phase2Ms);
        f2LocalStart = getMadridLocalStringNoZ(f2StartUtc);
        f2LocalEnd = getMadridLocalStringNoZ(f2EndUtc);
      }
    }

    const pairToken = _resolveStablePairToken({
      serviceId: serviceId,
      resourceId: requestedResourceId,
      f1Start: f1LocalStart,
      f2Start: f2LocalStart,
      email: email,
      existingPairToken: unsafePayload?.pairToken || metaCita.pairToken,
    });

    // =========================================================================
    // PHASE 1: IDEMPOTENCY CHECK ON CITAS_F2
    // =========================================================================
    const existingCitaRes = await wixData
      .query(CITAS_COL)
      .eq("pairToken", pairToken)
      .limit(1)
      .find({ suppressAuth: true, suppressHooks: true })
      .catch(function () { return { items: [] }; });

    if (existingCitaRes?.items?.length > 0) {
      const existingCita = existingCitaRes.items[0];
      // [HAL-S6, HAL-S8 FIX] Only canonical paymentStatus field used.
      // estadoPago and CITAFIELDS.STATUSPAGO removed (NOM-01 resolved).
      const existingPaymentStatus = String(
        existingCita.paymentStatus || ""
      ).toUpperCase();

      if (existingPaymentStatus === ESTADOPAGO.PENDINGPAYMENT) {
        log.info("Idempotent duplicate: PENDING_PAYMENT, returning existing checkout", {
          pairToken: pairToken,
          traceId: traceId,
        });
        return {
          status: "SUCCESS",
          data: {
            requiresPayment: true,
            checkoutUrl: existingCita.meta?.checkoutUrl || null,
            pairToken: pairToken,
            idempotent: true,
          },
          error: null,
        };
      }

      log.info("Idempotent duplicate: existing cita found", {
        pairToken: pairToken,
        traceId: traceId,
        status: existingCita.status,
      });
      return {
        status: "SUCCESS",
        data: {
          bookingId: existingCita.bookingId,
          pairToken: pairToken,
          status: existingCita.status,
          idempotent: true,
        },
        error: null,
      };
    }

    // =========================================================================
    // PHASE 2: INIT TRANSACTION ON BOOKING_TRANSACTIONS
    // =========================================================================
    const payloadHash = _hashKey(
      _stableSerialize({
        serviceId: serviceId,
        resourceId: requestedResourceId,
        f1LocalStart: f1LocalStart,
        f1LocalEnd: f1LocalEnd,
        f2LocalStart: f2LocalStart,
        f2LocalEnd: f2LocalEnd,
        email: email,
      })
    );

    const txResult = await _initTransaction(pairToken, payloadHash, traceId);
    if (!txResult.success) {
      if (txResult.error === "PAIRTOKENPAYLOAD_MISMATCH") {
        throw createBookingError(
          ERRORCODES.INVALIDPAYLOAD,
          "Payload mismatch for existing pairToken",
          { traceId: traceId }
        );
      }
      if (txResult.error === "TRANSACTIONPREVIOUSLYFAILED") {
        throw createBookingError(
          ERRORCODES.BOOKINGCREATION_FAILED,
          "Previous transaction failed",
          { traceId: traceId }
        );
      }
      if (txResult.existing?.status === "COMPLETED") {
        return {
          status: "SUCCESS",
          data: txResult.existing.result,
          error: null,
          idempotent: true,
        };
      }
      throw createBookingError(
        ERRORCODES.TOKENBUSY,
        "Transaction in progress or timeout",
        { traceId: traceId }
      );
    }

    // =========================================================================
    // PHASE 3: REAL-TIME REVALIDATION
    // =========================================================================
    const resourceValidation = await _resolveStaffForSlotInternal({
      serviceId: serviceId,
      f1Start: f1LocalStart,
      f1End: f1LocalEnd,
      f2Start: isDual ? f2LocalStart : null,
      f2End: isDual ? f2LocalEnd : null,
      requestedResourceId: requestedResourceId || null,
      traceId: traceId,
    });

    if (resourceValidation?.status !== "SUCCESS") {
      await _failTransaction(
        pairToken,
        resourceValidation?.error?.code || "SLOT_UNAVAILABLE"
      );
      throw createBookingError(
        resourceValidation?.error?.code || ERRORCODES.SLOTUNAVAILABLE,
        resourceValidation?.error?.message || "Slot no longer available",
        { traceId: traceId }
      );
    }

    const finalResourceId = resourceValidation.data.resourceId;
    const validatedSlotF1 = resourceValidation.data.slotF1;
    const validatedSlotF2 = resourceValidation.data.slotF2;

    // =========================================================================
    // PHASE 4: ACQUIRE LOCKS + HEARTBEAT
    // =========================================================================
    const phases = [
      {
        rawSlot: Object.assign({}, validatedSlotF1, { serviceId: serviceId }),
        localStart: f1LocalStart,
        localEnd: f1LocalEnd,
      },
    ];
    if (isDual && f2LocalStart) {
      phases.push({
        rawSlot: { serviceId: linkedPhases },
        localStart: f2LocalStart,
        localEnd: f2LocalEnd,
      });
    }

    const lockKeys = _buildLockKeys(phases, finalResourceId);
    const lockOwnerId = pairToken;
    let heartbeatInterval = null;

    const saga = new BookingSagaOrchestrator(traceId);
    const createdBookings = [];

    saga.addStep(
      "LockSlots",
      async function () {
        for (const lockKey of lockKeys) {
          const lockResult = await lockSlotKeyOrFail(lockKey, lockOwnerId, LOCKTTL_MS);
          if (!lockResult?.ok) {
            throw createBookingError(
              ERRORCODES.TOKENBUSY,
              "Lock failed: " + (lockResult?.message || "unknown"),
              { traceId: traceId, lockKey: lockKey }
            );
          }
        }
        heartbeatInterval = setInterval(function () {
          lockKeys.forEach(function (key) {
            renewLock(key, lockOwnerId, LOCKTTL_MS).catch(function () {});
          });
        }, HEARTBEAT_MS);
        return { lockKeys: lockKeys };
      },
      async function () {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
        await _bestEffortUnlockAll(lockKeys, lockOwnerId);
      }
    );

    saga.addStep(
      "CreateBookings",
      async function () {
        const pristineF1 = await _forceStaffInPristineSlot(
          validatedSlotF1,
          finalResourceId,
          serviceId,
          serviceConfig.phase1Duration
        );
        if (!pristineF1) {
          throw createBookingError(
            ERRORCODES.INVALIDPAYLOAD,
            "Failed to build pristine slot F1",
            { traceId: traceId }
          );
        }

        const contactDetails = {
          firstName: _safeTrim(unsafePayload?.firstName || metaCita.firstName || ""),
          lastName: _safeTrim(unsafePayload?.lastName || metaCita.lastName || ""),
          email: email,
          phone: _safeTrim(unsafePayload?.phone || metaCita.phone || ""),
        };

        const f1Payload = {
          serviceId: serviceId,
          bookedEntity: { slot: pristineF1 },
          contactDetails: contactDetails,
          options: { flowControlSettings: { skipAvailabilityValidation: false } },
        };

        let bookingF1 = null;
        let bookingF2 = null;

        if (isDual && f2LocalStart && validatedSlotF2) {
          const createF1 = async function () {
            const res = await createBookingElevated(f1Payload);
            bookingF1 = res?.booking || res;
            // [HAL-S9 FIX] Wix booking object uses .id or ._id, not .bookingId
            createdBookings.push({
              bookingId: bookingF1?.id || bookingF1?._id,
              phase: "F1",
            });
            return bookingF1;
          };

          const createF2 = async function () {
            await new Promise(function (r) {
              setTimeout(r, 400 + Math.random() * 600);
            });
            const pristineF2 = await _forceStaffInPristineSlot(
              validatedSlotF2,
              finalResourceId,
              linkedPhases,
              serviceConfig.phase2Duration
            );
            if (!pristineF2) {
              throw createBookingError(
                ERRORCODES.INVALIDPAYLOAD,
                "Failed to build pristine slot F2",
                { traceId: traceId }
              );
            }
            const f2Payload = {
              serviceId: linkedPhases,
              bookedEntity: { slot: pristineF2 },
              contactDetails: contactDetails,
              options: { flowControlSettings: { skipAvailabilityValidation: false } },
            };
            const res = await createBookingElevated(f2Payload);
            bookingF2 = res?.booking || res;
            createdBookings.push({
              bookingId: bookingF2?.id || bookingF2?._id,
              phase: "F2",
            });
            return bookingF2;
          };

          await Promise.all([createF1(), createF2()]);
        } else {
          const res = await createBookingElevated(f1Payload);
          bookingF1 = res?.booking || res;
          createdBookings.push({
            bookingId: bookingF1?.id || bookingF1?._id,
            phase: "F1",
          });
        }

        return {
          bookingF1: bookingF1,
          bookingF2: bookingF2,
          createdBookings: createdBookings,
        };
      },
      async function () {
        await _compensateCreatedBookings(createdBookings, traceId);
      }
    );

    // [HAL-S7 FIX] metodoPago legacy fallback removed. Only paymentMethod used.
    const paymentMethod = _safeTrim(
      unsafePayload?.paymentMethod ||
      metaCita.paymentMethod ||
      "PRESENCIAL"
    ).toUpperCase();
    const isOnline = paymentMethod === FORMA_PAGO.ONLINE;

    saga.addStep(
      isOnline ? "CreateCheckout" : "ConfirmPresencial",
      async function () {
        if (isOnline) {
          const bookingIds = createdBookings
            .map(function (b) { return b.bookingId; })
            .filter(Boolean);
          const checkoutPayload = {
            lineItems: bookingIds.map(function (bookingId) {
              return {
                catalogReference: {
                  appId: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
                  catalogItemId: bookingId,
                  options: {},
                },
                quantity: 1,
              };
            }),
            channelType: "WEB",
          };

          const checkoutRes = await createCheckoutElevated(checkoutPayload);
          const checkoutUrl = await getCheckoutUrlElevated(
            _extractCheckoutId(checkoutRes)
          );

          return {
            requiresPayment: true,
            checkoutUrl: checkoutUrl,
            bookingIds: bookingIds,
          };
        } else {
          for (const booking of createdBookings) {
            await confirmOrDeclineBookingElevated(booking.bookingId, {
              paymentStatus: "NOT_PAID",
            });
          }
          return {
            requiresPayment: false,
            bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
          };
        }
      },
      async function () {}
    );

    // =========================================================================
    // PHASE 5: EXECUTE SAGA
    // =========================================================================
    const results = await saga.execute();

    // =========================================================================
    // PHASE 6: PERSIST TO CITAS_F2 + COMPLETE TRANSACTION
    // =========================================================================
    // [HAL-S9 FIX] Correct field extraction from createdBookings array
    const bookingF1Id = createdBookings.find(function (b) {
      return b.phase === "F1";
    })?.bookingId;
    const bookingF2Id = createdBookings.find(function (b) {
      return b.phase === "F2";
    })?.bookingId;

    const paymentStatus = isOnline
      ? ESTADOPAGO.PENDINGPAYMENT
      : ESTADO_PAGO.UNPAID;
    const citaStatus = isOnline
      ? ESTADOCITA.PENDINGPAYMENT
      : ESTADO_CITA.CONFIRMED;

    // [HAL-S2, HAL-S3 FIX] Top-level canonical fields per SSOT v5002.6
    // CitasF2 schema: bookingId, revision, serviceId, scheduleId, resourceId,
    // startDate, endDate, dateYmd, bookingType, status, paymentStatus,
    // pairToken, contactDetails, meta (OBJECT native), traceId
    await _persistBooking(
      {
        bookingId: bookingF1Id,
        revision: 1,
        serviceId: serviceId,
        scheduleId: null,
        resourceId: finalResourceId,
        startDate: getUtcDateFromMadridLocal(f1LocalStart),
        endDate: getUtcDateFromMadridLocal(f1LocalEnd),
        dateYmd: f1LocalStart.slice(0, 10),
        bookingType: isDual ? "DUAL_F1" : "SIMPLE",
        status: citaStatus,
        paymentStatus: paymentStatus,
        pairToken: pairToken,
        contactDetails: { email: email },
        meta: {
          uiPairToken: unsafePayload?.uiPairToken || pairToken,
          f1Start: f1LocalStart,
          f1End: f1LocalEnd,
          f2Start: f2LocalStart || null,
          f2End: f2LocalEnd || null,
          checkoutUrl: results?.[2]?.checkoutUrl || null,
        },
        traceId: traceId,
      },
      traceId
    );

    if (isDual && bookingF2Id) {
      await _persistBooking(
        {
          bookingId: bookingF2Id,
          revision: 1,
          serviceId: linkedPhases,
          scheduleId: null,
          resourceId: finalResourceId,
          startDate: getUtcDateFromMadridLocal(f2LocalStart),
          endDate: getUtcDateFromMadridLocal(f2LocalEnd),
          dateYmd: f2LocalStart.slice(0, 10),
          bookingType: "DUAL_F2",
          status: citaStatus,
          paymentStatus: paymentStatus,
          pairToken: pairToken,
          contactDetails: { email: email },
          meta: {
            uiPairToken: unsafePayload?.uiPairToken || pairToken,
            linkedF1BookingId: bookingF1Id,
          },
          traceId: traceId,
        },
        traceId
      );
    }

    const finalResult = {
      bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
      pairToken: pairToken,
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
      traceId: traceId,
      pairToken: pairToken,
      isDual: isDual,
      bookingIds: createdBookings.map(function (b) { return b.bookingId; }),
      requiresPayment: isOnline,
    });

    return { status: "SUCCESS", data: finalResult, error: null };

  } catch (error) {
    const norm = normalizeError(error);
    log.error("executeBookingSaga failed", {
      code: norm.code,
      error: norm.message,
      traceId: traceId,
    });
    return {
      status: "ERROR",
      data: null,
      error: {
        code: norm.code || ERRORCODES.UNKNOWNERROR,
        message: norm.message,
      },
    };
  }
}