/*
=============================================================================
MODULE: backend/logger.js
VERSION: v5007.0-FINAL
BASE: BIBLIA_DEFINITIVA v5002.5 + DIRECTRICES V19 + RGPD/LOPDGDD
RESPONSIBILITY: Motor de logging estructurado transversal.
                - Formato JSON estandarizado con traceId.
                - Sanitizacion recursiva de PII (RGPD/LOPDGDD) y Secretos.
                - Compatibilidad total con Wix Velo serverless (Cero Node.js env vars).
                - Middleware para envoltura automatica de WebMethods.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO dependencias de Node.js (process.env, global).
           ZERO uso de global.__currentTraceId (previene fuga cross-request).
CORRECTIONS APPLIED:
  [LOG-01] Eliminacion de global.__currentTraceId (seguridad serverless).
  [LOG-02] Integracion con makeTraceId de mmUtils para formato canonico.
  [LOG-03] Sanitizacion PII recursiva con enmascarado real (email, phone, name).
  [LOG-04] Proteccion robusta contra referencias circulares.
  [LOG-05] withLogging middleware sin dependencia de traceId global.
=============================================================================
*/

import { makeTraceId, _maskEmail, _maskPhone, _maskName } from "public/mmUtils";

// =============================================================================
// BLOQUE 1 — CONFIGURACION DE NIVELES
// =============================================================================
export const LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
});

// Wix Velo no expone process.env. El nivel se controla mediante este flag.
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

// =============================================================================
// BLOQUE 2 — SANITIZACION PII Y SECRETOS (RGPD/LOPDGDD)
// =============================================================================
const SECRET_FIELD_NAMES = new Set([
  "password", "secret", "token", "apikey", "api_key", "authorization",
  "auth", "bearer", "cookie", "sessionid", "fiscalkey", "hmac",
  "signature", "creditcard", "cardnumber", "cvv", "pin",
]);

const PII_FIELD_NAMES = new Set([
  "email", "phone", "firstname", "lastname", "name",
  "contactdetails", "contact", "address", "ip", "ipaddress",
  "telefono", "correo", "nombre", "apellidos",
]);

/**
 * Sanitiza recursivamente un valor, enmascarando PII y redactando secretos.
 * Protege contra referencias circulares mediante un WeakSet.
 * @param {*} value - Valor a sanitizar
 * @param {WeakSet} seen - Set de objetos ya visitados
 * @returns {*} Valor sanitizado
 */
function sanitizeValue(value, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  // Proteccion contra ciclos
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(value)) {
    const lowerKey = key.toLowerCase().replace(/[-_\s]/g, "");

    if (SECRET_FIELD_NAMES.has(lowerKey)) {
      sanitized[key] = "[REDACTED_SECRET]";
    } else if (PII_FIELD_NAMES.has(lowerKey)) {
      if (typeof val === "string") {
        if (lowerKey.includes("email") || lowerKey.includes("correo")) {
          sanitized[key] = _maskEmail(val);
        } else if (lowerKey.includes("phone") || lowerKey.includes("telefono")) {
          sanitized[key] = _maskPhone(val);
        } else if (
          lowerKey.includes("name") ||
          lowerKey.includes("nombre") ||
          lowerKey.includes("firstname") ||
          lowerKey.includes("lastname") ||
          lowerKey.includes("apellidos")
        ) {
          sanitized[key] = _maskName(val);
        } else {
          sanitized[key] = "[REDACTED_PII]";
        }
      } else {
        sanitized[key] = "[REDACTED_PII]";
      }
    } else if (typeof val === "object" && val !== null) {
      sanitized[key] = sanitizeValue(val, seen);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

// =============================================================================
// BLOQUE 3 — FORMATEO Y ESCRITURA
// =============================================================================

/**
 * Formatea y escribe el log en formato JSON estructurado.
 * NO usa variables globales para el traceId (seguridad serverless).
 * @param {string} level - Nivel de log
 * @param {string} message - Mensaje
 * @param {Object} context - Contexto adicional
 * @param {string} traceId - TraceId explicito (si no se proporciona, se genera)
 */
function formatAndLog(level, message, context = {}, traceId) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;

  // Generar traceId si no se proporciona (sin usar global)
  const finalTraceId = traceId || makeTraceId("log");

  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    traceId: finalTraceId,
    message: String(message),
    ...sanitizeValue(context, new WeakSet()),
  };

  const logLine = JSON.stringify(logEntry);

  switch (level) {
    case "ERROR":
      console.error(logLine);
      break;
    case "WARN":
      console.warn(logLine);
      break;
    case "DEBUG":
      console.log(logLine);
      break;
    default:
      console.info(logLine);
  }
}

// =============================================================================
// BLOQUE 4 — OBJETO LOGGER CANONICO
// =============================================================================
export const logger = {
  /**
   * Log de depuracion (solo en desarrollo)
   */
  debug(message, context = {}, traceId) {
    formatAndLog("DEBUG", message, context, traceId);
  },

  /**
   * Log informativo para operaciones normales
   */
  info(message, context = {}, traceId) {
    formatAndLog("INFO", message, context, traceId);
  },

  /**
   * Log de advertencia para situaciones que requieren atencion
   */
  warn(message, context = {}, traceId) {
    formatAndLog("WARN", message, context, traceId);
  },

  /**
   * Log de error para fallos y excepciones
   */
  error(message, context = {}, traceId) {
    formatAndLog("ERROR", message, context, traceId);
  },

  /**
   * Log de error con stack trace completo
   */
  errorWithStack(error, context = {}, traceId) {
    const errorContext = {
      ...context,
      name: error?.name || "Error",
      message: error?.message || "Unknown error",
      stack: error?.stack,
      code: error?.code,
    };
    formatAndLog("ERROR", error?.message || "Unknown error", errorContext, traceId);
  },

  /**
   * Crea un child logger con contexto predefinido
   */
  child(defaultContext = {}) {
    return {
      debug: (message, context = {}, traceId) =>
        formatAndLog("DEBUG", message, { ...defaultContext, ...context }, traceId),
      info: (message, context = {}, traceId) =>
        formatAndLog("INFO", message, { ...defaultContext, ...context }, traceId),
      warn: (message, context = {}, traceId) =>
        formatAndLog("WARN", message, { ...defaultContext, ...context }, traceId),
      error: (message, context = {}, traceId) =>
        formatAndLog("ERROR", message, { ...defaultContext, ...context }, traceId),
      errorWithStack: (error, context = {}, traceId) => {
        const errorContext = {
          ...defaultContext,
          ...context,
          name: error?.name || "Error",
          message: error?.message || "Unknown error",
          stack: error?.stack,
        };
        formatAndLog("ERROR", error?.message || "Unknown error", errorContext, traceId);
      },
    };
  },
};

// =============================================================================
// BLOQUE 5 — MIDDLEWARE DE ENVOLTURA
// =============================================================================

/**
 * Envuelve funciones async con logging automatico y medicion de duracion.
 * Inyecta el traceId en el contexto de la ejecucion sin usar variables globales.
 * @param {Function} fn - Funcion async a envolver
 * @param {string} operationName - Nombre descriptivo de la operacion
 * @param {Object} defaultContext - Contexto por defecto
 * @returns {Function} Funcion envuelta con logging
 */
export function withLogging(fn, operationName, defaultContext = {}) {
  return async function (...args) {
    const traceId = makeTraceId(operationName);
    const start = Date.now();

    try {
      logger.info(`${operationName}_started`, { ...defaultContext, argsCount: args.length }, traceId);
      const result = await fn(...args);
      const duration = Date.now() - start;
      logger.info(`${operationName}_completed`, { ...defaultContext, duration, success: true }, traceId);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.errorWithStack(error, { ...defaultContext, duration, success: false }, traceId);
      throw error;
    }
  };
}

export default logger;