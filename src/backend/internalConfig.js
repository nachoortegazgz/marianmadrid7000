/*
=============================================================================
MODULE: backend/internalConfig.js
VERSION: v5007.3-FINAL
BASE: BIBLIA_DEFINITIVA v5002.5 + ESQUEMA CMS v5002.5 + DIRECTRICES V19
RESPONSIBILITY: Single Source of Truth (SSOT) for backend configuration:
                - Canonical PascalCase CMS collection IDs (32 + 1 aux)
                - Wix App IDs
                - SDK V2 execution constraints
                - Business enums (frozen, zero legacy)
                - Staff, concurrency, timeouts, caches, rate limits
                - Validation helpers for addon IDs
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO deprecated keys. ZERO legacy aliases. ZERO trailing spaces.
CORRECTIONS APPLIED:
  [FIX-D4] validateActiveNativeAddonIds() helper para validacion de GUIDs.
=============================================================================
*/

// =============================================================================
// BLOQUE 1 — STAFF ACTIVO (SSOT MapaStaff)
// =============================================================================
export const STAFF = Object.freeze({
  IDS: Object.freeze([
    "e556070a-6d6a-402e-8422-11133033ea76",
    "07f7344f-e7e4-4c53-854b-47fd82ac8d40",
    "9b905bfd-1a09-485d-9273-a24a20dfe648",
  ]),
  RESOURCE_TO_DISPLAY: Object.freeze({
    "e556070a-6d6a-402e-8422-11133033ea76": "Marian Madrid",
    "07f7344f-e7e4-4c53-854b-47fd82ac8d40": "Andrea",
    "9b905bfd-1a09-485d-9273-a24a20dfe648": "Alba",
  }),
});

// =============================================================================
// BLOQUE 2 — COLECCIONES CMS CANONICAS (32 + 1 auxiliar)
// =============================================================================
export const COLLECTIONS = Object.freeze({
  // M1: Catalogo y maestros
  CATEGORIAS_SERVICIO: "CategoriasServicio",
  SERVICIOS_CATALOGO: "ServiciosCatalogo",
  COMPLEMENTOS_CATALOGO: "ComplementosCatalogo",
  MAPA_STAFF: "MapaStaff",
  CITAS_F2: "CitasF2",

  // M2: Cache de disponibilidad
  AVAILABILITY_DAYS_CACHE: "AvailabilityDaysCache",
  DUAL_SLOT_CACHE: "DualSlotCache",

  // M3: Orquestacion transaccional
  BOOKING_TRANSACTIONS: "BookingTransactions",
  BOOKINGS_SERVICE_SYNC_QUEUE: "BookingsServiceSyncQueue",
  COMPENSACIONES_PENDIENTES: "CompensacionesPendientes",
  M365_GRAPH_SYNC_QUEUE: "M365GraphSyncQueue",
  MM_PROCESSED_EVENTS: "MM_ProcessedEvents",

  // M4: Inventario
  INVENTARIO_STOCK_VENTA: "InventarioStockVenta",
  MOVIMIENTOS_INVENTARIO: "MovimientosInventario",
  INVENTARIO_STOCK_VENTA_CIERRE: "InventarioStockVentaCierre",
  PROVEEDORES_LISTA: "ProveedoresLista",

  // M5: Caja fisica y cierres
  CAJA_ACTUAL: "CajaActual",
  MOVIMIENTOS_CAJA: "MovimientosCaja",
  CONTROL_PARCIAL_X: "ControlParcialX",
  HISTORICO_CIERRES_Z: "HistoricoCierresZ",
  SECUENCIA_TICKETS: "SecuenciaTickets",

  // M6: Fiscal y contable (PGC)
  CONFIGURACION_FISCAL: "ConfiguracionFiscal",
  LIBRO_IVA_FACTURAS_EXPEDIDAS: "LibroIVAFacturasExpedidas",
  LIBRO_IVA_FACTURAS_RECIBIDAS: "LibroIVAFacturasRecibidas",
  PLAN_CUENTAS_CONTABLES: "PlanCuentasContables",
  ASIENTOS_CONTABLES: "AsientosContables",
  LINEAS_ASIENTO_CONTABLE: "LineasAsientoContable",
  LIBRO_MAYOR_CONTABLE_SALDOS: "LibroMayorContableSaldos",

  // M7: Auditoria, SIF y laboral
  EVENTOS_SISTEMA_FACTURACION: "EventosSistemaFacturacion",
  MM_AUDIT_LOG: "MmAuditLog",
  REGISTROS_HORARIOS_STAFF: "RegistrosHorariosStaff",

  // Infraestructura
  SLOT_LOCKS: "SlotLocks",
  RATE_LIMIT_BLOCKS: "RateLimitBlocks",
  ALERTAS_OPERATIVAS: "AlertasOperativas",
});

// =============================================================================
// BLOQUE 3 — WIX APP IDs
// =============================================================================
export const APP_IDS = Object.freeze({
  BOOKINGS: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
  STORES: "1380b703-ce81-ff05-f115-39571d94eab3",
  EVENTS: "140603ad-af8d-84fb-9004-ee174e35054d",
  FORMS_PAYMENTS: "14ce1214-b278-a7e4-1373-00cebd1bef7c",
  INVOICES: "13ee94c1-b635-8505-3391-97919052c16f",
  MEMBERS_AREA: "14cc59bc-f0b7-15b8-e1c7-89ce41d0e0c9",
  GIFT_CARDS: "d80111c5-a0f4-47a8-b63a-65b54d774a27",
});

// =============================================================================
// BLOQUE 4 — API KEYS Y RECURSOS WIX NATIVOS
// =============================================================================
export const API = Object.freeze({
  STAFF_RESOURCE_TYPE_ID: "1cd44cf8-756f-41c3-bd90-3e2ffcaf1155",
  MARIAN_MANAGEMENT_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 5 — SINGLETONS PROTEGIDOS
// =============================================================================
export const SINGLETONS = Object.freeze({
  CAJA: "CAJA_PRINCIPAL",
});

// =============================================================================
// BLOQUE 6 — CONFIGURACION GLOBAL DEL SDK
// =============================================================================
export const SDK_CONFIG = Object.freeze({
  TZ: "Europe/Madrid",
  LOCATION_ID: "7a12abfd-bf30-4847-bcdf-00dc573d4802",
  LOCATION_TYPES: Object.freeze({
    TIME_SLOTS: "BUSINESS",
    BOOKINGS_WRITER: "OWNER_BUSINESS",
  }),
  TIMEOUTS: Object.freeze({
    API_MS: 15000,
    BOOKING_CREATION_MS: 25000,
    DUAL_BOOKING_MS: 40000,
    CHECKOUT_MS: 20000,
    CMS_MS: 15000,
    WATCHDOG_MS: 30000,
    WEBHOOK_MS: 30000,
  }),
  CACHE: Object.freeze({
    SERVICES_TTL_MS: 600000,
    SLOTS_CACHE_TTL_MS: 120000,
    DUAL_CACHE_TTL_MS: 900000,
    STAFF_TTL_MS: 300000,
    MAX_ENTRIES: 100,
    DAYS_CACHE_VERSION: 1,
  }),
  SECURITY: Object.freeze({
    SECRET_CACHE_TTL_MS: 300000,
    RATE_LIMIT_CACHE_CLEANUP_TTL_MS: 60000,
    RATE_LIMIT_CACHE_MAX_ENTRIES: 5000,
  }),
  RATE_LIMIT: Object.freeze({
    MAX_REQUESTS: 20,
    WINDOW_MS: 5000,
    BOOKING_MAX_REQUESTS: 5,
    BOOKING_WINDOW_MS: 10000,
    AVAILABILITY_WINDOW_MS: 5000,
    AVAILABILITY_REQUESTER_MAX_REQUESTS: 12,
    AVAILABILITY_GLOBAL_MAX_REQUESTS: 120,
  }),
  JOBS: Object.freeze({
    TIMEOUT_MS: 30000,
    AUDIT_RETENTION_DAYS: 90,
    DELETE_BATCH_SIZE: 100,
    DELETE_MAX_PAGES: 10,
    DUAL_CACHE_CLEANUP_LIMIT: 100,
    FISCAL_RECOVERY_BATCH_SIZE: 25,
    HEALTH_CHECK_QUERY_LIMIT: 100,
    FISCAL_DAILY_MAX_PAGES: 50,
    BOOKINGS_SERVICE_SYNC_MAX_ATTEMPTS: 5,
    BOOKINGS_SERVICE_SYNC_BATCH_SIZE: 20,
    BOOKINGS_SERVICE_SYNC_BACKOFF_MS: 300000,
    M365_GRAPH_SYNC_BATCH_SIZE: 20,
    M365_GRAPH_SYNC_MAX_ATTEMPTS: 3,
    M365_GRAPH_SYNC_BACKOFF_MS: 300000,
  }),
  EVENTS: Object.freeze({
    RETRY_ATTEMPTS: 3,
    RETRY_BASE_BACKOFF_MS: 1000,
  }),
  EXTERNAL_HTTP: Object.freeze({
    RATE_LIMIT_MAX_REQUESTS: 20,
    RATE_LIMIT_WINDOW_MS: 5000,
    HMAC_MAX_CLOCK_SKEW_SECONDS: 60,
    CORS_ALLOWED_ORIGINS: Object.freeze([
      "https://www.marianmadrid.es",
      "https://marianmadrid.es",
    ]),
  }),
  M365: Object.freeze({ ENABLED: false }),
  ACCOUNTING: Object.freeze({ ENABLED: false }),
  DOCUMENTS: Object.freeze({
    DEFAULT_MANAGER_EMAIL: "gestion@marianmadrid.es",
    MAX_EMAIL_ATTACHMENT_BYTES: 3145728,
    MAX_EMAIL_SEND_ATTEMPTS: 3,
  }),
});

// =============================================================================
// BLOQUE 7 — CONCURRENCIA, LOCKS Y TRANSACCIONES
// =============================================================================
export const CONCURRENCY = Object.freeze({
  MUTEX_TTL_MS: 300000,
  HEARTBEAT_MS: 15000,
  TRANSACTION_POLL_BASE_MS: 250,
  TRANSACTION_MAX_WAIT_MS: 3000,
  LOCK_CLEANUP_GRACE_MS: 60000,
  MAX_COMPENSATION_RETRIES: 3,
  LEDGER_MUTEX_TTL_MS: 45000,
  LOCK_RELEASE_MIN_REMAINING_MS: 15000,
  DEFAULT_DURATION_MIN: 30,
});

// =============================================================================
// BLOQUE 8 — ENUMS DE NEGOCIO
// =============================================================================
export const TIPO_FICHAJE = Object.freeze({
  ENTRADA: "ENTRADA",
  SALIDA: "SALIDA",
  PAUSA_INICIO: "PAUSA_INICIO",
  PAUSA_FIN: "PAUSA_FIN",
  AJUSTE: "AJUSTE",
});

export const TIPO_MOVIMIENTO = Object.freeze({
  VENTA_EFECTIVO: "VENTA_EFECTIVO",
  VENTA_TARJETA: "VENTA_TARJETA",
  VENTA_BIZUM: "VENTA_BIZUM",
  VENTA_ONLINE: "VENTA_ONLINE",
  VENTA_PRODUCTO: "VENTA_PRODUCTO",
  VENTA_PRODUCTO_ONLINE: "VENTA_PRODUCTO_ONLINE",
  VENTA_TARJETA_REGALO: "VENTA_TARJETA_REGALO",
  CANJE_TARJETA_REGALO: "CANJE_TARJETA_REGALO",
  REEMBOLSO: "REEMBOLSO",
  DEVOLUCION_SERVICIO: "DEVOLUCION_SERVICIO",
  DEVOLUCION_PRODUCTO: "DEVOLUCION_PRODUCTO",
  AJUSTE: "AJUSTE",
  PROPINA: "PROPINA",
  APORTE: "APORTE",
  RETIRO: "RETIRO",
  GASTO: "GASTO",
  PAGO_PROVEEDOR: "PAGO_PROVEEDOR",
  ANTICIPO: "ANTICIPO",
  FONDO_INICIAL: "FONDO_INICIAL",
});

export const FORMA_PAGO = Object.freeze({
  EFECTIVO: "EFECTIVO",
  TARJETA: "TARJETA",
  BIZUM: "BIZUM",
  ONLINE: "ONLINE",
  TARJETA_REGALO: "TARJETA_REGALO",
});

export const IVA_RATES = Object.freeze({
  GENERAL: 0.21,
  REDUCIDO: 0.10,
  SUPERREDUCIDO: 0.04,
  EXENTO: 0.0,
});

export const CAJA_STATUS = Object.freeze({
  OPEN: "ABIERTA",
  CLOSED: "CERRADA",
});

export const ESTADO_CITA = Object.freeze({
  CONFIRMED: "CONFIRMED",
  PENDING_PAYMENT: "PENDING_PAYMENT",
  CANCELED: "CANCELED",
  REFUNDED: "REFUNDED",
});

export const ESTADO_PAGO = Object.freeze({
  UNPAID: "UNPAID",
  NOT_PAID: "NOT_PAID",
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PENDING_LEDGER: "PENDING_LEDGER",
  PAID: "PAID",
  REFUNDED: "REFUNDED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
});

export const COLLAB_ROLES = Object.freeze({
  ADMIN: "ADMIN",
  GESTION: "GESTION",
  ESTILISTA: "ESTILISTA",
});

// =============================================================================
// BLOQUE 9 — CONSTANTES DE CATALOGO Y BUSQUEDA DE SLOTS
// =============================================================================
export const SERVICE_CATALOG = Object.freeze({
  STATES: Object.freeze({
    ACTIVO: "ACTIVO",
    INACTIVO: "INACTIVO",
    BORRADOR: "BORRADOR",
  }),
  CURRENCY: "EUR",
  MAX_TITLE_LENGTH: 160,
  MAX_SUMMARY_LENGTH: 120,
  MAX_DESCRIPTION_LENGTH: 6000,
  MAX_DURATION_MINUTES: 1440,
});

export const SLOT_SEARCH = Object.freeze({
  DIAS_LIMITE: 14,
  TOLERANCE_MINUTES: 10,
});

export const BOOKINGS_ADDON_CONFIG = Object.freeze({
  MAX_PER_BOOKING: 5,
  ACTIVE_NATIVE_IDS: Object.freeze([
    // TODO: Poblar desde el panel de Wix Bookings antes de produccion.
    // Formato: ["GUID-addon-1", "GUID-addon-2", ...]
  ]),
});

// =============================================================================
// BLOQUE 10 — JWT Y SEGURIDAD
// =============================================================================
export const JWT = Object.freeze({
  ALGORITHM: "HS256",
  EXPIRATION_MS: 1800000,
});

// =============================================================================
// BLOQUE 11 — CAMPOS DE CITA
// =============================================================================
export const CITA_FIELDS = Object.freeze({
  STATUS: "status",
  STATUS_PAGO: "paymentStatus",
  STATUS_PAGO_LEGACY: "statusPago",
  PAIR_TOKEN: "pairToken",
  UI_PAIR_TOKEN: "uiPairToken",
  SERVICE_ID: "serviceId",
  RESOURCE_ID: "resourceId",
  BOOKING_ID: "bookingId",
  DATE_YMD: "dateYmd",
  META: "meta",
});

// =============================================================================
// BLOQUE 12 — ACCESO Y ROLES
// =============================================================================
export const STAFF_ACCESS = Object.freeze({
  ALLOWED_ROLES: Object.freeze(["ADMIN", "GESTION", "ESTILISTA"]),
  MARIAN_RESOURCE_ID: "e556070a-6d6a-402e-8422-11133033ea76",
});

// =============================================================================
// BLOQUE 13 — DINERO Y TEXTO POR DEFECTO
// =============================================================================
export const MONEY = Object.freeze({
  DISPLAY_CURRENCY: "EUR",
  DECIMALS: 2,
});

export const STAFF_DEFAULT_NAME = "Profesional";

// =============================================================================
// BLOQUE 14 — IDENTIDADES LEGACY PROHIBIDAS
// =============================================================================
export const FORBIDDEN_LEGACY_IDS = Object.freeze({
  primaryServiceGuid: "serviceId",
  secondaryServiceGuid: "linkedPhases",
  staffId: "resourceId",
  empleada: "resource",
  lockKey: "slotKey",
  resourceName: "displayName",
  MmLocks: "SlotLocks",
  CONCILIACION_STOCK_WIX: "MovimientosInventario",
  SYNC_M365: "M365GraphSyncQueue",
  AVAILABILITY_SLOTS_CACHE: "DualSlotCache",
});

// =============================================================================
// BLOQUE 15 — [FIX-D4] VALIDACION DE ACTIVE_NATIVE_IDS
// =============================================================================

/**
 * Valida que todos los ACTIVE_NATIVE_IDS son GUIDs validos.
 * Llamar en systemHealthCheck o en el arranque del modulo reservas.web.js.
 *
 * @returns {Object} { valid: boolean, invalidIds: string[], count: number, isEmpty: boolean }
 */
export function validateActiveNativeAddonIds() {
  const ids = BOOKINGS_ADDON_CONFIG.ACTIVE_NATIVE_IDS;
  const invalidIds = [];

  for (const id of ids) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      invalidIds.push(String(id));
    }
  }

  return {
    valid: invalidIds.length === 0,
    invalidIds,
    count: ids.length,
    isEmpty: ids.length === 0,
  };
}