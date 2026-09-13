/*
=============================================================================
MODULE: public/mmUtils.js
VERSION: v5007.3-FINAL
CORRECTIONS: MMU-01 a MMU-16
=============================================================================
*/
export function makeTraceId(prefix = "op") {
  const safePrefix = typeof prefix === "string" && prefix.length > 0 ? prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) : "op";
  return `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

export function _generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function _safeTrim(v) {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") { try { return String(v).trim(); } catch (_) { return ""; } }
  return v.trim();
}

export function _cleanText(value, maxLength = 500) {
  const s = _safeTrim(value);
  if (!s) return "";
  return s.replace(/\s+/g, " ").slice(0, Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 500);
}

export function _safeSlugOrId(raw) {
  const s = _safeTrim(raw);
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

export function _normType(type) { const s = _safeTrim(type); return s ? s.toUpperCase() : ""; }

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
  if (typeof value === "object") return _safeTrim(value._id || value.id || value.itemId);
  return "";
}

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

const MADRID_TZ = "Europe/Madrid";

export function _toDateSafe(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === "number" && Number.isFinite(val)) { const d = new Date(val); return isNaN(d.getTime()) ? null : d; }
  if (typeof val === "string") { const s = val.trim(); if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  return null;
}

export function _readDate(value) {
  const d = _toDateSafe(value);
  if (!d) return null;
  try { return d.toLocaleDateString("sv-SE", { timeZone: MADRID_TZ }); } catch (_) { return null; }
}

export function _normalizeLocalIsoStr(rawStr) {
  const s = _safeTrim(rawStr);
  if (!s) return "";
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (localMatch) {
    const [_, y, m, d, h, min, sec] = localMatch;
    if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) return "";
    const testDate = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(sec)));
    if (testDate.getUTCFullYear() !== Number(y) || testDate.getUTCMonth() !== Number(m) - 1 || testDate.getUTCDate() !== Number(d)) return "";
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:${sec.padStart(2, "0")}`;
  }
  const d = _toDateSafe(s);
  if (!d) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MADRID_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    let hour = get("hour"); if (hour === "24") hour = "00";
    return `${get("year")}-${get("month")}-${get("day")}T${hour.padStart(2, "0")}:${get("minute")}:${get("second")}`;
  } catch (_) { return ""; }
}

export function getUtcDateFromMadridLocal(localStr) {
  const normalized = _normalizeLocalIsoStr(localStr);
  if (!normalized) return null;
  const [datePart, timePart] = normalized.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  let guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MADRID_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(guessUtc);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    let madridHour = get("hour"); if (madridHour === "24") madridHour = "00";
    const madridAsUtc = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), Number(madridHour), Number(get("minute")), Number(get("second"))));
    const targetAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
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
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MADRID_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    let hour = get("hour"); if (hour === "24") hour = "00";
    return `${get("year")}-${get("month")}-${get("day")}T${hour.padStart(2, "0")}:${get("minute")}:${get("second")}`;
  } catch (_) { return ""; }
}

export function _stableSerialize(value) {
  const seen = new WeakSet();
  function stable(val) {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "string") return JSON.stringify(val);
    if (typeof val !== "object") return "null";
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);
    if (Array.isArray(val)) return "[" + val.map((item) => stable(item)).join(",") + "]";
    return "{" + Object.keys(val).sort().map((key) => JSON.stringify(key) + ":" + stable(val[key])).join(",") + "}";
  }
  return stable(value);
}

export function _hashKey(input) {
  const s = _safeTrim(input);
  if (!s) return "0".repeat(64);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, "0")).repeat(4).slice(0, 64);
}

export function _maskEmail(email) {
  const s = _safeTrim(email);
  if (!s || !s.includes("@")) return "";
  const [local, domain] = s.split("@");
  if (!local || !domain) return "";
  return `${local.charAt(0)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

export function _maskPhone(phone) {
  const s = _safeTrim(phone).replace(/\s+/g, "");
  if (!s || s.length < 4) return "";
  return s.slice(0, s.length - 4).replace(/./g, "*") + s.slice(-4);
}

export function _maskName(name) {
  const s = _safeTrim(name);
  if (!s) return "";
  return s.split(/\s+/).map((w) => w.length <= 1 ? w : w.charAt(0) + "*".repeat(w.length - 1)).join(" ");
}

export function _maskIp(ip) {
  const s = _safeTrim(ip);
  if (!s) return "";
  const parts = s.split(".");
  if (parts.length !== 4) return s;
  return `${parts[0]}.${parts[1]}.*.*`;
}

export function withTimeout(promise, timeoutMs, label = "operation") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    promise.then((r) => { clearTimeout(timer); resolve(r); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

export async function _executeWithRetry(fn, retries = 3, baseDelayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastError = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs, 30000)));
    }
  }
  throw lastError;
}

export function _cloneDeep(value) {
  const seen = new WeakMap();
  function clone(val) {
    if (val === null || typeof val !== "object") return val;
    if (val instanceof Date) return new Date(val.getTime());
    if (val instanceof RegExp) return new RegExp(val.source, val.flags);
    if (seen.has(val)) return seen.get(val);
    if (val instanceof Map) { const cm = new Map(); seen.set(val, cm); val.forEach((v, k) => cm.set(clone(k), clone(v))); return cm; }
    if (val instanceof Set) { const cs = new Set(); seen.set(val, cs); val.forEach((v) => cs.add(clone(v))); return cs; }
    if (Array.isArray(val)) { const ca = []; seen.set(val, ca); val.forEach((item, idx) => { ca[idx] = clone(item); }); return ca; }
    const co = {}; seen.set(val, co); Object.keys(val).forEach((key) => { co[key] = clone(val[key]); }); return co;
  }
  return clone(value);
}

export function normalizeIdPart(v, maxLen = 100) {
  const s = _safeTrim(v);
  if (!s) return "";
  return s.replace(/[^a-zA-Z0-9_\-.,]/g, "").slice(0, Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 100);
}

export const _normalizeIdPart = normalizeIdPart;

export function _safeEmail(email) { const s = _safeTrim(email); return _isValidEmail(s) ? s.toLowerCase() : ""; }

export function _safePhone(phone) { const s = _safeTrim(phone); if (!s) return ""; return s.replace(/\s+/g, "").replace(/[^\d+]/g, ""); }

export default {
  makeTraceId, _generateUUID, _safeTrim, _cleanText, _safeSlugOrId, _normType,
  _looksLikeGuid, _isValidEmail, _extractRelationalId, _roundMoney, _readPositiveAmount,
  _readNonNegativeAmount, _toDateSafe, _readDate, _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal, getMadridLocalStringNoZ, _stableSerialize, _hashKey,
  _maskEmail, _maskPhone, _maskName, _maskIp, _safeEmail, _safePhone,
  withTimeout, _executeWithRetry, _cloneDeep, normalizeIdPart, _normalizeIdPart,
};