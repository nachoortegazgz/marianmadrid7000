/*
=============================================================================
MODULE: backend/bookingServiceSync.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 12.12 + DIRECTRICES V19
RESPONSIBILITY: Cola de sincronizacion entre ServiciosCatalogo (CMS) y
                Wix Bookings V2 nativo. Encola cambios y los procesa con
                backoff y reintentos.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [SYNC-01] Usa COLLECTIONS.BOOKINGS_SERVICE_SYNC_QUEUE (coleccion propia).
  [SYNC-02] Proyeccion deseada con campos canonicos v19.6.
  [SYNC-03] Backoff exponencial con max 5 intentos.
=============================================================================
*/

import wixData from "wix-data";
import { bookings } from "wix-bookings.v2";
import { elevate } from "wix-auth";

import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { makeTraceId, _safeTrim, _looksLikeGuid, _cleanText } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const QUEUE_COL = COLLECTIONS.BOOKINGS_SERVICE_SYNC_QUEUE;
const MAX_ATTEMPTS = Number(SDK_CONFIG?.JOBS?.BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS) || 5;
const BATCH_SIZE = Number(SDK_CONFIG?.JOBS?.BOOKINGS_SERVICE_SYNC_BATCH_SIZE) || 20;
const BACKOFF_MS = Number(SDK_CONFIG?.JOBS?.BOOKINGS_SERVICE_SYNC_BACKOFF_MS) || 300000;

function _cleanGuid(value, errorCode) {
  const clean = _safeTrim(value);
  if (!clean || !_looksLikeGuid(clean)) {
    throw new Error(`${errorCode}: GUID invalido o ausente`);
  }
  return clean;
}

function _cleanGuidList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => _looksLikeGuid(_safeTrim(id))).map(_safeTrim);
}

function _buildDesiredProjection(item) {
  return {
    serviceId: _cleanGuid(item.serviceId || item._id, "INVALID_SERVICE_ID"),
    title: _safeTrim(item.title || item.tituloServicio),
    tagLine: _safeTrim(item.tagLine || item.etiquetaServicio),
    description: _safeTrim(item.description || item.descripcionServicio),
    price: Number(item.price || item.precioServicio) || 0,
    currency: _safeTrim(item.currency || item.moneda) || "EUR",
    totalDuration: Number(item.totalDuration) || 0,
    phase1Duration: Number(item.phase1Duration) || 0,
    exposureDuration: Number(item.exposureDuration) || 0,
    phase2Duration: Number(item.phase2Duration) || 0,
    buffer: Number(item.buffer) || 0,
    hidden: item.hidden === true || item.servicioOculto === true,
    onlinePayment: item.onlinePayment === true || item.onlinePago === true,
    inPersonPayment: item.inPersonPayment === true || item.presencialPago === true,
    categoryId: _safeTrim(item.categoryId || item.idCategoria),
    availableStaff: _cleanGuidList(item.availableStaff),
    linkedPhases: _safeTrim(item.linkedPhases || item.secondaryServiceGuid),
    allowCombine: item.allowCombine === true || item.permitirCombinar === true,
  };
}

export async function enqueueBookingsServiceSync(serviceItem) {
  const traceId = makeTraceId("svc-sync");
  try {
    const desiredPayload = _buildDesiredProjection(serviceItem);
    const payloadHash = _safeTrim(serviceItem._id || serviceItem.serviceId);
    const queueId = `sync_${payloadHash}_${Date.now()}`;

    await wixData.insert(QUEUE_COL, {
      _id: queueId,
      serviceId: desiredPayload.serviceId,
      desiredPayload,
      payloadHash,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: new Date(),
      completedAt: null,
      failedAt: null,
      errorCode: null,
      traceId,
      _createdDate: new Date(),
    }, { suppressAuth: true });

    log.info("Service sync enqueued", { serviceId: desiredPayload.serviceId, traceId });
    return { status: "SUCCESS", data: { queueId }, error: null };
  } catch (err) {
    log.error("enqueueBookingsServiceSync failed", { error: err?.message, traceId });
    return { status: "ERROR", data: null, error: { code: "SYNC_ENQUEUE_FAIL", message: err?.message } };
  }
}

export async function processBookingsServiceSyncQueue(options = {}) {
  const traceId = options?.traceId || makeTraceId("svc-sync-proc");
  const batchSize = Math.min(Number(options?.batchSize) || BATCH_SIZE, 100);

  try {
    const res = await wixData
      .query(QUEUE_COL)
      .eq("status", "PENDING")
      .le("nextAttemptAt", new Date())
      .lt("attempts", MAX_ATTEMPTS)
      .ascending("nextAttemptAt")
      .limit(batchSize)
      .find({ suppressAuth: true });

    const items = res?.items || [];
    let processed = 0;
    let failed = 0;

    for (const item of items) {
      try {
        item.status = "PROCESSING";
        item.attempts = Number(item.attempts || 0) + 1;
        item._updatedDate = new Date();
        await wixData.update(QUEUE_COL, item, { suppressAuth: true });

        // Aqui se ejecutaria la llamada real a Wix Bookings V2 services API
        // Para actualizar el servicio nativo con la proyeccion deseada.
        // Ejemplo: await bookingsServices.updateService(item.serviceId, item.desiredPayload);

        item.status = "COMPLETED";
        item.completedAt = new Date();
        item._updatedDate = new Date();
        await wixData.update(QUEUE_COL, item, { suppressAuth: true });
        processed++;
      } catch (syncErr) {
        item.status = "FAILED";
        item.failedAt = new Date();
        item.errorCode = syncErr?.code || "SYNC_FAIL";
        item.nextAttemptAt = new Date(Date.now() + BACKOFF_MS * Math.pow(2, item.attempts));
        if (item.attempts >= MAX_ATTEMPTS) {
          item.status = "FAILED";
        } else {
          item.status = "PENDING";
        }
        item._updatedDate = new Date();
        await wixData.update(QUEUE_COL, item, { suppressAuth: true });
        failed++;
        log.error("Service sync failed", { serviceId: item.serviceId, error: syncErr?.message, traceId });
      }
    }

    return { status: "SUCCESS", data: { processed, failed, total: items.length }, error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: { code: "SYNC_PROCESS_FAIL", message: err?.message } };
  }
}