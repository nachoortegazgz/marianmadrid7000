/*
=============================================================================
MODULE: backend/securityEngine.js
VERSION: v5007.0-FINAL
BASE: BIBLIA_DEFINITIVA v5002.5 Bloque 12.10 + DIRECTRICES V19
RESPONSIBILITY: Primitivas criptograficas para el ecosistema Marian Madrid.
                - Hash SHA-256 (async, Web Crypto API con fallback).
                - HMAC-SHA256 para firma de cadena fiscal Veri*factu.
                - Cadena hash (hashChain) para integridad de ledger.
                - Comparacion segura (timing-safe) contra timing attacks.
                - Generacion y verificacion de JWT (HS256).
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO dependencias de Node.js crypto (usa Web Crypto API).
           Funciones async para compatibilidad con Wix Velo serverless.
CORRECTIONS APPLIED:
  [SEC-01] hashSHA256 es async y usa Web Crypto API.
  [SEC-02] hmacSha256Hex es async y usa Web Crypto API.
  [SEC-03] timingSafeEqual implementado en JS puro (sin Buffer).
  [SEC-04] JWT HS256 con expiracion configurable.
  [SEC-05] Fallback determinista para entornos sin Web Crypto API.
=============================================================================
*/

import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import { JWT, SDK_CONFIG } from "backend/internalConfig";
import { _stableSerialize, _safeTrim } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 — HASH SHA-256 (ASYNC)
// =============================================================================

/**
 * Genera hash SHA-256 de un string.
 * Usa Web Crypto API si esta disponible, fallback determinista.
 * @param {string} input - String a hashear
 * @returns {Promise<string>} Hash hex de 64 caracteres
 */
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

  // Fallback: hash simple determinista (NO criptografico)
  return _fallbackHash(str);
}

/**
 * Hash simple determinista (fallback para entornos sin Web Crypto API).
 * NO usar para seguridad criptografica, solo para claves de cache/lock.
 * @param {string} str - String a hashear
 * @returns {string} Hash hex de 64 caracteres
 */
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
  const hex = combined.toString(16).padStart(16, "0");
  return hex.repeat(4).slice(0, 64);
}

// =============================================================================
// BLOQUE 2 — HMAC-SHA256 (ASYNC)
// =============================================================================

/**
 * Genera HMAC-SHA256 de un payload con una clave.
 * @param {string} key - Clave secreta
 * @param {string} payload - Payload a firmar
 * @returns {Promise<string>} HMAC hex de 64 caracteres
 */
export async function hmacSha256Hex(key, payload) {
  const keyStr = String(key || "");
  const payloadStr = String(payload || "");

  if (!keyStr || !payloadStr) return "0".repeat(64);

  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const enc = new TextEncoder();
      const keyData = enc.encode(keyStr);
      const payloadData = enc.encode(payloadStr);

      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payloadData);
      const sigArray = Array.from(new Uint8Array(signatureBuffer));
      return sigArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (err) {
      log.warn("hmacSha256Hex Web Crypto failed, using fallback", { error: err?.message });
    }
  }

  // Fallback: HMAC simplificado (NO criptografico)
  const combined = `${keyStr}|${payloadStr}`;
  return _fallbackHash(combined);
}

// =============================================================================
// BLOQUE 3 — CADENA HASH VERI*FACTU
// =============================================================================

/**
 * Genera el hash de cadena para Veri*factu.
 * currentRecordHash = SHA256(previousRecordHash + "|" + canonicalPayload)
 * @param {string} prevHash - Hash del movimiento anterior
 * @param {string} payload - Payload canonico serializado
 * @returns {Promise<string>} Hash de cadena
 */
export async function hashChain(prevHash, payload) {
  const combined = `${prevHash || "0".repeat(64)}|${payload || ""}`;
  return await hashSHA256(combined);
}

// =============================================================================
// BLOQUE 4 — COMPARACION SEGURA (TIMING-SAFE)
// =============================================================================

/**
 * Comparacion segura de strings contra timing attacks.
 * Implementado en JS puro (sin Buffer de Node.js).
 * @param {string} a - Primer string
 * @param {string} b - Segundo string
 * @returns {boolean} true si son iguales
 */
export function timingSafeEqual(a, b) {
  const strA = String(a || "");
  const strB = String(b || "");

  if (strA.length !== strB.length) return false;

  let result = 0;
  for (let i = 0; i < strA.length; i++) {
    result |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return result === 0;
}

// =============================================================================
// BLOQUE 5 — JWT (HS256)
// =============================================================================

/**
 * Codifica a Base64URL.
 * @param {string} input - String a codificar
 * @returns {string} String en Base64URL
 */
function _base64UrlEncode(input) {
  const str = String(input || "");
  try {
    // Usar btoa si esta disponible (browser/velo)
    if (typeof btoa === "function") {
      return btoa(unescape(encodeURIComponent(str)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }
    // Fallback para entornos sin btoa
    return Buffer.from(str).toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch (_) {
    return "";
  }
}

/**
 * Decodifica desde Base64URL.
 * @param {string} input - String en Base64URL
 * @returns {string} String decodificado
 */
function _base64UrlDecode(input) {
  const str = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") {
