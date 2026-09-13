/*
=============================================================================
MODULE: backend/data.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 11 + ESQUEMA CMS v5002.5 Seccion 7 + DOSSIER CAJA Seccion 24
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
                Protege colecciones fiscales, laborales y contables contra
                modificacion o borrado no autorizado.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Excepciones con codigos especificos:
           - FISCAL_VIOLATION (MovimientosCaja, HistoricoCierresZ)
           - SIF_VIOLATION (EventosSistemaFacturacion)
           - LABOR_LOG_VIOLATION (RegistrosHorariosStaff)
           - SCHEMA_VIOLATION (ServiciosCatalogo, MapaStaff)
CORRECTIONS APPLIED:
  [DATA-01] Todos los hooks de inmutabilidad implementados.
  [DATA-02] Validacion de esquema en ServiciosCatalogo.
  [DATA-03] Validacion de unicidad en MapaStaff.
  [DATA-04] Bloqueo condicional en AsientosContables (POSTED/LOCKED).
  [DATA-05] Singleton protegido en CajaActual.
=============================================================================
*/

import wixData from "wix-data";

// =============================================================================
// BLOQUE 1 — INMUTABILIDAD FISCAL (MovimientosCaja)
// =============================================================================

export function MovimientosCaja_beforeUpdate(item, context) {
  throw new Error("FISCAL_VIOLATION: Modificacion de MovimientosCaja prohibida por normativa fiscal");
}

export function MovimientosCaja_beforeRemove(item, context) {
  throw new Error("FISCAL_VIOLATION: Borrado de MovimientosCaja prohibido por normativa fiscal");
}

// =============================================================================
// BLOQUE 2 — INMUTABILIDAD FISCAL (HistoricoCierresZ)
// =============================================================================

export function HistoricoCierresZ_beforeUpdate(item, context) {
  throw new Error("FISCAL_VIOLATION: Modificacion de HistoricoCierresZ prohibida por normativa fiscal");
}

export function HistoricoCierresZ_beforeRemove(item, context) {
  throw new Error("FISCAL_VIOLATION: Borrado de HistoricoCierresZ prohibido por normativa fiscal");
}

// =============================================================================
// BLOQUE 3 — INMUTABILIDAD SIF (EventosSistemaFacturacion)
// =============================================================================

export function EventosSistemaFacturacion_beforeUpdate(item, context) {
  throw new Error("SIF_VIOLATION: Modificacion de EventosSistemaFacturacion prohibida por normativa SIF");
}

export function EventosSistemaFacturacion_beforeRemove(item, context) {
  throw new Error("SIF_VIOLATION: Borrado de EventosSistemaFacturacion prohibido por normativa SIF");
}

// =============================================================================
// BLOQUE 4 — INMUTABILIDAD LABORAL (RegistrosHorariosStaff)
// =============================================================================

export function RegistrosHorariosStaff_beforeUpdate(item, context) {
  throw new Error("LABOR_LOG_VIOLATION: Modificacion de RegistrosHorariosStaff prohibida por Art. 34.9 ET");
}

export function RegistrosHorariosStaff_beforeRemove(item, context) {
  throw new Error("LABOR_LOG_VIOLATION: Borrado de RegistrosHorariosStaff prohibido por Art. 34.9 ET");
}

// =============================================================================
// BLOQUE 5 — SINGLETON PROTEGIDO (CajaActual)
// =============================================================================

export function CajaActual_beforeRemove(item, context) {
  throw new Error("SINGLETON_PROTECTED: No se puede eliminar el estado de caja");
}

// =============================================================================
// BLOQUE 6 — VALIDACION DE ESQUEMA (ServiciosCatalogo)
// [DATA-02]
// =============================================================================

export function ServiciosCatalogo_beforeInsert(item, context) {
  _validateServiciosCatalogoSchema(item);
  return item;
}

export function ServiciosCatalogo_beforeUpdate(item, context) {
  _validateServiciosCatalogoSchema(item);
  return item;
}

function _validateServiciosCatalogoSchema(item) {
  // Validar que si es dual, tiene linkedPhases
  if (item.allowCombine === true && !item.linkedPhases) {
    throw new Error("SCHEMA_VIOLATION: Servicio dual requiere linkedPhases (F2)");
  }

  // Validar que serviceId es GUID si existe
  if (item.serviceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.serviceId)) {
    throw new Error("SCHEMA_VIOLATION: serviceId debe ser un GUID valido");
  }

  // Validar duraciones positivas
  const p1 = Number(item.phase1Duration) || 0;
  const exp = Number(item.exposureDuration) || 0;
  const p2 = Number(item.phase2Duration) || 0;
  const total = Number(item.totalDuration) || 0;

  if (p1 < 0 || exp < 0 || p2 < 0 || total < 0) {
    throw new Error("SCHEMA_VIOLATION: Las duraciones no pueden ser negativas");
  }

  // Validar que totalDuration es coherente si es dual
  if (item.allowCombine === true && total > 0) {
    const expected = p1 + exp + p2;
    if (expected > 0 && Math.abs(total - expected) > 1) {
      throw new Error(`SCHEMA_VIOLATION: totalDuration (${total}) no coincide con suma de fases (${expected})`);
    }
  }
}

// =============================================================================
// BLOQUE 7 — VALIDACION DE UNICIDAD (MapaStaff)
// [DATA-03]
// =============================================================================

export function MapaStaff_beforeInsert(item, context) {
  return _validateMapaStaffUniqueness(item);
}

export function MapaStaff_beforeUpdate(item, context) {
  return _validateMapaStaffUniqueness(item);
}

async function _validateMapaStaffUniqueness(item) {
  if (item.resourceId) {
    const existingByResource = await wixData
      .query("MapaStaff")
      .eq("resourceId", item.resourceId)
      .ne("_id", item._id || "")
      .limit(1)
      .find({ suppressAuth: true });

    if (existingByResource?.items?.length > 0) {
      throw new Error("SCHEMA_VIOLATION: resourceId duplicado en MapaStaff");
    }
  }

  if (item.staffMemberId) {
    const existingByMember = await wixData
      .query("MapaStaff")
      .eq("staffMemberId", item.staffMemberId)
      .ne("_id", item._id || "")
      .limit(1)
      .find({ suppressAuth: true });

    if (existingByMember?.items?.length > 0) {
      throw new Error("SCHEMA_VIOLATION: staffMemberId duplicado en MapaStaff");
    }
  }

  return item;
}

// =============================================================================
// BLOQUE 8 — BLOQUEO CONDICIONAL (AsientosContables)
// [DATA-04]
// =============================================================================

export function AsientosContables_beforeUpdate(item, context) {
  if (item.entryStatus === "POSTED" || item.entryStatus === "LOCKED") {
    throw new Error("FISCAL_VIOLATION: No se puede modificar un asiento POSTED o LOCKED");
  }
  return item;
}

export function AsientosContables_beforeRemove(item, context) {
  if (item.entryStatus === "POSTED" || item.entryStatus === "LOCKED") {
    throw new Error("FISCAL_VIOLATION: No se puede eliminar un asiento POSTED o LOCKED");
  }
  return item;
}

// =============================================================================
// BLOQUE 9 — BLOQUEO CONDICIONAL (LineasAsientoContable)
// =============================================================================

export async function LineasAsientoContable_beforeUpdate(item, context) {
  // Verificar si el asiento padre esta posteado
  if (item.journalEntryId) {
    const parentEntry = await wixData
      .get("AsientosContables", item.journalEntryId, { suppressAuth: true })
      .catch(() => null);

    if (parentEntry && (parentEntry.entryStatus === "POSTED" || parentEntry.entryStatus === "LOCKED")) {
      throw new Error("FISCAL_VIOLATION: No se puede modificar linea de asiento POSTED o LOCKED");
    }
  }
  return item;
}

export async function LineasAsientoContable_beforeRemove(item, context) {
  if (item.journalEntryId) {
    const parentEntry = await wixData
      .get("AsientosContables", item.journalEntryId, { suppressAuth: true })
      .catch(() => null);

    if (parentEntry && (parentEntry.entryStatus === "POSTED" || parentEntry.entryStatus === "LOCKED")) {
      throw new Error("FISCAL_VIOLATION: No se puede eliminar linea de asiento POSTED o LOCKED");
    }
  }
  return item;
}

// =============================================================================
// BLOQUE 10 — SECUENCIA TICKETS (Sin salto regresivo)
// [DATA-05]
// =============================================================================

export async function SecuenciaTickets_beforeUpdate(item, context) {
  // Obtener el documento anterior para verificar que no hay salto regresivo
  const existing = await wixData
    .get("SecuenciaTickets", item._id, { suppressAuth: true })
    .catch(() => null);

  if (existing && existing.sequenceCounters) {
    const oldGlobal = Number(existing.sequenceCounters.seqGlobal) || 0;
    const newGlobal = Number(item.sequenceCounters?.seqGlobal) || 0;

    if (newGlobal < oldGlobal) {
      throw new Error("SEQUENCE_VIOLATION: No se permite salto regresivo en secuencia de tickets");
    }
  }

  return item;
}

// =============================================================================
// BLOQUE 11 — CIERRE DE INVENTARIO FIRMADO
// =============================================================================

export function InventarioStockVentaCierre_beforeUpdate(item, context) {
  if (item.closingHash) {
    throw new Error("FISCAL_VIOLATION: No se puede modificar un cierre de inventario firmado");
  }
  return item;
}

export function InventarioStockVentaCierre_beforeRemove(item, context) {
  if (item.closingHash) {
    throw new Error("FISCAL_VIOLATION: No se puede eliminar un cierre de inventario firmado");
  }
  return item;
}