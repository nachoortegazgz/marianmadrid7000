/*
=============================================================================
MODULE: backend/logger.js
VERSION: v5007.3-FINAL
CORRECTIONS: LOG-01 sin global, LOG-03 PII recursiva con enmascarado real
=============================================================================
*/
import { makeTraceId, _maskEmail, _maskPhone, _maskName } from "public/mmUtils";

export const LOG_LEVELS = Object.freeze({ DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 });
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

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

function sanitizeValue(value, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  const sanitized = {};
  for (const [key, val] of Object.entries(value)) {
    const lowerKey = key.toLowerCase().replace(/[-_\s]/g, "");
    if (SECRET_FIELD_NAMES.has(lowerKey)) {
      sanitized[key] = "[REDACTED_SECRET]";
    } else if (PII_FIELD_NAMES.has(lowerKey)) {
      if (typeof val === "string") {
        if (lowerKey.includes("email") || lowerKey.includes("correo")) sanitized[key] = _maskEmail(val);
        else if (lowerKey.includes("phone") || lowerKey.includes("telefono")) sanitized[key] = _maskPhone(val);
        else if (lowerKey.includes("name") || lowerKey.includes("nombre") || lowerKey.includes("firstname") || lowerKey.includes("lastname") || lowerKey.includes("apellidos")) sanitized[key] = _maskName(val);
        else sanitized[key] = "[REDACTED_PII]";
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

function formatAndLog(level, message, context = {}, traceId) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;
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
    case "ERROR": console.error(logLine); break;
    case "WARN": console.warn(logLine); break;
    case "DEBUG": console.log(logLine); break;
    default: console.info(logLine);
  }
}

export const logger = {
  debug(message, context = {}, traceId) { formatAndLog("DEBUG", message, context, traceId); },
  info(message, context = {}, traceId) { formatAndLog("INFO", message, context, traceId); },
  warn(message, context = {}, traceId) { formatAndLog("WARN", message, context, traceId); },
  error(message, context = {}, traceId) { formatAndLog("ERROR", message, context, traceId); },
  errorWithStack(error, context = {}, traceId) {
    const errorContext = { ...context, name: error?.name || "Error", message: error?.message, stack: error?.stack, code: error?.code };
    formatAndLog("ERROR", error?.message || "Unknown error", errorContext, traceId);
  },
  child(defaultContext = {}) {
    return {
      debug: (m, c = {}, t) => formatAndLog("DEBUG", m, { ...defaultContext, ...c }, t),
      info: (m, c = {}, t) => formatAndLog("INFO", m, { ...defaultContext, ...c }, t),
      warn: (m, c = {}, t) => formatAndLog("WARN", m, { ...defaultContext, ...c }, t),
      error: (m, c = {}, t) => formatAndLog("ERROR", m, { ...defaultContext, ...c }, t),
      errorWithStack: (e, c = {}, t) => {
        const ec = { ...defaultContext, ...c, name: e?.name || "Error", message: e?.message, stack: e?.stack };
        formatAndLog("ERROR", e?.message || "Unknown error", ec, t);
      },
    };
  },
};

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