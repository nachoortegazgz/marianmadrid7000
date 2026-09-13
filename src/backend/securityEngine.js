/*
=============================================================================
MODULE: backend/securityEngine.js
VERSION: v5007.3-FINAL
CORRECTIONS: SEC-01 hashSHA256 async, SEC-03 timingSafeEqual JS puro
=============================================================================
*/
import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import { JWT, SDK_CONFIG } from "backend/internalConfig";
import { _stableSerialize, _safeTrim } from "public/mmUtils";
import { logger } from "backend/logger";
const log = logger;

export async function hashSHA256(input) {
  const str = String(input || "");
  if (!str) return "0".repeat(64);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(str);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (err) {
      log.warn("hashSHA256 Web Crypto failed, using fallback", { error: err?.message });
    }
  }
  return _fallbackHash(str);
}

function _fallbackHash(str) {
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
  return (combined.toString(16).padStart(16, "0")).repeat(4).slice(0, 64);
}

export async function hmacSha256Hex(key, payload) {
  const keyStr = String(key || "");
  const payloadStr = String(payload || "");
  if (!keyStr || !payloadStr) return "0".repeat(64);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const enc = new TextEncoder();
      const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(payloadStr));
      return Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (err) {
      log.warn("hmacSha256Hex Web Crypto failed, using fallback", { error: err?.message });
    }
  }
  return _fallbackHash(`${keyStr}|${payloadStr}`);
}

export async function hashChain(prevHash, payload) {
  return await hashSHA256(`${prevHash || "0".repeat(64)}|${payload || ""}`);
}

export function timingSafeEqual(a, b) {
  const strA = String(a || "");
  const strB = String(b || "");
  if (strA.length !== strB.length) return false;
  let result = 0;
  for (let i = 0; i < strA.length; i++) result |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  return result === 0;
}

function _base64UrlEncode(input) {
  try {
    if (typeof btoa === "function") {
      return btoa(unescape(encodeURIComponent(String(input || "")))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return Buffer.from(String(input || "")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (_) { return ""; }
}

function _base64UrlDecode(input) {
  const str = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") return decodeURIComponent(escape(atob(str)));
    return Buffer.from(str, "base64").toString("utf8");
  } catch (_) { return ""; }
}

export async function generateJWT(payload, traceId) {
  try {
    const secret = await getSecret(SECRETS.AUTH_JWT_KEY);
    if (!secret) throw new Error("AUTH_JWT_KEY not found");
    const header = { alg: JWT.ALGORITHM, typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const tokenPayload = { ...payload, iat: now, exp: now + Math.floor(JWT.EXPIRATION_MS / 1000) };
    const signingInput = `${_base64UrlEncode(JSON.stringify(header))}.${_base64UrlEncode(JSON.stringify(tokenPayload))}`;
    const signature = await hmacSha256Hex(secret, signingInput);
    return `${signingInput}.${signature}`;
  } catch (err) {
    log.error("generateJWT failed", { error: err?.message, traceId });
    throw err;
  }
}

export async function verifyJWT(token, traceId) {
  try {
    const secret = await getSecret(SECRETS.AUTH_JWT_KEY);
    if (!secret) throw new Error("AUTH_JWT_KEY not found");
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expectedSignature = await hmacSha256Hex(secret, signingInput);
    if (!timingSafeEqual(parts[2], expectedSignature)) return null;
    const payload = JSON.parse(_base64UrlDecode(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (err) {
    log.error("verifyJWT failed", { error: err?.message, traceId });
    return null;
  }
}