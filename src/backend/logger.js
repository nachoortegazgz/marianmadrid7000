/**
 * Logger Estructurado para Wix Velo
 * 
 * Formato JSON estandarizado con:
 * - Timestamp ISO 8601
 * - Nivel de log (INFO, WARN, ERROR, DEBUG)
 * - TraceID para correlacionacion de trazas
 * - Contexto adicional en formato key-value
 * 
 * Uso:
 *   import { logger } from 'backend/logger';
 *   logger.info('operacion_completada', { userId, duration: 123 });
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// Wix Velo does not expose Node.js environment variables in the backend runtime.
// Keep the production default explicit until configuration is provided by Wix.
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

/**
 * Genera un traceId unico para correlacionar logs de una misma operacion
 */
function generateTraceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback para entornos sin crypto.randomUUID
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Obtiene el traceId del contexto actual o genera uno nuevo
 */
function getOrGenerateTraceId(traceId) {
  if (traceId) {
    return traceId;
  }
  // Intentar obtener de global si existe
  if (typeof global !== 'undefined' && global.__currentTraceId) {
    return global.__currentTraceId;
  }
  const newTraceId = generateTraceId();
  if (typeof global !== 'undefined') {
    global.__currentTraceId = newTraceId;
  }
  return newTraceId;
}

/**
 * Formatea y escribe el log en formato JSON estructurado
 */
function formatAndLog(level, message, context = {}, traceId) {
  if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) {
    return;
  }

  const finalTraceId = getOrGenerateTraceId(traceId);
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level,
    traceId: finalTraceId,
    message: String(message),
    ...context
  };

  // Sanitizar datos sensibles antes de loguear
  sanitizeLogEntry(logEntry);

  const logLine = JSON.stringify(logEntry);

  switch (level) {
    case 'ERROR':
      console.error(logLine);
      break;
    case 'WARN':
      console.warn(logLine);
      break;
    case 'DEBUG':
      console.log(logLine); // Debug va a info por defecto
      break;
    default:
      console.info(logLine);
  }
}

const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'secret', 'token', 'apikey', 'api_key',
  'creditcard', 'cardnumber', 'cvv', 'pin',
  'authorization', 'auth', 'bearer'
]);

function sanitizeLogValue(value, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);

  for (const key of Object.keys(value)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (SENSITIVE_FIELD_NAMES.has(normalizedKey) || SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      value[key] = '[REDACTED]';
    } else if (typeof value[key] === 'object' && value[key] !== null) {
      sanitizeLogValue(value[key], seen);
    }
  }
  return value;
}

/**
 * Sanitiza el log entry para evitar exponer datos sensibles, incluidos objetos anidados.
 */
function sanitizeLogEntry(entry) {
  sanitizeLogValue(entry, new Set());
  if (typeof entry.error === 'string') {
    const errorLower = entry.error.toLowerCase();
    if (errorLower.includes('secret') || errorLower.includes('token') || errorLower.includes('unauthorized')) {
      entry.error = '[REDACTED_ERROR]';
    }
  }
}

/**
 * Objeto logger con metodos para cada nivel
 */
export const logger = {
  /**
   * Log de depuracion (solo en desarrollo)
   */
  debug(message, context = {}, traceId) {
    formatAndLog('DEBUG', message, context, traceId);
  },

  /**
   * Log informativo para operaciones normales
   */
  info(message, context = {}, traceId) {
    formatAndLog('INFO', message, context, traceId);
  },

  /**
   * Log de advertencia para situaciones que requieren atencion
   */
  warn(message, context = {}, traceId) {
    formatAndLog('WARN', message, context, traceId);
  },

  /**
   * Log de error para fallos y excepciones
   */
  error(message, context = {}, traceId) {
    formatAndLog('ERROR', message, context, traceId);
  },

  /**
   * Log de error con stack trace completo
   */
  errorWithStack(error, context = {}, traceId) {
    const errorContext = {
      ...context,
      name: error.name || 'Error',
      message: error.message,
      stack: error.stack,
      code: error.code
    };
    formatAndLog('ERROR', error.message || 'Unknown error', errorContext, traceId);
  },

  /**
   * Crea un child logger con contexto predefinido
   */
  child(defaultContext = {}) {
    return {
      debug: (message, context = {}, traceId) => 
        this.debug(message, { ...defaultContext, ...context }, traceId),
      info: (message, context = {}, traceId) => 
        this.info(message, { ...defaultContext, ...context }, traceId),
      warn: (message, context = {}, traceId) => 
        this.warn(message, { ...defaultContext, ...context }, traceId),
      error: (message, context = {}, traceId) => 
        this.error(message, { ...defaultContext, ...context }, traceId),
      errorWithStack: (error, context = {}, traceId) => 
        this.errorWithStack(error, { ...defaultContext, ...context }, traceId)
    };
  },

  /**
   * Establece el traceId global para el contexto actual
   */
  setTraceId(traceId) {
    if (typeof global !== 'undefined') {
      global.__currentTraceId = traceId;
    }
  },

  /**
   * Obtiene el traceId actual
   */
  getTraceId() {
    if (typeof global !== 'undefined' && global.__currentTraceId) {
      return global.__currentTraceId;
    }
    return generateTraceId();
  }
};

/**
 * Middleware para envolver funciones async con logging automatico
 */
export function withLogging(fn, operationName, defaultContext = {}) {
  return async function(...args) {
    const traceId = logger.getTraceId();
    const start = Date.now();
    
    try {
      logger.info(`${operationName}_started`, { 
        ...defaultContext, 
        argsCount: args.length 
      }, traceId);
      
      const result = await fn(...args);
      const duration = Date.now() - start;
      
      logger.info(`${operationName}_completed`, { 
        ...defaultContext, 
        duration,
        success: true 
      }, traceId);
      
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      
      logger.errorWithStack(error, { 
        ...defaultContext, 
        duration,
        success: false 
      }, traceId);
      
      throw error;
    }
  };
}

export default logger;
