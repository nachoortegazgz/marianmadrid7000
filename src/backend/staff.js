/*
=============================================================================
MODULE: backend/staff.js
VERSION: v5007.3-FINAL
BASE: BIBLIA v5002.5 Bloque 12.11 + ESQUEMA CMS v5002.5 Seccion 4.03
RESPONSIBILITY: Catalogo de personal con busqueda O(1) por cualquier
                identificador (clave, email, nombre, resourceId, scheduleId).
                Cache en memoria con TTL configurable.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [STF-01] Cache con TTL de SDK_CONFIG.CACHE.STAFF_TTL_MS (300s).
  [STF-02] Busqueda O(1) mediante indices Map por resourceId, email, scheduleId.
  [STF-03] clearStaffCache() para invalidacion manual tras cambios en MapaStaff.
  [STF-04] getStaffDisplayName() con fallback a STAFF_DEFAULT_NAME.
  [STF-05] getStaffScheduleId() para resolucion de scheduleId en bookingCore.
=============================================================================
*/

import wixData from "wix-data";
import { COLLECTIONS, SDK_CONFIG, STAFF_DEFAULT_NAME } from "backend/internalConfig";
import { _safeTrim, _looksLikeGuid } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const STAFF_CACHE_TTL_MS = SDK_CONFIG?.CACHE?.STAFF_TTL_MS || 300000;

let staffCache = null; // { data: Map[], timestamp: number }

/**
 * Limpia la cache de staff. Llamar tras modificaciones en MapaStaff.
 */
export function clearStaffCache() {
  staffCache = null;
}

// =============================================================================
// BLOQUE 1 - CARGA DEL CATALOGO
// =============================================================================

/**
 * Carga el catalogo completo de staff desde MapaStaff.
 * Construye indices Map para busqueda O(1).
 */
async function _loadStaffCatalog() {
  const now = Date.now();
  // Verificar cache vigente
  if (staffCache && now - staffCache.timestamp < STAFF_CACHE_TTL_MS) {
    return staffCache.data;
  }
  try {
    const res = await wixData
      .query(COLLECTIONS.MAPA_STAFF)
      .eq("active", true)
      .limit(100)
      .find({ suppressAuth: true });
    const items = res?.items || [];
    // Construir indices
    const byResourceId = new Map();
    const byEmail = new Map();
    const byScheduleId = new Map();
    const byId = new Map();
    const allStaff = [];
    for (const item of items) {
      const record = {
        _id: item._id,
        displayName: _safeTrim(item.displayName),
        resourceId: _safeTrim(item.resourceId),
        email: _safeTrim(item.email).toLowerCase(),
        staffMemberId: _safeTrim(item.staffMemberId),
        scheduleId: _safeTrim(item.scheduleId),
        locationId: _safeTrim(item.locationId),
        rol: _safeTrim(item.rol),
        phone: _safeTrim(item.phone),
        active: item.active === true,
        notes: _safeTrim(item.notes),
      };
      allStaff.push(record);
      if (record.resourceId) byResourceId.set(record.resourceId, record);
      if (record.email) byEmail.set(record.email, record);
      if (record.scheduleId) byScheduleId.set(record.scheduleId, record);
      if (record._id) byId.set(record._id, record);
    }
    const catalog = {
      all: allStaff,
      byResourceId,
      byEmail,
      byScheduleId,
      byId,
    };
    staffCache = { data: catalog, timestamp: now };
    return catalog;
  } catch (err) {
    log.error("_loadStaffCatalog failed", { error: err?.message });
    // Retornar cache anterior si existe, aunque este expirada
    if (staffCache) return staffCache.data;
    return { all: [], byResourceId: new Map(), byEmail: new Map(), byScheduleId: new Map(), byId: new Map() };
  }
}

// =============================================================================
// BLOQUE 2 - FUNCIONES DE BUSQUEDA
// =============================================================================

/**
 * Devuelve todo el staff activo.
 */
export async function getAllStaff() {
  const catalog = await _loadStaffCatalog();
  return catalog.all || [];
}

/**
 * Busca un miembro de staff por cualquier identificador.
 * Acepta: resourceId (GUID), email, scheduleId, _id de CMS, nombre.
 * Busqueda O(1) para GUIDs, emails y scheduleIds.
 */
export async function findStaff(identifier) {
  const raw = _safeTrim(identifier);
  if (!raw) return null;
  const catalog = await _loadStaffCatalog();
  // 1. Buscar por resourceId (GUID)
  if (_looksLikeGuid(raw)) {
    const byResource = catalog.byResourceId.get(raw);
    if (byResource) return byResource;
    const bySchedule = catalog.byScheduleId.get(raw);
    if (bySchedule) return bySchedule;
    const byId = catalog.byId.get(raw);
    if (byId) return byId;
  }
  // 2. Buscar por email
  const emailLower = raw.toLowerCase();
  const byEmail = catalog.byEmail.get(emailLower);
  if (byEmail) return byEmail;
  // 3. Buscar por nombre (fallback lineal, solo si no se encontro por indices)
  const nameLower = raw.toLowerCase();
  for (const record of catalog.all) {
    if (record.displayName.toLowerCase() === nameLower) {
      return record;
    }
  }
  return null;
}

/**
 * Busca staff por resourceId especifico.
 */
export async function findStaffByResourceId(resourceId) {
  const raw = _safeTrim(resourceId);
  if (!raw || !_looksLikeGuid(raw)) return null;
  const catalog = await _loadStaffCatalog();
  return catalog.byResourceId.get(raw) || null;
}

/**
 * Obtiene el nombre visible de un profesional por resourceId.
 */
export async function getStaffDisplayName(resourceId) {
  const staff = await findStaffByResourceId(resourceId);
  if (staff && staff.displayName) return staff.displayName;
  return STAFF_DEFAULT_NAME;
}

/**
 * Obtiene el scheduleId de un profesional por resourceId.
 * Usado por bookingCore._forceStaffInPristineSlot como fallback.
 */
export async function getStaffScheduleId(resourceId) {
  const staff = await findStaffByResourceId(resourceId);
  if (staff && staff.scheduleId) return staff.scheduleId;
  return null;
}

/**
 * Obtiene el resourceId de un profesional por email.
 */
export async function getStaffResourceIdByEmail(email) {
  const staff = await findStaff(email);
  if (staff && staff.resourceId) return staff.resourceId;
  return null;
}

/**
 * Verifica si un resourceId pertenece a staff activo.
 */
export async function isActiveStaff(resourceId) {
  const staff = await findStaffByResourceId(resourceId);
  return staff !== null && staff.active === true;
}

/**
 * Obtiene los resourceIds de todo el staff activo.
 */
export async function getAllActiveResourceIds() {
  const catalog = await _loadStaffCatalog();
  return catalog.all
    .filter((s) => s.active === true)
    .map((s) => s.resourceId)
    .filter(Boolean);
}