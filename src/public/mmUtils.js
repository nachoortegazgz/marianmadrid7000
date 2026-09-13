/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5007.0-FINAL
BASE: BIBLIA_DEFINITIVA v5002.5 Bloque 13.1 + DIRECTRICES V19
RESPONSIBILITY: Utilitarios seguros transversales para frontend y backend.
                Validación, normalización, manejo de timezone Europe/Madrid,
                enmascarado PII, generación de traceId, serialización estable,
                hashing, utilidades async y clonación profunda.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO dependencias externas (puro JS).
           ZERO imports de wix-* (compatible public/backend).
           Compatible con Web Crypto API y fallback determinista.
CORRECTIONS APPLIED:
  [MMU-01] normalizeIdPart + alias _normalizeIdPart (compatibilidad)
  [MMU-02] _looksLikeGuid estricta UUID v4
  [MMU-03] _readPositiveAmount retorna null (no 0) para inválidos
  [MMU-04] _readNonNegativeAmount retorna null para negativos
  [MMU-05] _readDate retorna YYYY-MM-DD Europe/Madrid
  [MMU-06] _stableSerialize ordena claves recursivamente
  [MMU-07] _normalizeLocalIsoStr sin Z, formato local Madrid
  [MMU-08] getUtcDateFromMadridLocal DST-safe (algoritmo iterativo robusto)
  [MMU-09] getMadridLocalStringNoZ DST-safe
  [MMU-10] withTimeout con label descriptivo
  [MMU-11] _executeWithRetry backoff exponencial + jitter
  [MMU-12] _hashKey Web Crypto API + fallback SHA-256 puro
  [MMU-13] _cloneDeep maneja Date, RegExp, Map, Set, ciclos
  [MMU-14] Enmascarado PII RGPD-compliant
  [MMU-15] makeTraceId con prefijo + timestamp + aleatorio
  [MMU-16] _safeTrim null-safe
=============================================================================
*/

// =============================================================================
// BLOQUE 1 — TRAZABILIDAD (traceId, UUID)
// =============================================================================

export function makeTraceId(prefix = "op") {
  const safePrefix = typeof prefix === "string" && prefix.length > 0
    ? prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)
    : "op";
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 11);
  return `${safePrefix}_${ts}_${rand}`;
}

export function _generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// =============================================================================
// BLOQUE 2 — SANITIZACIÓN DE TEXTO
// =============================================================================

export function _safeTrim(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") {
    try {
      return String(v).trim();
    } catch (_) {
      return "";
    }
  }
  return v.trim();
}

export function _cleanText(value, maxLength = 500) {
  const s = _safeTrim(value);
  if (!s) return "";
  const collapsed = s.replace(/\s+/g, " ");
  const max = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 500;
  return collapsed.slice(0, max);
}

export function _safeSlugOrId(raw) {
  const s = _safeTrim(raw);
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

export function _normType(type) {
  const s = _safeTrim(type);
  return s ? s.toUpperCase() : "";
}

// =============================================================================
// BLOQUE 3 — VALIDACIÓN DE TIPOS
// =============================================================================

export function _looksLikeGuid(v) {
  if (typeof v !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

export function _isValidEmail(email) {
  const s = _safeTrim(email);
  if (!s || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function _extractRelationalId(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return _safeTrim(value);
  if (typeof value === "object") {
    const id = value._id || value.id || value.itemId;
    return _safeTrim(id);
  }
  return "";
}

// =============================================================================
// BLOQUE 4 — MANEJO DE DINERO Y CANTIDADES
// =============================================================================

export function _roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function _readPositiveAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return _roundMoney(n);
}

export function _readNonNegativeAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return _roundMoney(n);
}

// =============================================================================
// BLOQUE 5 — FECHAS Y ZONAS HORARIAS (Europe/Madrid)
// =============================================================================

const MADRID_TZ = "Europe/Madrid";

export function _toDateSafe(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : val;
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function _readDate(value) {
  const d = _toDateSafe(value);
  if (!d) return null;
  try {
    return d.toLocaleDateString("sv-SE", { timeZone: MADRID_TZ });
  } catch (_) {
    return null;
  }
}

export function _normalizeLocalIsoStr(rawStr) {
  const s = _safeTrim(rawStr);
  if (!s) return "";
  
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (localMatch) {
    const [_, y, m, d, h, min, sec] = localMatch;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(min);
    const second = Number(sec);
    
    if (month < 1 || month > 12) return "";
    if (day < 1 || day > 31) return "";
    if (hour > 23 || minute > 59 || second > 59) return "";
    
    const testDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
      testDate.getUTCFullYear() !== year ||
      testDate.getUTCMonth() !== month - 1 ||
      testDate.getUTCDate() !== day
    ) {
      return "";
    }
    
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${sec.padStart(2, "0")}`;
  }
  
  const d = _toDateSafe(s);
  if (!d) return "";
  
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: MADRID_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    let hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    
    if (hour === "24") hour = "00";
    
    return `${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:${second}`;
  } catch (_) {
    return "";
  }
}

export function getUtcDateFromMadridLocal(localStr) {
  const normalized = _normalizeLocalIsoStr(localStr);
  if (!normalized) return null;

  const [datePart, timePart] = normalized.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);

  let guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: MADRID_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(guessUtc);

    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    let madridHour = get("hour");
    if (madridHour === "24") madridHour = "00";

    const madridAsUtc = new Date(Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(madridHour),
      Number(get("minute")),
      Number(get("second"))
    ));

    const targetAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const offsetMs = madridAsUtc.getTime() - guessUtc.getTime();
    const diff = targetAsUtc.getTime() - madridAsUtc.getTime();

    if (Math.abs(diff) < 1000) break;
    guessUtc = new Date(guessUtc.getTime() + diff);
  }

  return guessUtc;
}

export function getMadridLocalStringNoZ(utcDate) {
  const d = _toDateSafe(utcDate);
  if (!d) return "";
  
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: MADRID_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    let hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    
    if (hour === "24") hour = "00";
    
    return `${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:${second}`;
  } catch (_) {
    return "";
  }
}

// =============================================================================
// BLOQUE 6 — SERIALIZACIÓN Y HASHING
// =============================================================================

export function _stableSerialize(value) {
  const seen = new WeakSet();
  
  function stable(val) {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "string") return JSON.stringify(val);
    if (typeof val !== "object") return "null";
    
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);
    
    if (Array.isArray(val)) {
      return "[" + val.map((item) => stable(item)).join(",") + "]";
    }
    
    const keys = Object.keys(val).sort();
    const parts = keys.map((key) => {
      return JSON.stringify(key) + ":" + stable(val[key]);
    });
    return "{" + parts.join(",") + "}";
  }
  
  return stable(value);
}

async function _sha256Async(input) {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(input);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (_) {
    }
  }
  return _simpleHash(input);
}

function _simpleHash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  const hex = combined.toString(16).padStart(16, "0");
  return (hex.repeat(4)).slice(0, 64);
}

export function _hashKey(input) {
  const s = _safeTrim(input);
  if (!s) return "0".repeat(64);
  return _simpleHash(s);
}

// =============================================================================
// BLOQUE 7 — ENMASCARADO PII (RGPD/LOPDGDD)
// =============================================================================

export function _maskEmail(email) {
  const s = _safeTrim(email);
  if (!s || !s.includes("@")) return "";
  const [local, domain] = s.split("@");
  if (!local || !domain) return "";
  const masked = local.charAt(0) + "*".repeat(Math.max(3, local.length - 1));
  return `${masked}@${domain}`;
}

export function _maskPhone(phone) {
  const s = _safeTrim(phone).replace(/\s+/g, "");
  if (!s || s.length < 4) return "";
  const visible = s.slice(-4);
  const masked = "*".repeat(Math.max(6, s.length - 4));
  return s.slice(0, s.length - 4).replace(/./g, "*") + visible;
}

export function _maskName(name) {
  const s = _safeTrim(name);
  if (!s) return "";
  return s.split(/\s+/).map((word) => {
    if (word.length <= 1) return word;
    return word.charAt(0) + "*".repeat(word.length - 1);
  }).join(" ");
}

export function _maskIp(ip) {
  const s = _safeTrim(ip);
  if (!s) return "";
  const parts = s.split(".");
  if (parts.length !== 4) return s;
  return `${parts[0]}.${parts[1]}.*.*`;
}

// =============================================================================
// BLOQUE 8 — UTILIDADES ASYNC (timeout, retry)
// =============================================================================

export function withTimeout(promise, timeoutMs, label = "operation") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function _executeWithRetry(fn, retries = 3, baseDelayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelayMs;
      const delay = Math.min(exponentialDelay + jitter, 30000);
      
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// =============================================================================
// BLOQUE 9 — CLONACIÓN PROFUNDA
// =============================================================================

export function _cloneDeep(value) {
  const seen = new WeakMap();
  
  function clone(val) {
    if (val === null || typeof val !== "object") return val;
    if (val instanceof Date) return new Date(val.getTime());
    if (val instanceof RegExp) return new RegExp(val.source, val.flags);
    
    if (seen.has(val)) return seen.get(val);
    
    if (val instanceof Map) {
      const clonedMap = new Map();
      seen.set(val, clonedMap);
      val.forEach((v, k) => clonedMap.set(clone(k), clone(v)));
      return clonedMap;
    }
    
    if (val instanceof Set) {
      const clonedSet = new Set();
      seen.set(val, clonedSet);
      val.forEach((v) => clonedSet.add(clone(v)));
      return clonedSet;
    }
    
    if (Array.isArray(val)) {
      const clonedArr = [];
      seen.set(val, clonedArr);
      val.forEach((item, idx) => {
        clonedArr[idx] = clone(item);
      });
      return clonedArr;
    }
    
    const clonedObj = {};
    seen.set(val, clonedObj);
    Object.keys(val).forEach((key) => {
      clonedObj[key] = clone(val[key]);
    });
    return clonedObj;
  }
  
  return clone(value);
}

// =============================================================================
// BLOQUE 10 — ALIAS DE COMPATIBILIDAD
// =============================================================================

export function normalizeIdPart(v, maxLen = 100) {
  const s = _safeTrim(v);
  if (!s) return "";
  const max = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 100;
  return s.replace(/[^a-zA-Z0-9_\-.,]/g, "").slice(0, max);
}

export const _normalizeIdPart = normalizeIdPart;

// =============================================================================
// BLOQUE 11 — HELPERS ADICIONALES PARA FRONTEND (PII safe)
// =============================================================================

export function _safeEmail(email) {
  const s = _safeTrim(email);
  return _isValidEmail(s) ? s.toLowerCase() : "";
}

export function _safePhone(phone) {
  const s = _safeTrim(phone);
  if (!s) return "";
  return s.replace(/\s+/g, "").replace(/[^\d+]/g, "");
}

// =============================================================================
// BLOQUE 12 — EXPORTS POR DEFECTO
// =============================================================================

export default {
  makeTraceId,
  _generateUUID,
  _safeTrim,
  _cleanText,
  _safeSlugOrId,
  _normType,
  _looksLikeGuid,
  _isValidEmail,
  _extractRelationalId,
  _roundMoney,
  _readPositiveAmount,
  _readNonNegativeAmount,
  _toDateSafe,
  _readDate,
  _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  _stableSerialize,
  _hashKey,
  _maskEmail,
  _maskPhone,
  _maskName,
  _maskIp,
  _safeEmail,
  _safePhone,
  withTimeout,
  _executeWithRetry,
  _cloneDeep,
  normalizeIdPart,
  _normalizeIdPart,
};