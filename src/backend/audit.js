/*
=============================================================================
MODULE: backend/audit.js
VERSION: v5007.3-FINAL (FIX-D3)
RESPONSIBILITY: Auditoria centralizada. Elimina duplicacion en 4 modulos.
=============================================================================
*/
import wixData from "wix-data";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { _normalizeIdPart } from "public/mmUtils";
import { logger } from "backend/logger";
const log = logger;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

export async function logAuditEvent(tipoEvento, level, message, data = {}, traceId, entityId = "system", source = "backend/audit.js") {
  try {
    const safeEntity = _normalizeIdPart(entityId, 40);
    const safeTrace = _normalizeIdPart(traceId, 40);
    const safeTipo = _normalizeIdPart(tipoEvento, 30);
    const logId = `AUDIT_${safeTipo}_${safeEntity}_${safeTrace}`;
    await wixData.insert(COLLECTIONS.MM_AUDIT_LOG, {
      _id: logId, eventType: tipoEvento, level, message, data,
      resourceId: "SYSTEM", source, loggedAt: new Date(), traceId,
    }, { suppressAuth: true });
  } catch (err) {
    log.error("logAuditEvent failed (non-blocking)", { error: err?.message || String(err), traceId, tipoEvento });
  }
}

export async function logAuditEventWithTimeout(tipoEvento, level, message, data = {}, traceId, entityId = "system", source = "backend/audit.js") {
  try {
    const safeEntity = _normalizeIdPart(entityId, 40);
    const safeTrace = _normalizeIdPart(traceId, 40);
    const safeTipo = _normalizeIdPart(tipoEvento, 30);
    const logId = `AUDIT_${safeTipo}_${safeEntity}_${safeTrace}`;
    const insertPromise = wixData.insert(COLLECTIONS.MM_AUDIT_LOG, {
      _id: logId, eventType: tipoEvento, level, message, data,
      resourceId: "SYSTEM", source, loggedAt: new Date(), traceId,
    }, { suppressAuth: true });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("AUDIT_TIMEOUT")), API_TIMEOUT_MS));
    await Promise.race([insertPromise, timeoutPromise]).catch(() => null);
  } catch (err) {
    log.error("logAuditEventWithTimeout failed (non-blocking)", { error: err?.message || String(err), traceId, tipoEvento });
  }
}