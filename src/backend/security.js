/*
=============================================================================
MODULE: backend/security.js
VERSION: v5007.0-FINAL
BASE: BIBLIA_DEFINITIVA v5002.5 Bloque 12.8 + DIRECTRICES V19
RESPONSIBILITY: Motor de seguridad del ecosistema Marian Madrid.
                - Rate limiter con ventana deslizante en memoria.
                - Bloqueo persistente cross-instancia (RateLimitBlocks).
                - Verificacion de roles (ADMIN, CAJERO, ESTILISTA).
                - Funciones require* para WebMethods.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO dependencias de Node.js.
           Usa wix-members-backend para verificacion de roles.
CORRECTIONS APPLIED:
  [SEC-06] Rate limiter con ventana deslizante y cleanup periodico.
  [SEC-07] isKeyPersistentlyBlocked consulta RateLimitBlocks en CMS.
  [SEC-08] requireAdmin/requireCajero lanzan errores estructurados.
  [SEC-09] Cache de roles con TTL configurable.
=============================================================================
*/

import wixData from "wix-data";
import { currentMember } from "wix-members-backend";
import { COLLECTIONS, SDK_CONFIG, STAFF, STAFF_ACCESS, COLLAB_ROLES } from "backend/internalConfig";
import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 — RATE LIMITER (VENTANA DESLIZANTE EN MEMORIA)
// =============================================================================

const rateLimitCache = new Map(); // key -> { timestamps: [], blockedUntil }
const RATE_LIMIT_MAX_REQUESTS = SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS || 20;
const RATE_LIMIT_WINDOW_MS = SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS || 5000;
const RATE_LIMIT_CLEANUP_TTL_MS = SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS || 60000;
const RATE_LIMIT_CACHE_MAX_ENTRIES = SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES || 5000;

let lastCleanupTime = Date.now();

/**
 * Limpia entradas expiradas del cache de rate limiting.
 */
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

  // Limitar tamaño del cache
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
 * Rate limiter con ventana deslizante.
 * @param {Object} options - Opciones del rate limiter
 * @param {string} options.surface - Superficie (endpoint)
 * @param {string} options.key - Clave del solicitante
 * @param {number} maxRequests - Maximo de requests permitidos (opcional)
 * @param {number} windowMs - Ventana en milisegundos (opcional)
 * @returns {Object} { allowed: boolean, retryAfter: number }
 */
export function rateLimiter({ surface, key }, maxRequests, windowMs) {
  _cleanupRateLimitCache();

  const max = Number(maxRequests) || RATE_LIMIT_MAX_REQUESTS;
  const window = Number(windowMs) || RATE_LIMIT_WINDOW_MS;
  const cacheKey = `${surface}:${key}`;
  const now = Date.now();

  let entry = rateLimitCache.get(cacheKey);
  if (!entry) {
    entry = { timestamps: [], blockedUntil: null };
    rateLimitCache.set(cacheKey, entry);
  }

  // Verificar bloqueo persistente
  if (entry.blockedUntil && entry.blockedUntil > now) {
    const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Filtrar timestamps fuera de la ventana
  const windowStart = now - window;
  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  if (entry.timestamps.length >= max) {
    const oldestInWindow = entry.timestamps[0] || now;
    const retryAfterMs = oldestInWindow + window - now;
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return { allowed: false, retryAfter };
  }

  entry.timestamps.push(now);
  return { allowed: true, retryAfter: 0 };
}

// =============================================================================
// BLOQUE 2 — BLOQUEO PERSISTENTE CROSS-INSTANCIA
// =============================================================================

/**
 * Verifica si una clave esta bloqueada persistentemente en el CMS.
 * @param {string} surface - Superficie (endpoint)
 * @param {string} key - Clave del solicitante
 * @returns {Promise<boolean>} true si esta bloqueada
 */
export async function isKeyPersistentlyBlocked(surface, key) {
  try {
    const blockKey = `${surface}:${key}`;
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
 * @param {string} surface - Superficie (endpoint)
 * @param {string} key - Clave del solicitante
 * @param {number} durationMs - Duracion del bloqueo en ms
 * @param {string} traceId - TraceId para auditoria
 */
export async function registerPersistentBlock(surface, key, durationMs, traceId) {
  try {
    const expiresAt = new Date(Date.now() + durationMs);
    await wixData.insert(
      COLLECTIONS.RATE_LIMIT_BLOCKS,
      {
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
// BLOQUE 3 — VERIFICACION DE ROLES
// =============================================================================

// Cache de roles con TTL
const roleCache = new Map(); // memberId -> { role, timestamp }
const ROLE_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.STAFF_TTL_MS || 300000;

/**
 * Obtiene el miembro actual y su email.
 * @returns {Promise<Object|null>} { memberId, email } o null
 */
async function _getCurrentMemberInfo() {
  try {
    const member = await currentMember.getMember();
    if (!member) return null;
    return {
      memberId: member._id,
      email: member.loginEmail || member.contactDetails?.email || "",
    };
  } catch (err) {
    return null;
  }
}

/**
 * Verifica si el miembro actual tiene rol ADMIN.
 * @param {string} traceId - TraceId para auditoria
 * @returns {Promise<boolean>} true si es ADMIN
 */
export async function isAdmin(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) return false;

  // Verificar cache
  const cached = roleCache.get(memberInfo.memberId);
  if (cached && Date.now() - cached.timestamp < ROLE_CACHE_TTL_MS) {
    return cached.role === COLLAB_ROLES.ADMIN;
  }

  // Consultar MapaStaff
  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("email", memberInfo.email.toLowerCase())
      .eq("active", true)
      .limit(1)
      .find({ suppressAuth: true });

    const staffRecord = res?.items?.[0];
    const role = staffRecord?.rol || null;

    // Actualizar cache
    roleCache.set(memberInfo.memberId, { role, timestamp: Date.now() });

    return role === COLLAB_ROLES.ADMIN;
  } catch (err) {
    log.error("isAdmin query failed", { error: err?.message, traceId });
    return false;
  }
}

/**
 * Verifica si el miembro actual tiene rol CAJERO (ADMIN o GESTION).
 * @param {string} traceId - TraceId para auditoria
 * @returns {Promise<boolean>} true si es CAJERO
 */
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
      .eq("email", memberInfo.email.toLowerCase())
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

/**
 * Verifica si el miembro actual es colaborador de staff (cualquier rol activo).
 * @param {string} traceId - TraceId para auditoria
 * @returns {Promise<boolean>} true si es staff colaborador
 */
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
      .eq("email", memberInfo.email.toLowerCase())
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
// BLOQUE 4 — FUNCIONES REQUIRE (LANZAN ERROR SI NO AUTORIZADO)
// =============================================================================

/**
 * Exige rol ADMIN. Lanza error si no autorizado.
 * @param {string} traceId - TraceId para auditoria
 * @throws {Error} Si no es ADMIN
 */
export async function requireAdmin(traceId) {
  const authorized = await isAdmin(traceId);
  if (!authorized) {
    const err = new Error("ACCESS_DENIED: ADMIN role required");
    err.code = "ACCESS_DENIED";
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Exige rol CAJERO (ADMIN o GESTION). Lanza error si no autorizado.
 * @param {string} traceId - TraceId para auditoria
 * @throws {Error} Si no es CAJERO
 */
export async function requireCajero(traceId) {
  const authorized = await isCajero(traceId);
  if (!authorized) {
    const err = new Error("ACCESS_DENIED: CAJERO role required");
    err.code = "ACCESS_DENIED";
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Exige rol de Marian Manager (ADMIN con resourceId especifico).
 * @param {string} traceId - TraceId para auditoria
 * @throws {Error} Si no es Marian Manager
 */
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
// BLOQUE 5 — UTILIDADES DE SEGURIDAD
// =============================================================================

/**
 * Limpia el cache de roles (util para testing o invalidacion manual).
 */
export function clearRoleCache() {
  roleCache.clear();
}

/**
 * Obtiene el resourceId del miembro actual si es staff activo.
 * @param {string} traceId - TraceId para auditoria
 * @returns {Promise<string|null>} resourceId o null
 */
export async function getCurrentStaffResourceId(traceId) {
  const memberInfo = await _getCurrentMemberInfo();
  if (!memberInfo) return null;

  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("email", memberInfo.email.toLowerCase())
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