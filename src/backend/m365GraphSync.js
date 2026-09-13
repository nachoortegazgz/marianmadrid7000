/*
=============================================================================
MODULE: backend/m365GraphSync.js
RESPONSIBILITY: Durable projection of ledger records to M365 SharePoint.
STANDARDS: G10 ASCII Strict, Velo Native Optimized.
VERSION: v5006-1 - Machine states, idempotency, locking, backoff, error classification
=============================================================================
*/

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import { makeTraceId } from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";
import { logger } from "backend/booking/bookingCore";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";

const log = logger;
const QUEUE_COL = COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
const BATCH_SIZE = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BATCH_SIZE || 20;
const MAX_ATTEMPTS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_MAX_ATTEMPTS || 5;
const BACKOFF_MS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BACKOFF_MS || 300000;
const MAX_BACKOFF_MS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_MAX_BACKOFF_MS || 3600000; // 1 hora
const LOCK_EXPIRY_MS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_LOCK_EXPIRY_MS || 900000; // 15 min
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// [M365-01] ESTADOS DE MAQUINA DE ESTADOS
const STATES = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  RETRY: "RETRY"
};

// [M365-02] CLASIFICACION DE ERRORES
const RECOVERABLE_ERRORS = [
  "M365_GRAPH_TOKEN_FAILED",
  "M365_GRAPH_POST_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK_ERROR"
];

const NON_RECOVERABLE_ERRORS = [
  "M365_NOT_CONFIGURED",
  "INVALID_PAYLOAD",
  "AUTH_PERMANENTLY_DENIED"
];

function _isM365Enabled() {
    return SDK_CONFIG?.M365?.ENABLED === true;
}

function _isRecoverableError(error) {
  const msg = error?.message || String(error);
  return RECOVERABLE_ERRORS.some(err => msg.includes(err));
}

function _isNonRecoverableError(error) {
  const msg = error?.message || String(error);
  return NON_RECOVERABLE_ERRORS.some(err => msg.includes(err));
}

function _stableSerialize(value) {
    if (Array.isArray(value)) {return `[${value.map(_stableSerialize).join(",")}]`;}
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

// [M365-03] IDEMPOTENCIA CON CLAVE UNICA
function _queueId(payload) {
    return `m365-graph-${hashSHA256(_stableSerialize(payload)).slice(0, 56)}`;
}

// [M365-04] GENERAR CLAVE IDEMPOTENCIA EXPORTADA
export function generateIdempotencyKey(payload) {
  return _queueId(payload);
}

async function _loadGraphConfig() {
    const [tenantId, clientId, clientSecret, siteId, listId] = await Promise.all([
        getSecret(SECRETS.M365_GRAPH_TENANT_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_CLIENT_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_CLIENT_SECRET).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_SITE_ID).catch(() => ""),
        getSecret(SECRETS.M365_GRAPH_LIST_ID).catch(() => ""),
    ]);

    if (!tenantId || !clientId || !clientSecret || !siteId || !listId) {return null;}
    return { tenantId, clientId, clientSecret, siteId, listId };
}

async function _acquireGraphToken(config) {
    const body = `client_id=${encodeURIComponent(config.clientId)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${encodeURIComponent(config.clientSecret)}&grant_type=client_credentials`;
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!response?.ok) {throw new Error(`M365_GRAPH_TOKEN_FAILED`);}
    const data = await response.json().catch(() => null);
    if (!data?.access_token) {throw new Error("M365_GRAPH_TOKEN_INVALID");}
    return data.access_token;
}

// [M365-05] VALIDACION RESPUESTA HTTP Y JSON
async function _postListItem(config, token, payload) {
    const endpoint = `${GRAPH_BASE_URL}/sites/${encodeURIComponent(config.siteId)}/lists/${encodeURIComponent(config.listId)}/items`;
    const body = {
        fields: {
            Title: payload.title,
            CorrelationId: payload.correlationId,
            EventType: payload.eventType,
            OccurredAt: payload.occurredAt,
            BookingReference: payload.bookingReference,
            TransactionId: payload.transactionId,
            Amount: payload.amount,
            Currency: payload.currency,
            IntegrityHash: payload.integrityHash,
        },
    };

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    // [M365-06] VALIDAR response.ok EXPLICITAMENTE
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log.warn(`M365_HTTP_ERROR`, { status: response.status, body: errorBody });
      
      if (response.status === 429) {
        throw new Error("RATE_LIMITED");
      }
      if (response.status >= 500) {
        throw new Error("M365_GRAPH_POST_FAILED");
      }
      if (response.status === 409) {
        return { externalRecordId: "", duplicate: true };
      }
      throw new Error(`M365_GRAPH_POST_FAILED_${response.status}`);
    }
    
    // [M365-07] VALIDAR JSON RECIBIDO
    let data;
    try {
      data = await response.json();
    } catch (e) {
      log.error(`M365_INVALID_JSON_RESPONSE`, { status: response.status });
      throw new Error("M365_GRAPH_INVALID_JSON");
    }
    
    if (!data?.id) {
      log.warn(`M365_MISSING_ID_IN_RESPONSE`, { data });
    }
    
    return { externalRecordId: data?.id || "", duplicate: false };
}

// [M365-08] BLOQUEO TEMPORAL CON EXPIRACION
async function _tryAcquireLock(queueId, traceId) {
  const lockKey = `lock:m365:${queueId}`;
  const now = new Date();
  const expiryDate = new Date(now.getTime() + LOCK_EXPIRY_MS);
  
  try {
    // Intentar insertar lock
    await wixData.insert("M365SyncLocks", {
      _id: lockKey,
      queueId,
      acquiredAt: now,
      expiresAt: expiryDate,
      traceId,
      status: "LOCKED"
    }, { suppressAuth: true });
    return true;
  } catch (err) {
    // Lock ya existe, verificar si expiro
    const existing = await wixData.get("M365SyncLocks", lockKey, { suppressAuth: true }).catch(() => null);
    if (existing && existing.expiresAt > now) {
      return false; // Lock activo
    }
    // Lock expirado, actualizar
    if (existing) {
      await wixData.update("M365SyncLocks", {
        ...existing,
        acquiredAt: now,
        expiresAt: expiryDate,
        traceId
      }, { suppressAuth: true });
      return true;
    }
    return false;
  }
}

async function _releaseLock(queueId) {
  const lockKey = `lock:m365:${queueId}`;
  await wixData.remove("M365SyncLocks", lockKey, { suppressAuth: true }).catch(() => {});
}

export async function enqueueM365LedgerRecord(movement, traceId) {
    if (!_isM365Enabled()) {return { status: "PAUSED" };}
    
    const payload = {
        eventType: "LEDGER_MOVEMENT",
        correlationId: traceId || movement?.traceId,
        transactionId: movement?.transactionId,
        bookingReference: movement?.reservaIdVinculada || movement?._id,
        amount: movement?.accountingAmount,
        currency: "EUR",
        occurredAt: movement?.registeredAt || new Date(),
    };
    payload.title = `LEDGER_MOVEMENT ${payload.transactionId || payload.bookingReference}`;
    payload.integrityHash = hashSHA256(_stableSerialize(payload));

    const queueId = _queueId(payload);
    const queue = {
        _id: queueId, 
        payload, 
        payloadHash: payload.integrityHash,
        status: STATES.PENDING, // [M365-09] USAR ESTADO EXPLICITO
        attempts: 0, 
        nextAttemptAt: new Date(),
        traceId: payload.correlationId, 
        _createdDate: new Date(),
        idempotencyKey: queueId // [M365-10] CLAVE IDEMPOTENCIA EXPLICITA
    };

    try {
        await wixData.insert(QUEUE_COL, queue, { suppressAuth: true });
        log.info(`M365_ENQUEUED`, { queueId, traceId });
        return { status: STATES.PENDING, queueId };
    } catch (err) {
        log.warn(`M365_DUPLICATE_QUEUE`, { queueId, error: err.message });
        return { status: "DUPLICATE", queueId };
    }
}

// [M365-11] PROCESAMIENTO CON BLOQUEO Y ESTADOS
export async function processM365GraphSyncQueue(options = {}) {
    if (!_isM365Enabled()) {return { status: "PAUSED" };}
    
    const traceId = options.traceId || makeTraceId("M365_CRON");
    log.info(`M365_PROCESS_START`, { traceId });
    
    // [M365-12] CONSULTAR SOLO PENDING/RETRY CON LIMITE
    const pending = await wixData.query(QUEUE_COL)
        .in("status", [STATES.PENDING, STATES.RETRY])
        .le("nextAttemptAt", new Date())
        .limit(BATCH_SIZE)
        .find({ suppressAuth: true });

    if (!pending.items.length) {
      log.info(`M365_NO_PENDING_ITEMS`, { traceId });
      return { status: "SUCCESS", data: { processed: 0, failed: 0 } };
    }

    const config = await _loadGraphConfig();
    if (!config) {
      log.error(`M365_NOT_CONFIGURED`, { traceId });
      return { status: "BLOCKED", error: "M365_NOT_CONFIGURED" };
    }

    let token;
    try {
      token = await _acquireGraphToken(config);
    } catch (err) {
      log.error(`M365_TOKEN_ACQUISITION_FAILED`, { traceId, error: err.message });
      return { status: "TOKEN_ERROR", error: err.message };
    }
    
    let processed = 0;
    let failed = 0;
    let duplicates = 0;

    for (const queue of pending.items) {
        const itemTraceId = `${traceId}:${queue._id}`;
        
        // [M365-13] INTENTAR ADQUIRIR LOCK
        const lockAcquired = await _tryAcquireLock(queue._id, itemTraceId);
        if (!lockAcquired) {
          log.debug(`M365_LOCK_HELD_BY_OTHER`, { queueId: queue._id });
          continue; // Saltar, otro proceso lo esta manejando
        }
        
        try {
            // [M365-14] CAMBIAR A PROCESSING
            await wixData.update(QUEUE_COL, {
              ...queue,
              status: STATES.PROCESSING,
              processingStartedAt: new Date()
            }, { suppressAuth: true });
            
            const postResult = await _postListItem(config, token, queue.payload);
            
            if (postResult.duplicate) {
              duplicates++;
              log.info(`M365_DUPLICATE_EXTERNAL`, { queueId: queue._id });
            } else {
              processed++;
              log.info(`M365_ITEM_PROCESSED`, { queueId: queue._id, externalId: postResult.externalRecordId });
            }
            
            // [M365-15] MARCAR COMO COMPLETED
            await wixData.update(QUEUE_COL, {
              ...queue,
              status: STATES.COMPLETED,
              externalRecordId: postResult.externalRecordId,
              completedAt: new Date(),
              lastError: null
            }, { suppressAuth: true });
            
        } catch (error) {
            failed++;
            const attempts = queue.attempts + 1;
            const isRecoverable = _isRecoverableError(error);
            const isNonRecoverable = _isNonRecoverableError(error);
            
            // [M365-16] CLASIFICAR ERROR Y DECIDIR REINTENTO
            let terminal = false;
            if (isNonRecoverable) {
              terminal = true;
              log.error(`M365_NON_RECOVERABLE_ERROR`, { queueId: queue._id, error: error.message });
            } else if (attempts >= MAX_ATTEMPTS) {
              terminal = true;
              log.error(`M365_MAX_ATTEMPTS_EXCEEDED`, { queueId: queue._id, attempts });
            } else if (!isRecoverable) {
              terminal = true;
              log.error(`M365_UNKNOWN_ERROR`, { queueId: queue._id, error: error.message });
            }
            
            // [M365-17] BACKOFF EXPONENCIAL CON MAXIMO
            const backoff = Math.min(BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
            const nextAttemptAt = terminal ? null : new Date(Date.now() + backoff);
            
            await wixData.update(QUEUE_COL, {
                ...queue,
                status: terminal ? STATES.FAILED : STATES.RETRY,
                attempts,
                nextAttemptAt,
                lastError: error.message,
                lastErrorAt: new Date(),
                isRecoverable: isRecoverable,
                _updatedDate: new Date()
            }, { suppressAuth: true });
            
            // [M365-18] REGISTRAR COMPENSACION SI ES CRITICO
            if (terminal && !isNonRecoverable) {
              log.crit(`M365_ITEM_FAILED_TERMINAL`, { queueId: queue._id, error: error.message });
            }
            
        } finally {
            // [M365-19] LIBERAR LOCK SIEMPRE
            await _releaseLock(queue._id);
        }
    }
    
    log.info(`M365_PROCESS_COMPLETE`, { traceId, processed, failed, duplicates, total: pending.items.length });
    return { status: "SUCCESS", data: { processed, failed, duplicates } };
}

// [M365-20] FUNCION AUXILIAR PARA OBTENER ESTADO DE COLA
export async function getQueueStatus(queueId) {
  const item = await wixData.get(QUEUE_COL, queueId, { suppressAuth: true }).catch(() => null);
  if (!item) {return { status: "NOT_FOUND" };}
  
  return {
    status: item.status,
    attempts: item.attempts,
    externalRecordId: item.externalRecordId,
    lastError: item.lastError,
    createdAt: item._createdDate,
    completedAt: item.completedAt
  };
}

// [M365-21] LIMPIEZA DE LOCKS EXPIRADOS (para usar en cron)
export async function cleanupExpiredLocks() {
  const now = new Date();
  const expired = await wixData.query("M365SyncLocks")
    .lt("expiresAt", now)
    .limit(100)
    .find({ suppressAuth: true });
  
  let removed = 0;
  for (const lock of expired.items) {
    await wixData.remove("M365SyncLocks", lock._id, { suppressAuth: true }).catch(() => {});
    removed++;
  }
  
  log.info(`M365_LOCKS_CLEANUP`, { removed });
  return { removed };
}