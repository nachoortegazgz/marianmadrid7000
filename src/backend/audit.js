/*
=============================================================================
MODULE: backend/audit.js
VERSION: v5007.3-FIX-D3
BASE: BIBLIA v5002.5 Bloque 12 + ESQUEMA CMS 4.28 (MmAuditLog)
RESPONSIBILITY: Funcion centralizada de registro de auditoria operativa.
                Elimina la duplicacion de _logAuditEvent en cajas.web.js,
                events.js, facturasRecibidas.web.js e inventario.web.js.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Coleccion destino: MmAuditLog (ESQUEMA CMS 4.28).
           Campos: eventType, level, message, data, resourceId, source,
                   traceId, loggedAt.
CORRECTION APPLIED:
  [FIX-D3] Centraliza _logAuditEvent en un unico modulo compartido.
           Los modulos consumidores importan desde backend/audit.js
           en lugar de definir su propia copia local.
=============================================================================
*/

import wixData from "wix-data";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { _normalizeIdPart } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

/**
 * Registra un evento de auditoria en MmAuditLog.
 * Funcion fire-and-forget: nunca lanza excepciones al llamador.
 *
 * @param {string} tipoEvento - Tipo de evento (ej: "GIFT_CARD_SOLD")
 * @param {string} level - Nivel: "INFO" | "WARNING" | "ERROR" | "CRITICAL"
 * @param {string} message - Mensaje descriptivo
 * @param {Object} data - Datos adicionales (OBJECT nativo, sin serializar)
 * @param {string} traceId - TraceId de correlacion
 * @param {string} entityId - Identificador de entidad (default: "system")
 * @param {string} source - Modulo origen (ej: "backend/cajas.web.js")
 * @returns {Promise<void>}
 */
export async function logAuditEvent(
  tipoEvento,
  level,
  message,
  data = {},
  traceId,
  entityId = "system",
  source = "backend/audit.js"
) {
  try {
    const safeEntity = _normalizeIdPart(entityId, 40);
    const safeTrace = _normalizeIdPart(traceId, 40);
    const safeTipo = _normalizeIdPart(tipoEvento, 30);
    const logId = `AUDIT_${safeTipo}_${safeEntity}_${safeTrace}`;

    await wixData.insert(
      COLLECTIONS.MM_AUDIT_LOG,
      {
        _id: logId,
        eventType: tipoEvento,
        level,
        message,
        data,
        resourceId: "SYSTEM",
        source,
        loggedAt: new Date(),
        traceId,
      },
      { suppressAuth: true }
    );
  } catch (err) {
    // Fire-and-forget: nunca propagar errores de auditoria
    log.error("logAuditEvent failed (non-blocking)", {
      error: err?.message || String(err),
      traceId,
      tipoEvento,
    });
  }
}

/**
 * Version con timeout para contextos de webhook donde el tiempo es critico.
 *
 * @param {string} tipoEvento - Tipo de evento
 * @param {string} level - Nivel
 * @param {string} message - Mensaje
 * @param {Object} data - Datos adicionales
 * @param {string} traceId - TraceId
 * @param {string} entityId - Identificador de entidad
 * @param {string} source - Modulo origen
 * @returns {Promise<void>}
 */
export async function logAuditEventWithTimeout(
  tipoEvento,
  level,
  message,
  data = {},
  traceId,
  entityId = "system",
  source = "backend/audit.js"
) {
  try {
    const safeEntity = _normalizeIdPart(entityId, 40);
    const safeTrace = _normalizeIdPart(traceId, 40);
    const safeTipo = _normalizeIdPart(tipoEvento, 30);
    const logId = `AUDIT_${safeTipo}_${safeEntity}_${safeTrace}`;

    const insertPromise = wixData.insert(
      COLLECTIONS.MM_AUDIT_LOG,
      {
        _id: logId,
        eventType: tipoEvento,
        level,
        message,
        data,
        resourceId: "SYSTEM",
        source,
        loggedAt: new Date(),
        traceId,
      },
      { suppressAuth: true }
    );

    // Timeout wrapper para contextos de webhook
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("AUDIT_TIMEOUT")), API_TIMEOUT_MS);
    });

    await Promise.race([insertPromise, timeoutPromise]).catch(() => null);
  } catch (err) {
    log.error("logAuditEventWithTimeout failed (non-blocking)", {
      error: err?.message || String(err),
      traceId,
      tipoEvento,
    });
  }
}