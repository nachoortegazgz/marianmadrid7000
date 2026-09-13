/*
=============================================================================
MODULE: backend/reservas.web.js
VERSION: v5007.4-FINAL (FIX E-34 aplicado correctamente)
BASE: BIBLIA v5002.5 + MOTOR DE RESERVAS + DIRECTRICES V19 + ESQUEMA CMS v5002.5
RESPONSIBILITY: Motor de disponibilidad. Consulta Wix Bookings V2 API,
                construye slots duales con gap, balancea carga por profesional,
                gestiona cache multicapa (RAM + CMS) y rate limiting.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           ZERO legacy (serviceId, linkedPhases, resourceId).
CORRECTIONS APPLIED:
  [RES-01] Colecciones canonicas del SSOT.
  [RES-02] Nomenclatura v19.6: serviceId, linkedPhases.
  [RES-03] Campos canonicos de ServiciosCatalogo.
  [RES-04] Paginacion en _getBookedMinutesByResourceForDay.
  [RES-05] Cache multicapa: RAM + AvailabilityDaysCache + DualSlotCache.
  [RES-06] Balanceo por carga horaria con _rankResourcesByLoad.
  [RES-07] Gap que libera profesional durante exposureDuration.
  [RES-08] Revalidacion en tiempo real antes de Saga (skipCache: true).
  [FIX A1] _resolveStaffForSlotInternal() implementado completamente.
  [FIX E-34] _invalidateCachesInternal corregido para evitar ReferenceError.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { availabilityTimeSlots } from "wix-bookings.v2";

import {
  COLLECTIONS,
  SDK_CONFIG,
  API,
  SLOT_SEARCH,
  BOOKINGS_ADDON_CONFIG,
  STAFF_DEFAULT_NAME,
  MONEY,
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid,
  _normalizeLocalIsoStr,
  getUtcDateFromMadridLocal,
  getMadridLocalStringNoZ,
  _executeWithRetry,
  _hashKey,
  _generateUUID,
  withTimeout,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { findStaff } from "backend/staff";
import { requireAdmin, rateLimiter } from "backend/security";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES CANONICAS DEL SSOT
// =============================================================================
const SERVICIOS_COL = COLLECTIONS.SERVICIOS_CATALOGO;
const DUAL_CACHE_COL = COLLECTIONS.DUAL_SLOT_CACHE;
const DAYS_CACHE_COL = COLLECTIONS.AVAILABILITY_DAYS_CACHE;
const CITAS_COL = COLLECTIONS.CITAS_F2;

const WATCHDOG_TIMEOUT_MS = SDK_CONFIG.TIMEOUTS.WATCHDOG_MS;
const SERVICE_CACHE_TTL_MS = SDK_CONFIG.CACHE.SERVICES_TTL_MS;
const SLOTS_CACHE_TTL_MS = SDK_CONFIG.CACHE.SLOTS_CACHE_TTL_MS;
const DUAL_CACHE_TTL_MS = SDK_CONFIG.CACHE.DUAL_CACHE_TTL_MS;
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;
const DIAS_LIMITE = SLOT_SEARCH.DIAS_LIMITE;
const CACHE_MAX_SIZE = SDK_CONFIG.CACHE.MAX_ENTRIES;
const DAYS_CACHE_VERSION = SDK_CONFIG.CACHE.DAYS_CACHE_VERSION;

// =============================================================================
// BLOQUE 2 - RESOLUCION DE LOCATION
// =============================================================================
function _resolveTimeSlotsLocationOrThrow() {
  const id = _safeTrim(SDK_CONFIG?.LOCATION_ID);
  const locationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.TIME_SLOTS);
  const allowed = new Set(["BUSINESS", "OWNER_BUSINESS"]);
  if (!id || !_looksLikeGuid(id)) throw new Error("INVALID_LOCATION_ID");
  if (!locationType || !allowed.has(locationType)) throw new Error("INVALID_LOCATION_TYPE");
  return Object.freeze({ id, locationType });
}

const LOCATION_TS = _resolveTimeSlotsLocationOrThrow();
const ACTIVE_NATIVE_ADDON_IDS = new Set(BOOKINGS_ADDON_CONFIG.ACTIVE_NATIVE_IDS);

// =============================================================================
// BLOQUE 3 - CACHE RAM MULTICAPA
// =============================================================================
const availabilityCache = new Map();
const inflightRequests = new Map();
const serviceCatalogRAM = new Map();
const staffDisplayCache = new Map();
const STAFF_CACHE_TTL_MS = SDK_CONFIG.CACHE.STAFF_TTL_MS;
const STAFF_DISPLAY_CACHE_MAX_ENTRIES = SDK_CONFIG.CACHE.MAX_ENTRIES;

function _cacheSetBounded(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size <= maxSize) return;
  const firstKey = map.keys().next().value;
  if (firstKey) map.delete(firstKey);
}

async function _getStaffDisplayName(resourceId) {
  const resourceIdClean = _safeTrim(resourceId);
  if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return "";
  const cached = staffDisplayCache.get(resourceIdClean);
  if (cached && Date.now() - cached.ts < STAFF_CACHE_TTL_MS) return cached.name || "";
  const staff = await findStaff(resourceIdClean).catch(() => null);
  const name = _safeTrim(staff?.displayName || staff?.name || "");
  _cacheSetBounded(staffDisplayCache, resourceIdClean, { name, ts: Date.now() }, STAFF_DISPLAY_CACHE_MAX_ENTRIES);
  return name;
}

// =============================================================================
// BLOQUE 4 - HELPERS
// =============================================================================
function _toPublicError(err, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "Internal Error") {
  return { code: String(err?.code || fallbackCode), message: String(err?.message || fallbackMessage) };
}

function _rateLimitOrThrow(surface, key, traceId) {
  const rl = rateLimiter({ surface, key });
  if (!rl.allowed) {
    const e = new Error("RATE_LIMITED");
    e.code = "RATE_LIMITED";
    e.meta = { retryAfter: rl.retryAfter, surface, traceId };
    throw e;
  }
}

function _normalizeSlotShape(slot) {
  if (!slot || typeof slot !== "object") return null;
  if (slot.slot && typeof slot.slot === "object") return { ...slot.slot, ...slot };
  return slot;
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
  const s = _normalizeSlotShape(slot);
  if (!s) return null;
  const forced = _safeTrim(forcedServiceId);
  if (!forced || !_looksLikeGuid(forced)) {
    log.error("_attachServiceId: invalid forcedServiceId", { traceId, ctx, forced });
    return null;
  }
  const { serviceId: ignoredServiceId, ...slotWithoutServiceId } = s;
  const out = { ...slotWithoutServiceId, serviceId: forced };
  if (out.slot && typeof out.slot === "object") {
    const { serviceId: ignoredNestedServiceId, ...nestedWithoutServiceId } = out.slot;
    out.slot = { ...nestedWithoutServiceId, serviceId: forced };
  }
  return out;
}

function _isValidMadridYmd(value) {
  const ymd = _safeTrim(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function _addDaysYMD(ymd, days) {
  if (!_isValidMadridYmd(ymd)) return "";
  const parts = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
}

function _filterDaysByLimit(daysArray) {
  if (!Array.isArray(daysArray) || daysArray.length === 0) return [];
  const tz = SDK_CONFIG.TZ;
  const now = new Date();
  const todayStr = now.toLocaleDateString("sv-SE", { timeZone: tz });
  const tomorrowStr = _addDaysYMD(todayStr, 1);
  const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
  if (!tomorrowStr || !maxDateStr) return [];
  return daysArray.filter((date) => date >= tomorrowStr && date <= maxDateStr);
}

function _normalizeResourceIds(resourceId, traceId) {
  if (!resourceId) return [];
  const normalized = _safeTrim(resourceId);
  if (!normalized || ["all", "any"].includes(normalized.toLowerCase())) return [];
  if (_looksLikeGuid(normalized)) return [normalized];
  log.warn("_normalizeResourceIds: non-guid identifier not supported; treating as ANY", { resourceId: normalized, traceId });
  return [];
}

function _getResourceIdsFromSlot(slot) {
  const s = _normalizeSlotShape(slot);
  if (!s || typeof s !== "object") return [];
  let groups = [];
  if (Array.isArray(s.availableResources)) groups = s.availableResources;
  else if (s.slot && typeof s.slot === "object" && Array.isArray(s.slot.availableResources)) groups = s.slot.availableResources;
  else if (s.resourceId) return _looksLikeGuid(String(s.resourceId)) ? [String(s.resourceId)] : [];
  else if (s.resource?.id) return _looksLikeGuid(String(s.resource.id)) ? [String(s.resource.id)] : [];
  const staffGroup = groups.find((g) => String(g.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID));
  if (!staffGroup) return [];
  return Array.from(new Set(
    (staffGroup.resources || [])
      .map((resource) => _safeTrim(resource?.id || resource?._id))
      .filter((resourceId) => _looksLikeGuid(resourceId))
  ));
}

function _minutesBetweenUtcDates(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return 0;
  const ms = b.getTime() - a.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60000);
}

// =============================================================================
// BLOQUE 5 - MAPEO DE SERVICIO (ServiciosCatalogo -> UX)
// =============================================================================
async function _mapServiceToPresentation(service, traceId) {
  const serviceId = _safeTrim(service.serviceId || service._id);
  if (!_looksLikeGuid(serviceId)) {
    throw new Error("ServiciosCatalogo invalid: serviceId missing or not a GUID");
  }

  const slugUrl = _safeTrim(service.slugUrl) || null;
  const hidden = service.hidden === true || String(service.hidden).toLowerCase() === "true";
  const allowCombine = !hidden && service.allowCombine === true && !!service.linkedPhases;
  const linkedPhases = _safeTrim(service.linkedPhases) || null;

  const phase1Duration = Number(service.phase1Duration) || 0;
  const exposureDuration = Number(service.exposureDuration) || 0;
  const phase2Duration = Number(service.phase2Duration) || 0;
  const totalDuration = Number(service.totalDuration) ||
    (allowCombine && linkedPhases ? phase1Duration + exposureDuration + phase2Duration : phase1Duration) || 30;

  const title = _safeTrim(service.title || service.tituloServicio) || "Servicio";
  const price = Number(service.price || service.precioServicio) || 0;
  const currency = _safeTrim(service.currency || service.moneda) || "EUR";
  const taxRate = Number(service.taxRate || service.impuestoTasa) || 0;
  const description = _safeTrim(service.description || service.descripcionServicio) || null;
  const tagLine = _safeTrim(service.tagLine || service.etiquetaServicio) || null;
  const mainMedia = service.mainMedia || service.principalMultimedia || null;
  const serviceType = _safeTrim(service.serviceType || service.servicioTipo) || "SIMPLE";

  const availableStaff = Array.isArray(service.availableStaff) ? service.availableStaff : [];
  const staffOptions = await Promise.all(
    availableStaff.map(async (resourceId) => {
      const displayName = (await _getStaffDisplayName(resourceId).catch(() => "")) || STAFF_DEFAULT_NAME;
      return { id: resourceId, value: resourceId, name: displayName, label: displayName };
    })
  );

  const addOnOptions = Array.isArray(service.addOnOptions) ? service.addOnOptions : [];

  return {
    slugUrl,
    serviceId,
    linkedPhases,
    allowCombine,
    phase1Duration,
    exposureDuration,
    phase2Duration,
    totalDuration,
    availableStaff,
    staffOptions,
    metadata: {
      titulo: title,
      tituloServicio: title,
      precio: price,
      currency,
      taxRate,
      duracionTotal: totalDuration,
      localizacion: null,
      resumenCorto: tagLine,
      descripcionLarga: description,
      imageUrl: mainMedia,
      serviceType,
      addons: addOnOptions,
      pricing: { base: price, currency },
      timing: { estimatedTotal: totalDuration, totalDuration },
    },
  };
}

// =============================================================================
// BLOQUE 6 - RESOLUCION DE SERVICIO (INTERNO)
// =============================================================================
async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
  const traceId = externalTraceId || makeTraceId("service");
  const raw = _safeTrim(slugOrId);
  const isGuid = _looksLikeGuid(raw);
  const clean = isGuid ? raw : _safeSlugOrId(raw);
  if (!clean) {
    return { status: "ERROR", data: null, error: { code: "SLUG_MISSING", message: "Slug o ID de servicio requerido." } };
  }

  const cached = serviceCatalogRAM.get(clean);
  if (cached && Date.now() - cached.timestamp < SERVICE_CACHE_TTL_MS) {
    return { status: "SUCCESS", data: cached.data, error: null };
  }

  try {
    let service = null;
    if (isGuid) {
      let res = await withTimeout(
        wixData.query(SERVICIOS_COL).limit(1).eq("serviceId", clean).find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "getServiceBySlugOrId:serviceId"
      );
      service = res?.items?.[0] || null;
      if (!service) {
        res = await withTimeout(
          wixData.query(SERVICIOS_COL).limit(1).eq("_id", clean).find({ suppressAuth: true }),
          WATCHDOG_TIMEOUT_MS,
          "getServiceBySlugOrId:_id"
        );
        service = res?.items?.[0] || null;
      }
    } else {
      let res = await withTimeout(
        wixData.query(SERVICIOS_COL).limit(1).eq("slugUrl", clean).find({ suppressAuth: true }),
        WATCHDOG_TIMEOUT_MS,
        "getServiceBySlugOrId:slugUrl"
      );
      service = res?.items?.[0] || null;
    }

    if (!service) {
      log.error("Service not found in ServiciosCatalogo", { key: clean, traceId });
      return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: `Servicio "${slugOrId}" no encontrado.` } };
    }

    const mapped = await _mapServiceToPresentation(service, traceId);
    _cacheSetBounded(serviceCatalogRAM, clean, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
    if (mapped.serviceId) _cacheSetBounded(serviceCatalogRAM, mapped.serviceId, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
    if (mapped.slugUrl) _cacheSetBounded(serviceCatalogRAM, mapped.slugUrl, { data: mapped, timestamp: Date.now() }, CACHE_MAX_SIZE);
    return { status: "SUCCESS", data: mapped, error: null };
  } catch (e) {
    log.error("Error in getServiceBySlugOrId", { error: e?.message, traceId });
    return { status: "ERROR", data: null, error: { code: "DATABASE_ERROR", message: e?.message || "Error al consultar la base de datos." } };
  }
}

async function _resolveServiceIdInternal(candidate) {
  const raw = _safeTrim(candidate);
  if (!raw) return null;
  if (_looksLikeGuid(raw)) return raw;
  const normalized = _safeSlugOrId(raw);
  if (!normalized) return null;
  const res = await _getServiceBySlugOrIdInternal(normalized);
  if (res?.status === "SUCCESS" && res?.data?.serviceId) {
    const sid = _safeTrim(res.data.serviceId);
    if (sid && _looksLikeGuid(sid)) return sid;
  }
  return null;
}

// =============================================================================
// BLOQUE 7 - BOOKINGS V2: LIST TIME SLOTS
// =============================================================================
async function _listTimeSlotsV2({ serviceId, fromLocalDate, toLocalDate, resourceIds, nativeAddonIds = [] }, options = {}) {
  const { skipCache = false, timeSlotsPerDay } = options;
  const traceId = makeTraceId("slots");
  const fromKey = _normalizeLocalIsoStr(fromLocalDate);
  const toKey = _normalizeLocalIsoStr(toLocalDate);
  if (!fromKey || !toKey) return [];
  const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
  if (!resolvedServiceId) return [];
  const normalizedResourceIds = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
  const normalizedNativeAddonIds = Array.from(new Set(
    (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
      .map((id) => _safeTrim(id))
      .filter((id) => _looksLikeGuid(id) && ACTIVE_NATIVE_ADDON_IDS.has(id))
  )).sort();
  const resourceKey = normalizedResourceIds.slice().sort().join(",");
  const addonKey = normalizedNativeAddonIds.join(",");
  const cacheKey = `${String(resolvedServiceId)}__${resourceKey}__${addonKey}__${fromKey}__${toKey}__ts:${timeSlotsPerDay || 0}`;
  if (!skipCache) {
    const cached = availabilityCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SLOTS_CACHE_TTL_MS) return cached.data;
    const inflight = inflightRequests.get(cacheKey);
    if (inflight) return inflight;
  }
  const p = (async () => {
    try {
      const resourceTypes = normalizedResourceIds.length ?
        [{ resourceTypeId: STAFF_RESOURCE_TYPE_ID, resourceIds: normalizedResourceIds }] : [];
      const payload = {
        serviceId: String(resolvedServiceId),
        fromLocalDate: String(fromKey),
        toLocalDate: String(toKey),
        timeZone: SDK_CONFIG.TZ,
        bookable: true,
        locations: [LOCATION_TS],
        includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
      };
      if (resourceTypes.length) payload.resourceTypes = resourceTypes;
      if (normalizedNativeAddonIds.length > 0) payload.customerChoices = { addOnIds: normalizedNativeAddonIds };
      if (Number.isFinite(timeSlotsPerDay) && Number(timeSlotsPerDay) > 0) payload.timeSlotsPerDay = Number(timeSlotsPerDay);
      const data = await _executeWithRetry(
        () => withTimeout(
          availabilityTimeSlots.listAvailabilityTimeSlots(payload),
          WATCHDOG_TIMEOUT_MS,
          "listAvailabilityTimeSlots"
        ),
        3,
        500
      );
      const rawSlots = Array.isArray(data?.timeSlots) ? data.timeSlots : [];
      const slots = rawSlots
        .map((s) => {
          if (!s) return null;
          const start = s.localStartDate || s.startDate || "";
          const end = s.localEndDate || s.endDate || "";
          const fixed = _attachServiceId(s, resolvedServiceId, traceId, "_listTimeSlotsV2");
          if (!fixed) return null;
          return { ...fixed, localStartDate: String(start), localEndDate: String(end) };
        })
        .filter((s) => s && s.localStartDate);
      if (!skipCache) _cacheSetBounded(availabilityCache, cacheKey, { data: slots, timestamp: Date.now() }, CACHE_MAX_SIZE);
      return slots;
    } catch (e) {
      log.error("_listTimeSlotsV2 failed", { traceId, message: e?.message });
      return [];
    }
  })();
  if (!skipCache) {
    inflightRequests.set(cacheKey, p);
    try {
      return await p;
    } finally {
      inflightRequests.delete(cacheKey);
    }
  }
  return await p;
}

// =============================================================================
// BLOQUE 8 - BALANCEO POR CARGA HORARIA
// =============================================================================
async function _getBookedMinutesByResourceForDay(dateYMD, resourceIds, traceId) {
  const ymd = String(dateYMD || "").slice(0, 10);
  const ids = Array.isArray(resourceIds) ? resourceIds.map(String).filter(Boolean) : [];
  if (!ymd || ids.length === 0) return {};

  const minutes = {};
  ids.forEach((rid) => (minutes[rid] = 0));

  let allItems = [];
  let res = await withTimeout(
    wixData.query(CITAS_COL)
      .eq("dateYmd", ymd)
      .in("status", ["CONFIRMED", "PENDING_PAYMENT"])
      .in("resourceId", ids)
      .limit(1000)
      .find({ suppressAuth: true }),
    WATCHDOG_TIMEOUT_MS,
    "balance:queryCitas"
  ).catch(() => null);

  if (res?.items) allItems = allItems.concat(res.items);

  while (res?.hasNext()) {
    res = await res.next().catch(() => null);
    if (res?.items) allItems = allItems.concat(res.items);
  }

  for (const it of allItems) {
    const rid = String(it?.resourceId || "").trim();
    if (!rid || minutes[rid] === undefined) continue;
    const start = it?.startDate ? new Date(it.startDate) : null;
    const end = it?.endDate ? new Date(it.endDate) : null;
    if (!(start instanceof Date) || isNaN(start.getTime())) continue;
    if (!(end instanceof Date) || isNaN(end.getTime())) continue;
    minutes[rid] += _minutesBetweenUtcDates(start, end);
  }
  return minutes;
}

async function _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId) {
  const ids = Array.from(new Set(
    Array.isArray(candidateResourceIds) ? candidateResourceIds.map(String).filter(Boolean) : []
  ));
  if (ids.length <= 1) return ids;
  const minutesMap = await _getBookedMinutesByResourceForDay(dateYMD, ids, traceId).catch(() => ({}));
  const names = {};
  await Promise.allSettled(
    ids.map(async (rid) => {
      names[rid] = (await _getStaffDisplayName(rid).catch(() => "")) || "";
    })
  );
  return ids.sort((a, b) => {
    const ma = Number(minutesMap[a] || 0);
    const mb = Number(minutesMap[b] || 0);
    if (ma !== mb) return ma - mb;
    const na = String(names[a] || a);
    const nb = String(names[b] || b);
    return na.localeCompare(nb);
  });
}

async function _pickLeastLoadedResource(candidateResourceIds, dateYMD, traceId) {
  const ranked = await _rankResourcesByLoad(candidateResourceIds, dateYMD, traceId);
  return ranked[0] || null;
}

// =============================================================================
// BLOQUE 9 - NEXT SLOT (para F2 dual)
// =============================================================================
async function _findNextSlotForServiceInternal(serviceId, fromLocalDateTime, requiredResourceId, traceId, sameDayOnly = false) {
  const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
  if (!resolvedServiceId) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service GUID not found" } };
  const fromLocal = _normalizeLocalIsoStr(fromLocalDateTime);
  if (!fromLocal) return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "fromLocalDateTime invalid" } };
  const startYMD = fromLocal.slice(0, 10);
  const mustHaveStaff = _looksLikeGuid(requiredResourceId);
  const resourceIds = mustHaveStaff ? _normalizeResourceIds(requiredResourceId, traceId) : [];
  const maxDayOffset = sameDayOnly ? 0 : DIAS_LIMITE;
  for (let i = 0; i <= maxDayOffset; i++) {
    const ymd = _addDaysYMD(startYMD, i);
    const dayFrom = i === 0 ? fromLocal : `${ymd}T00:00:00`;
    const dayTo = `${ymd}T23:59:59`;
    const slots = await _listTimeSlotsV2({ serviceId: resolvedServiceId, fromLocalDate: dayFrom, toLocalDate: dayTo, resourceIds }, { skipCache: true });
    const normFrom = _normalizeLocalIsoStr(dayFrom);
    const candidates = (slots || [])
      .filter((s) => _normalizeLocalIsoStr(s.localStartDate) >= normFrom)
      .sort((a, b) => String(a.localStartDate).localeCompare(String(b.localStartDate)));
    if (!candidates.length) continue;
    if (mustHaveStaff) {
      const required = String(requiredResourceId);
      const match = candidates.find((s) => _getResourceIdsFromSlot(s).includes(required));
      if (match) return { status: "SUCCESS", data: { slot: match, dayYMD: ymd }, error: null };
      continue;
    }
    return { status: "SUCCESS", data: { slot: candidates[0], dayYMD: ymd }, error: null };
  }
  return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "No available slot found in search window." } };
}

// =============================================================================
// BLOQUE 10 - SLOTS DUALES CERTIFICADOS CON GAP
// =============================================================================
export async function _cleanExpiredDualSlotsInternal({ limit = 100, traceId = null } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const now = new Date();
  const result = await withTimeout(
    wixData.query(DUAL_CACHE_COL).lt("expiresAt", now).limit(safeLimit).find({ suppressAuth: true }),
    WATCHDOG_TIMEOUT_MS,
    "cleanExpiredDualSlotsQuery"
  );
  let removed = 0;
  for (const item of result?.items || []) {
    await withTimeout(
      wixData.remove(DUAL_CACHE_COL, item._id, { suppressAuth: true }),
      WATCHDOG_TIMEOUT_MS,
      "cleanExpiredDualSlotsRemove"
    );
    removed += 1;
  }
  log.info("Expired dual cache entries cleaned", { removed, traceId });
  return { status: "SUCCESS", data: { removed }, error: null };
}

export async function _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, requestedAddonIds = []) {
  const traceId = makeTraceId("dual");
  if (!serviceId || !_isValidMadridYmd(dateYMD)) {
    return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "serviceId and valid Madrid dateYMD are required" } };
  }
  const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
  if (!resolvedServiceId) {
    return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service GUID not found" } };
  }
  const serviceRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, traceId);
  if (!serviceRes || serviceRes.status !== "SUCCESS" || !serviceRes.data) {
    return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service catalog missing" } };
  }
  const service = serviceRes.data;
  const linkedPhases = service.linkedPhases || null;
  const isDual = service.allowCombine && !!linkedPhases;
  const resourceIdsFilter = _normalizeResourceIds(resourceId, traceId);
  const rankedCandidateCache = new Map();

  async function _rankCandidates(candidateResourceIds) {
    const normalized = Array.from(new Set((candidateResourceIds || []).map(String).filter(Boolean)));
    const key = normalized.slice().sort().join("|");
    if (!key) return [];
    if (rankedCandidateCache.has(key)) return rankedCandidateCache.get(key);
    const ranked = await _rankResourcesByLoad(normalized, dateYMD, traceId);
    rankedCandidateCache.set(key, ranked);
    return ranked;
  }

  const fromLocalDate = `${dateYMD}T00:00:00`;
  const toLocalDate = `${dateYMD}T23:59:59`;

  const slotsF1 = await _listTimeSlotsV2({
    serviceId: resolvedServiceId,
    fromLocalDate,
    toLocalDate,
    resourceIds: resourceIdsFilter,
    nativeAddonIds: [],
  }, { skipCache: true });

  if (!isDual) {
    const out = [];
    for (const s1 of slotsF1 || []) {
      const candidateResourceIds = _getResourceIdsFromSlot(s1);
      const rankedCandidates = await _rankCandidates(candidateResourceIds);
      const chosen = rankedCandidates[0] || null;
      const pairToken = _generateUUID();
      const forcedSlot = _attachServiceId({ ...s1 }, resolvedServiceId, traceId, "single");
      if (!forcedSlot) continue;
      out.push({
        fase1: { slotRef: forcedSlot, resourceId: chosen || null },
        fase2: null,
        uiPairToken: pairToken,
        pairToken,
        candidateResourceIds,
        serviceId: resolvedServiceId,
        linkedPhases: null,
        dateYMD,
      });
    }
    return { status: "SUCCESS", data: out, error: null };
  }

  const exposureMs = Math.max(0, Number(service.exposureDuration || 0)) * 60 * 1000;
  const pairs = [];

  for (const s1 of slotsF1 || []) {
    const s1EndLocal = _normalizeLocalIsoStr(s1.localEndDate);
    if (!s1EndLocal) continue;
    const s1EndUtc = getUtcDateFromMadridLocal(s1EndLocal);
    if (!s1EndUtc) continue;
    const earliestF2Utc = new Date(s1EndUtc.getTime() + exposureMs);
    const earliestF2Local = getMadridLocalStringNoZ(earliestF2Utc);

    const candidateResourceIds = _getResourceIdsFromSlot(s1);
    if (!candidateResourceIds.length) continue;

    const rankedCandidates = await _rankCandidates(candidateResourceIds);
    let chosenResourceId = null;
    let s2 = null;

    for (const candidateResourceId of rankedCandidates) {
      const nextF2 = await _findNextSlotForServiceInternal(
        linkedPhases,
        earliestF2Local,
        candidateResourceId,
        traceId,
        true
      );
      if (nextF2?.status !== "SUCCESS" || !nextF2?.data?.slot) continue;
      const candidateF2 = nextF2.data.slot;
      const s2Staff = _getResourceIdsFromSlot(candidateF2);
      if (s2Staff.length > 0 && !s2Staff.includes(String(candidateResourceId))) continue;
      chosenResourceId = candidateResourceId;
      s2 = candidateF2;
      break;
    }

    if (!chosenResourceId || !s2) continue;

    const pairToken = _generateUUID();
    const pair = {
      fase1: { slotRef: _attachServiceId({ ...s1 }, resolvedServiceId, traceId, "dual_f1"), resourceId: chosenResourceId },
      fase2: { slotRef: _attachServiceId({ ...s2 }, linkedPhases, traceId, "dual_f2"), resourceId: chosenResourceId },
      uiPairToken: pairToken,
      pairToken,
      candidateResourceIds,
      serviceId: resolvedServiceId,
      linkedPhases,
      dateYMD,
    };
    pairs.push(pair);

    try {
      await wixData.insert(DUAL_CACHE_COL, {
        _id: pairToken,
        pairToken,
        serviceId: resolvedServiceId,
        phase1ServiceId: resolvedServiceId,
        phase2ServiceId: linkedPhases,
        slotF1: pair.fase1.slotRef,
        slotF2: pair.fase2.slotRef,
        resourceId: chosenResourceId,
        candidateResourceIds,
        dateYMD,
        expiresAt: new Date(Date.now() + DUAL_CACHE_TTL_MS),
        status: "ACTIVE",
      }, { suppressAuth: true });
    } catch (e) {
      log.warn("DualSlotCache insert failed (non-blocking)", { pairToken, traceId, error: e?.message });
    }
  }

  return { status: "SUCCESS", data: pairs, error: null };
}

// =============================================================================
// BLOQUE 11 - REVALIDACION DE SLOT EXACTO
// =============================================================================
export async function revalidateExactAvailabilitySlot({ serviceId, localStartDate, localEndDate, resourceId, nativeAddonIds = [], traceId }) {
  const activeTraceId = traceId || makeTraceId("exact-slot");
  const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
  const start = _normalizeLocalIsoStr(localStartDate);
  const end = _normalizeLocalIsoStr(localEndDate);
  const requiredResourceId = _safeTrim(resourceId);
  if (!resolvedServiceId || !start || !end) {
    return { status: "ERROR", data: null, error: { code: "INVALID_SLOT_RECHECK", message: "Selected slot data is invalid." } };
  }
  try {
    const normalizedNativeAddonIds = Array.from(new Set(
      (Array.isArray(nativeAddonIds) ? nativeAddonIds : [])
        .map((id) => _safeTrim(id))
        .filter((id) => _looksLikeGuid(id) && ACTIVE_NATIVE_ADDON_IDS.has(id))
    )).sort();
    let rawSlot = null;

    if (normalizedNativeAddonIds.length > 0) {
      const listPayload = {
        serviceId: String(resolvedServiceId),
        fromLocalDate: start,
        toLocalDate: end,
        timeZone: SDK_CONFIG.TZ,
        bookable: true,
        locations: [LOCATION_TS],
        includeResourceTypeIds: [STAFF_RESOURCE_TYPE_ID],
        customerChoices: { addOnIds: normalizedNativeAddonIds },
      };
      if (requiredResourceId) {
        listPayload.resourceTypes = [{
          resourceTypeId: STAFF_RESOURCE_TYPE_ID,
          resourceIds: [requiredResourceId],
        }];
      }
      const listed = await _executeWithRetry(
        () => withTimeout(
          availabilityTimeSlots.listAvailabilityTimeSlots(listPayload),
          WATCHDOG_TIMEOUT_MS,
          "listAvailabilityTimeSlots:addonRecheck"
        ),
        2,
        300
      );
      rawSlot = (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find((slot) =>
        _normalizeLocalIsoStr(slot?.localStartDate || slot?.startDate) === start &&
        _normalizeLocalIsoStr(slot?.localEndDate || slot?.endDate) === end &&
        slot?.bookable === true
      ) || null;
    } else {
      const getPayload = {
        serviceId: String(resolvedServiceId),
        localStartDate: start,
        localEndDate: end,
        location: LOCATION_TS,
        timeZone: SDK_CONFIG.TZ,
      };
      const result = await _executeWithRetry(
        () => withTimeout(
          availabilityTimeSlots.getAvailabilityTimeSlot(getPayload),
          WATCHDOG_TIMEOUT_MS,
          "getAvailabilityTimeSlot"
        ),
        2,
        300
      );
      rawSlot = result?.timeSlot || null;
    }

    const normalized = _attachServiceId(rawSlot, resolvedServiceId, activeTraceId, "revalidateExactAvailabilitySlot");
    const availableResourceIds = _getResourceIdsFromSlot(normalized);

    if (!normalized || normalized.bookable !== true) {
      return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "Selected slot is no longer available." } };
    }
    if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
      return { status: "ERROR", data: null, error: { code: "STAFF_UNAVAILABLE", message: "Selected staff is no longer available for this slot." } };
    }

    return {
      status: "SUCCESS",
      data: {
        slot: { ...normalized, localStartDate: start, localEndDate: end },
        resourceId: requiredResourceId || (availableResourceIds.length === 1 ? availableResourceIds[0] : null),
        candidateResourceIds: availableResourceIds,
      },
      error: null,
    };
  } catch (error) {
    log.warn("Exact slot recheck failed", {
      traceId: activeTraceId,
      message: error?.message || String(error),
      serviceId: String(resolvedServiceId),
      localStartDate: start,
      localEndDate: end,
    });
    return {
      status: "ERROR",
      data: null,
      error: { code: "SLOT_UNAVAILABLE", message: "Selected slot could not be revalidated.", traceId: activeTraceId },
    };
  }
}

// =============================================================================
// BLOQUE 12 - INVALIDACION DE CACHES [FIX E-34 APLICADO]
// =============================================================================
export async function _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId) {
  const tId = traceId || makeTraceId("inv-cache");
  try {
    const prefix = String(serviceId || "");
    if (prefix) {
      for (const k of availabilityCache.keys()) {
        if (String(k).startsWith(prefix)) availabilityCache.delete(k);
      }
    }
    const yearMonth = String(dateYMD || "").slice(0, 7);
    const daysCacheId = `${DAYS_CACHE_VERSION}__${prefix}__${yearMonth}`;
    
    // Invalidacion segura: eliminacion del registro de cache de dias
    await wixData.remove(DAYS_CACHE_COL, daysCacheId, { suppressAuth: true }).catch(() => null);
    
    // Invalidacion de pares duales para ese servicio y fecha
    await wixData.query(DUAL_CACHE_COL)
      .eq("serviceId", prefix)
      .eq("dateYMD", dateYMD)
      .limit(100)
      .find({ suppressAuth: true })
      .then((res) => {
        for (const item of res?.items || []) {
          wixData.remove(DUAL_CACHE_COL, item._id, { suppressAuth: true }).catch(() => null);
        }
      })
      .catch(() => null);
  } catch (e) {
    log.warn("_invalidateCachesInternal: cleanup failed (best-effort)", { traceId: tId, message: e?.message });
  }
  return { ok: true, traceId: tId };
}

// =============================================================================
// BLOQUE 13 - RESOLUCION DE STAFF PARA SLOT (IMPLEMENTACION COMPLETA)
// =============================================================================
export async function _resolveStaffForSlotInternal({
  serviceId,
  f1Start,
  f1End,
  f2Start = null,
  f2End = null,
  requestedResourceId = null,
  traceId = null,
}) {
  const activeTraceId = traceId || makeTraceId("resolve-staff");
  const resolvedServiceId = await _resolveServiceIdInternal(serviceId);

  if (!resolvedServiceId) {
    return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service not found", traceId: activeTraceId } };
  }

  const normF1Start = _normalizeLocalIsoStr(f1Start);
  const normF1End = _normalizeLocalIsoStr(f1End);

  if (!normF1Start || !normF1End) {
    return { status: "ERROR", data: null, error: { code: "INVALID_DATES", message: "F1 dates invalid", traceId: activeTraceId } };
  }

  const slotsF1 = await _listTimeSlotsV2(
    {
      serviceId: resolvedServiceId,
      fromLocalDate: `${normF1Start.slice(0, 10)}T00:00:00`,
      toLocalDate: `${normF1Start.slice(0, 10)}T23:59:59`,
      resourceIds: requestedResourceId ? [requestedResourceId] : [],
      nativeAddonIds: [],
    },
    { skipCache: true }
  );

  const slotF1 = (slotsF1 || []).find(
    (s) =>
      _normalizeLocalIsoStr(s.localStartDate) === normF1Start &&
      _normalizeLocalIsoStr(s.localEndDate) === normF1End &&
      s.bookable === true
  );

  if (!slotF1) {
    return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "F1 slot no longer available", traceId: activeTraceId } };
  }

  const candidateResourceIds = _getResourceIdsFromSlot(slotF1);
  if (candidateResourceIds.length === 0) {
    return { status: "ERROR", data: null, error: { code: "STAFF_UNAVAILABLE", message: "No staff available for F1 slot", traceId: activeTraceId } };
  }

  if (requestedResourceId) {
    if (!candidateResourceIds.includes(requestedResourceId)) {
      return {
        status: "ERROR",
        data: null,
        error: { code: "STAFF_UNAVAILABLE", message: "Requested staff not available for this slot", traceId: activeTraceId },
      };
    }
  }

  const serviceRes = await _getServiceBySlugOrIdInternal(resolvedServiceId, activeTraceId);
  const serviceConfig = serviceRes?.data || {};
  const isDual = serviceConfig.allowCombine === true && !!serviceConfig.linkedPhases;

  let slotF2 = null;
  let finalResourceId = requestedResourceId;

  if (isDual) {
    let normF2Start = _normalizeLocalIsoStr(f2Start);
    let normF2End = _normalizeLocalIsoStr(f2End);

    if (!normF2Start || !normF2End) {
      const f1EndUtc = getUtcDateFromMadridLocal(normF1End);
      const exposureMs = Math.max(0, Number(serviceConfig.exposureDuration || 0)) * 60 * 1000;
      const f2StartUtc = new Date(f1EndUtc.getTime() + exposureMs);
      const phase2Ms = Math.max(0, Number(serviceConfig.phase2Duration || 30)) * 60 * 1000;
      const f2EndUtc = new Date(f2StartUtc.getTime() + phase2Ms);
      normF2Start = normF2Start || getMadridLocalStringNoZ(f2StartUtc);
      normF2End = normF2End || getMadridLocalStringNoZ(f2EndUtc);
    }

    const slotsF2 = await _listTimeSlotsV2(
      {
        serviceId: serviceConfig.linkedPhases,
        fromLocalDate: `${normF2Start.slice(0, 10)}T00:00:00`,
        toLocalDate: `${normF2Start.slice(0, 10)}T23:59:59`,
        resourceIds: requestedResourceId ? [requestedResourceId] : [],
        nativeAddonIds: [],
      },
      { skipCache: true }
    );

    slotF2 = (slotsF2 || []).find(
      (s) =>
        _normalizeLocalIsoStr(s.localStartDate) === normF2Start &&
        _normalizeLocalIsoStr(s.localEndDate) === normF2End &&
        s.bookable === true
    );

    if (!slotF2) {
      return { status: "ERROR", data: null, error: { code: "SLOT_UNAVAILABLE", message: "F2 slot no longer available", traceId: activeTraceId } };
    }

    const candidateResourceIdsF2 = _getResourceIdsFromSlot(slotF2);
    const commonCandidates = candidateResourceIds.filter((id) => candidateResourceIdsF2.includes(id));

    if (commonCandidates.length === 0) {
      return {
        status: "ERROR",
        data: null,
        error: { code: "STAFF_UNAVAILABLE", message: "No common staff available for both F1 and F2", traceId: activeTraceId },
      };
    }

    if (!finalResourceId) {
      const dateYMD = normF1Start.slice(0, 10);
      finalResourceId = await _pickLeastLoadedResource(commonCandidates, dateYMD, activeTraceId);
    } else {
      if (!commonCandidates.includes(finalResourceId)) {
        return {
          status: "ERROR",
          data: null,
          error: { code: "STAFF_UNAVAILABLE", message: "Requested staff not available for both phases", traceId: activeTraceId },
        };
      }
    }
  } else {
    if (!finalResourceId) {
      const dateYMD = normF1Start.slice(0, 10);
      finalResourceId = await _pickLeastLoadedResource(candidateResourceIds, dateYMD, activeTraceId);
    }
  }

  if (!finalResourceId) {
    return { status: "ERROR", data: null, error: { code: "STAFF_UNAVAILABLE", message: "Could not assign staff", traceId: activeTraceId } };
  }

  return {
    status: "SUCCESS",
    data: {
      resourceId: finalResourceId,
      slotF1: _attachServiceId(slotF1, resolvedServiceId, activeTraceId, "resolveStaff:F1"),
      slotF2: slotF2 ? _attachServiceId(slotF2, serviceConfig.linkedPhases, activeTraceId, "resolveStaff:F2") : null,
      isDual,
      serviceId: resolvedServiceId,
      linkedPhases: isDual ? serviceConfig.linkedPhases : null,
      dateYMD: normF1Start.slice(0, 10),
    },
    error: null,
  };
}

// =============================================================================
// BLOQUE 14 - WEB METHODS PUBLICOS
// =============================================================================
export const getServiceBySlugOrId = webMethod(Permissions.Anyone, async (slugOrId) => {
  const traceId = makeTraceId("wm-svc");
  try {
    _rateLimitOrThrow("reservas.getServiceBySlugOrId", _safeTrim(slugOrId) || "anon", traceId);
    return await _getServiceBySlugOrIdInternal(slugOrId, traceId);
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "SERVICE_LOOKUP_FAILED") };
  }
});

export const getAvailableDays = webMethod(Permissions.Anyone, async (serviceId, resourceId, year, month, addonIds = []) => {
  const traceId = makeTraceId("wm-days");
  try {
    _rateLimitOrThrow("reservas.getAvailableDays", `${_safeTrim(serviceId)}|${String(year)}|${String(month)}`, traceId);
    const resolved = await _resolveServiceIdInternal(serviceId);
    if (!resolved) return { status: "ERROR", data: null, error: { code: "SERVICE_NOT_FOUND", message: "Service GUID not found" } };
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PARAMS", message: "Invalid year/month" } };
    }
    const yearMonth = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const tz = SDK_CONFIG.TZ;
    const now = new Date();
    const todayStr = now.toLocaleDateString("sv-SE", { timeZone: tz });
    const tomorrowStr = _addDaysYMD(todayStr, 1);
    const maxDateStr = _addDaysYMD(todayStr, DIAS_LIMITE);
    const firstDay = `${yearMonth}-01`;
    const lastDayNum = new Date(y, m, 0).getDate();
    const lastDay = `${yearMonth}-${String(lastDayNum).padStart(2, "0")}`;
    const fromLocal = tomorrowStr > firstDay ? tomorrowStr : firstDay;
    const toLocal = maxDateStr < lastDay ? maxDateStr : lastDay;
    if (fromLocal > toLocal) return { status: "SUCCESS", data: [], error: null };
    const slots = await _listTimeSlotsV2({
      serviceId: resolved,
      fromLocalDate: `${fromLocal}T00:00:00`,
      toLocalDate: `${toLocal}T23:59:59`,
      resourceIds: _normalizeResourceIds(resourceId, traceId),
      nativeAddonIds: [],
    }, { skipCache: true, timeSlotsPerDay: 1 });
    const dateSet = new Set();
    slots.forEach((s) => {
      if (s.localStartDate) dateSet.add(String(s.localStartDate).slice(0, 10));
    });
    return { status: "SUCCESS", data: _filterDaysByLimit(Array.from(dateSet).sort()), error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DAYS_QUERY_FAILED") };
  }
});

export const getCertifiedDualSlots = webMethod(Permissions.Anyone, async (serviceId, resourceId, dateYMD, addonIds = []) => {
  const traceId = makeTraceId("wm-dual");
  try {
    _rateLimitOrThrow("reservas.getCertifiedDualSlots", `${_safeTrim(serviceId)}|${_safeTrim(dateYMD)}`, traceId);
    return await _getCertifiedDualSlotsInternal(serviceId, resourceId, dateYMD, addonIds);
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "DUAL_SLOTS_FAILED") };
  }
});

export const invalidateCachesInternal = webMethod(Permissions.Admin, async (serviceId, dateYMD, resourceId) => {
  const traceId = makeTraceId("wm-invalidate-internal");
  try {
    _rateLimitOrThrow("reservas.invalidateCachesInternal", "admin", traceId);
    await requireAdmin(traceId);
    const res = await _invalidateCachesInternal(serviceId, dateYMD, resourceId, traceId);
    return { status: "SUCCESS", data: res, error: null };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "INVALIDATE_FAILED") };
  }
});