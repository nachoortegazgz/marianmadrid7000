/*
=============================================================================
MODULE: backend/security.js
VERSION: v5007.2-FINAL (FIX B1 aplicado)
BASE: BIBLIA v5002.5 Bloque 12.8 + DIRECTRICES V19
RESPONSIBILITY: Motor de seguridad. Rate limiter con ventana deslizante,
                verificacion de roles (ADMIN, CAJERO, ESTILISTA) y bloqueo
                persistente cross-instancia en RateLimitBlocks.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [FIX B1] rateLimiter() activa registerPersistentBlock() cuando se excede
           3x el limite. Bloqueo persistente de 1 hora en RateLimitBlocks.
  [SEC-01] Rate limiter con ventana deslizante y cleanup periodico.
  [SEC-02] isKeyPersistentlyBlocked consulta RateLimitBlocks en CMS.
  [SEC-03] requireAdmin/requireCajero lanzan errores estructurados.
  [SEC-04] Cache de roles con TTL configurable.
=============================================================================
*/

import wixData from "wix-data";
import { currentMember } from "wix-members-backend";

import {
  COLLECTIONS,
  SDK_CONFIG,
  STAFF,
  STAFF_ACCESS,
  COLLAB_ROLES,
} from "backend/internalConfig";

import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 — RATE LIMITER (VENTANA DESLIZANTE + BLOQUEO PERSISTENTE)
// [FIX B1] Activar registerPersistentBlock cuando se exceda 3x el limite
// =============================================================================

const rateLimitCache = new Map();
const RATE_LIMIT_MAX_REQUESTS = SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS || 20;
const RATE_LIMIT_WINDOW_MS = SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS || 5000;
const RATE_LIMIT_CLEANUP_TTL_MS = SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS || 60000;
const RATE_LIMIT_CACHE_MAX_ENTRIES = SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES || 5000;

// [FIX B1] Umbrales para bloqueo persistente
const PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER = 3;
const PERSISTENT_BLOCK_DURATION_MS = 3600000; // 1 hora

let lastCleanupTime = Date.now();

function _cleanupRateLimitCache() {
  const now = Date.now();
  if (now - lastCleanupTime < RATE_LIMIT_CLEANUP_TTL_MS) return;
  lastCleanupTime = now;

  for (const [key, entry] of rateLimitCache.entries()) {
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const validTimestamps = (entry.timestamps || []).filter((ts) => ts > windowStart);
    if (validTimestamps.length === 0 && (!entry.blockedUntil || entry.blockedUntil < now)) {
      rateLimitCache.delete(key);
    } else {
      entry.timestamps = validTimestamps;
    }
  }

  if (rateLimitCache.size > RATE_LIMIT_CACHE_MAX_ENTRIES) {
    const keysToDelete = rateLimitCache.size - RATE_LIMIT_CACHE_MAX_ENTRIES;
    let deleted = 0;
    for (const key of rateLimitCache.keys()) {
      if (deleted >= keysToDelete) break;
      rateLimitCache.delete(key);
      deleted++;
    }
  }
}

/**
 * Rate limiter con ventana deslizante + bloqueo persistente cross-instancia.
 * [FIX B1] Cuando se excede 3x el limite, se registra bloqueo persistente de 1h.
 *
 * @param {Object} options - { surface, key }
 * @param {number} maxRequests - Limite por ventana (opcional)
 * @param {number} windowMs - Ventana en ms (opcional)
 * @returns {Object} { allowed: boolean, retryAfter: number, persistentBlock: boolean }
 */
export function rateLimiter({ surface, key }, maxRequests, windowMs) {
  _cleanupRateLimitCache();

  const max = Number(maxRequests) || RATE_LIMIT_MAX_REQUESTS;
  const window = Number(windowMs) || RATE_LIMIT_WINDOW_MS;
  const cacheKey = `${surface}:${key}`;
  const now = Date.now();

  let entry = rateLimitCache.get(cacheKey);
  if (!entry) {
    entry = { timestamps: [], blockedUntil: null, persistentBlockTriggered: false };
    rateLimitCache.set(cacheKey, entry);
  }

  // Verificar bloqueo persistente en memoria
  if (entry.blockedUntil && entry.blockedUntil > now) {
    const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
    return { allowed: false, retryAfter, persistentBlock: true };
  }

  // Filtrar timestamps fuera de la ventana
  const windowStart = now - window;
  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  // [FIX B1] Umbral de bloqueo persistente: 3x el limite
  const persistentThreshold = max * PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER;

  if (entry.timestamps.length >= max) {
    // [FIX B1] Si supera el umbral persistente, registrar bloqueo
    if (entry.timestamps.length >= persistentThreshold && !entry.persistentBlockTriggered) {
      entry.persistentBlockTriggered = true;
      entry.blockedUntil = now + PERSISTENT_BLOCK_DURATION_MS;

      // Registrar en CMS de forma no bloqueante (fire-and-forget)
      registerPersistentBlock(surface, key, PERSISTENT_BLOCK_DURATION_MS, makeTraceId("rl-block"))
        .catch((err) => log.error("registerPersistentBlock failed", { error: err?.message }));

      log.warn("Persistent block triggered", {
        surface,
        key,
        requestsInWindow: entry.timestamps.length,
        threshold: persistentThreshold,
        durationMs: PERSISTENT_BLOCK_DURATION_MS,
      });

      const retryAfter = Math.ceil(PERSISTENT_BLOCK_DURATION_MS / 1000);
      return { allowed: false, retryAfter, persistentBlock: true };
    }

    // Bloqueo normal de ventana
    const oldestInWindow = entry.timestamps[0] || now;
    const retryAfterMs = oldestInWindow + window - now;
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return { allowed: false, retryAfter, persistentBlock: false };
  }

  entry.timestamps.push(now);
  return { allowed: true, retryAfter: 0, persistentBlock: false };
}

/**
 * Verifica si una clave esta bloqueada persistentemente en el CMS.
 * Se llama al inicio de cada webMethod critico para detectar abusos cross-instancia.
 */
export async function isKeyPersistentlyBlocked(surface, key) {
  try {
    const res = await wixData
      .query(COLLECTIONS.RATE_LIMIT_BLOCKS)
      .eq("surface", surface)
      .eq("key", key)
      .gt("expiresAt", new Date())
      .limit(1)
      .find({ suppressAuth: true });

    return res?.items?.length > 0;
  } catch (err) {
    log.error("isKeyPersistentlyBlocked failed", { error: err?.message });
    return false;
  }
}

/**
 * Registra un bloqueo persistente en el CMS.
 * Cross-instancia: sobrevive cold starts de serverless.
 */
export async function registerPersistentBlock(surface, key, durationMs, traceId) {
  try {
    const expiresAt = new Date(Date.now() + durationMs);
    const blockId = `RL_${_safeTrim(surface).slice(0, 20)}_${_safeTrim(key).slice(0, 20)}_${Date.now()}`;

    await wixData.insert(
      COLLECTIONS.RATE_LIMIT_BLOCKS,
      {
        _id: blockId,
        surface,
        key,
        expiresAt,
        _createdDate: new Date(),
      },
      { suppressAuth: true }
    );
    log.warn("Persistent block registered", { surface, key, durationMs, traceId });
  } catch (err) {
    log.error("registerPersistentBlock failed", { error: err?.message, traceId });
  }
}

// =============================================================================
// BLOQUE 2 — VERIFICACION DE ROLES
// =============================================================================

const roleCache = new Map();
const ROLE_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.STAFF_TTL_MS || 300000;

async function _getCurrentMemberInfo() {
  try {
    const member = await currentMember.getMember();
    if (!member) return null;
    return {
      memberId: member._id,
      email: (member.loginEmail || member.contactDetails?.email || "").toLowerCase(),
    };
  } catch (_) {
    return null;
  }
}

export async function isAdmin(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) return false;

  const cached = roleCache.get(memberInfo.memberId);
  if (cached && Date.now() - cached.timestamp < ROLE_CACHE_TTL_MS) {
    return cached.role === COLLAB_ROLES.ADMIN;
  }

  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("email", memberInfo.email)
      .eq("active", true)
      .limit(1)
      .find({ suppressAuth: true });

    const staffRecord = res?.items?.[0];
    const role = staffRecord?.rol || null;

    roleCache.set(memberInfo.memberId, { role, timestamp: Date.now() });

    return role === COLLAB_ROLES.ADMIN;
  } catch (err) {
    log.error("isAdmin query failed", { error: err?.message, traceId });
    return false;
  }
}

export async function isCajero(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) return false;

  const cached = roleCache.get(memberInfo.memberId);
  if (cached && Date.now() - cached.timestamp < ROLE_CACHE_TTL_MS) {
    return cached.role === COLLAB_ROLES.ADMIN || cached.role === COLLAB_ROLES.GESTION;
  }

  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("email", memberInfo.email)
      .eq("active", true)
      .limit(1)
      .find({ suppressAuth: true });

    const staffRecord = res?.items?.[0];
    const role = staffRecord?.rol || null;

    roleCache.set(memberInfo.memberId, { role, timestamp: Date.now() });

    return role === COLLAB_ROLES.ADMIN || role === COLLAB_ROLES.GESTION;
  } catch (err) {
    log.error("isCajero query failed", { error: err?.message, traceId });
    return false;
  }
}

export async function isStaffCollaborator(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) return false;

  const cached = roleCache.get(memberInfo.memberId);
  if (cached && Date.now() - cached.timestamp < ROLE_CACHE_TTL_MS) {
    return STAFF_ACCESS.ALLOWED_ROLES.includes(cached.role);
  }

  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("email", memberInfo.email)
      .eq("active", true)
      .limit(1)
      .find({ suppressAuth: true });

    const staffRecord = res?.items?.[0];
    const role = staffRecord?.rol || null;

    roleCache.set(memberInfo.memberId, { role, timestamp: Date.now() });

    return STAFF_ACCESS.ALLOWED_ROLES.includes(role);
  } catch (err) {
    log.error("isStaffCollaborator query failed", { error: err?.message, traceId });
    return false;
  }
}

// =============================================================================
// BLOQUE 3 — FUNCIONES REQUIRE (LANZAN ERROR SI NO AUTORIZADO)
// =============================================================================

export async function requireAdmin(traceId) {
  const authorized = await isAdmin(traceId);
  if (!authorized) {
    const err = new Error("ACCESS_DENIED: ADMIN role required");
    err.code = "ACCESS_DENIED";
    err.statusCode = 403;
    throw err;
  }
}

export async function requireCajero(traceId) {
  const authorized = await isCajero(traceId);
  if (!authorized) {
    const err = new Error("ACCESS_DENIED: CAJERO role required");
    err.code = "ACCESS_DENIED";
    err.statusCode = 403;
    throw err;
  }
}

export async function requireMarianManager(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) {
    const err = new Error("AUTH_REQUIRED: No authenticated member");
    err.code = "AUTH_REQUIRED";
    err.statusCode = 401;
    throw err;
  }

  const isAdminRole = await isAdmin(traceId);
  if (!isAdminRole) {
    const err = new Error("ACCESS_DENIED: Marian Manager role required");
    err.code = "ACCESS_DENIED";
    err.statusCode = 403;
    throw err;
  }
}

// =============================================================================
// BLOQUE 4 — UTILIDADES
// =============================================================================

export function clearRoleCache() {
  roleCache.clear();
}

export async function getCurrentStaffResourceId(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) return null;

  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("email", memberInfo.email)
      .eq("active", true)
      .limit(1)
      .find({ suppressAuth: true });

    const staffRecord = res?.items?.[0];
    return staffRecord?.resourceId || null;
  } catch (err) {
    log.error("getCurrentStaffResourceId failed", { error: err?.message, traceId });
    return null;
  }
}

function _safeTrim(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") {
    try { return String(v).trim(); } catch (_) { return ""; }
  }
  return v.trim();
}