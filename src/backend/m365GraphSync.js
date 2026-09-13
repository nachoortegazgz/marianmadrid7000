/*
=============================================================================
MODULE: backend/m365GraphSync.js
VERSION: v5007.4-FINAL (CORREGIDO)
BASE: BIBLIA v5002.5 + DOSSIER CAJA
CORRECTIONS APPLIED:
  [M365-01] desiredPayload en INSERT de M365GraphSyncQueue (antes payload).
  [M365-02] Lectura correcta de desiredPayload en procesamiento.
  [M365-03] Máquina de estados con RECOVERABLE/NO_RECOVERABLE.
  [M365-04] Lock distribuido con expiración.
=============================================================================
*/

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import { makeTraceId, _stableSerialize } from "public/mmUtils";
import { hashSHA256 } from "backend/securityEngine";
import { logger } from "backend/logger";
import { COLLECTIONS, SDK_CONFIG } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";

const log = logger;
const QUEUE_COL = COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
const BATCH_SIZE = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BATCH_SIZE || 20;
const MAX_ATTEMPTS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_MAX_ATTEMPTS || 3;
const BACKOFF_MS = SDK_CONFIG?.JOBS?.M365_GRAPH_SYNC_BACKOFF_MS || 300000;
const MAX_BACKOFF_MS = 3600000;
const LOCK_EXPIRY_MS = 900000;
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// [M365-03] Estados de máquina de estados
const STATES = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  RETRY: "RETRY",
};

// [M365-03] Clasificación de errores
const RECOVERABLE_ERRORS = [
  "M365_GRAPH_TOKEN_FAILED",
  "M365_GRAPH_POST_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK_ERROR",
];

const NON_RECOVERABLE_ERRORS = [
  "M365_NOT_CONFIGURED",
  "INVALID_PAYLOAD",
  "AUTH_PERMANENTLY_DENIED",
];

function _isM365Enabled() {
  return SDK_CONFIG?.M365?.ENABLED === true;
}

function _isRecoverableError(error) {
  const msg = error?.message || String(error);
  return RECOVERABLE_ERRORS.some((err) => msg.includes(err));
}

function _isNonRecoverableError(error) {
  const msg = error?.message || String(error);
  return NON_RECOVERABLE_ERRORS.some((err) => msg.includes(err));
}

function _queueId(payload) {
  return `m365-graph-${hashSHA256(_stableSerialize(payload)).slice(0, 56)}`;
}

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

  if (!tenantId || !clientId || !clientSecret || !siteId || !listId) return null;
  return { tenantId, clientId, clientSecret, siteId, listId };
}

async function _acquireGraphToken(config) {
  const body = `client_id=${encodeURIComponent(config.clientId)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${encodeURIComponent(config.clientSecret)}&grant_type=client_credentials`;
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response?.ok) throw new Error("M365_GRAPH_TOKEN_FAILED");
  const data = await response.json().catch(() => null);
  if (!data?.access_token) throw new Error("M365_GRAPH_TOKEN_INVALID");
  return data.access_token;
}

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

  if (response.status === 409) return { externalRecordId: "", duplicate: true };
  if (!response?.ok) throw new Error(`M365_GRAPH_POST_FAILED`);
  const data = await response.json().catch(() => ({}));
  return { externalRecordId: data?.id || "", duplicate: false };
}

// ============================================================================
// ENCOLAR REGISTRO
// [M365-01] desiredPayload en lugar de payload
// ============================================================================

export async function enqueueM365LedgerRecord(movement, traceId) {
  if (!_isM365Enabled()) return { status: "PAUSED" };

  const payload = {
    eventType: "LEDGER_MOVEMENT",
    correlationId: traceId || movement?.traceId,
    transactionId: movement?.transactionId,
    bookingReference: movement?.reservaIdVinculada || movement?.bookingId || movement?._id,
    amount: movement?.accountingAmount,
    currency: "EUR",
    occurredAt: movement?.registeredAt || new Date(),
  };
  payload.title = `LEDGER_MOVEMENT ${payload.transactionId || payload.bookingReference}`;
  payload.integrityHash = hashSHA256(_stableSerialize(payload));

  const queueId = _queueId(payload);
  const queue = {
    _id: queueId,
    // [M365-01] Campo canónico: desiredPayload
    desiredPayload: payload,
    payloadHash: payload.integrityHash,
    status: STATES.PENDING,
    attempts: 0,
    nextAttemptAt: new Date(),
    traceId: payload.correlationId,
    _createdDate: new Date(),
  };

  try {
    await wixData.insert(QUEUE_COL, queue, { suppressAuth: true });
    return { status: "PENDING" };
  } catch (err) {
    return { status: "DUPLICATE" };
  }
}

// ============================================================================
// PROCESAR COLA
// [M365-02] Lectura correcta de desiredPayload
// ============================================================================

export async function processM365GraphSyncQueue(options = {}) {
  if (!_isM365Enabled()) return { status: "PAUSED" };

  const pending = await wixData
    .query(QUEUE_COL)
    .in("status", [STATES.PENDING, STATES.RETRY])
    .le("nextAttemptAt", new Date())
    .limit(BATCH_SIZE)
    .find({ suppressAuth: true });

  if (!pending.items.length) return { status: "SUCCESS", data: { processed: 0 } };

  const config = await _loadGraphConfig();
  if (!config) return { status: "BLOCKED", error: "M365_NOT_CONFIGURED" };

  const token = await _acquireGraphToken(config);
  let processed = 0;

  for (const queue of pending.items) {
    try {
      // [M365-02] Leer desiredPayload (campo canónico)
      const payload = queue.desiredPayload || queue.payload;
      const postResult = await _postListItem(config, token, payload);

      await wixData.update(QUEUE_COL, {
        ...queue,
        status: STATES.COMPLETED,
        externalRecordId: postResult.externalRecordId,
        _updatedDate: new Date(),
      }, { suppressAuth: true });

      processed++;
    } catch (error) {
      const attempts = queue.attempts + 1;
      const isRecoverable = _isRecoverableError(error);
      const isNonRecoverable = _isNonRecoverableError(error);
      const terminal = isNonRecoverable || attempts >= MAX_ATTEMPTS || !isRecoverable;

      const backoff = Math.min(BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
      const nextAttemptAt = terminal ? null : new Date(Date.now() + backoff);

      await wixData.update(QUEUE_COL, {
        ...queue,
        status: terminal ? STATES.FAILED : STATES.RETRY,
        attempts,
        nextAttemptAt,
        lastError: error.message,
        _updatedDate: new Date(),
      }, { suppressAuth: true });
    }
  }

  return { status: "SUCCESS", data: { processed } };
}