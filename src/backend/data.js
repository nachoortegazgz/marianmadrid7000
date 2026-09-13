import wixData from "wix-data";

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fiscalError(message) {
  throw new Error("FISCAL_VIOLATION: " + message);
}

function schemaError(message) {
  throw new Error("SCHEMA_VIOLATION: " + message);
}

export function MovimientosCaja_beforeUpdate() {
  fiscalError("Modificacion de MovimientosCaja prohibida por normativa fiscal");
}

export function MovimientosCaja_beforeRemove() {
  fiscalError("Borrado de MovimientosCaja prohibido por normativa fiscal");
}

export function HistoricoCierresZ_beforeUpdate() {
  fiscalError("Modificacion de HistoricoCierresZ prohibida por normativa fiscal");
}

export function HistoricoCierresZ_beforeRemove() {
  fiscalError("Borrado de HistoricoCierresZ prohibido por normativa fiscal");
}

export function EventosSistemaFacturacion_beforeUpdate() {
  throw new Error("SIF_VIOLATION: Modificacion de EventosSistemaFacturacion prohibida por normativa SIF");
}

export function EventosSistemaFacturacion_beforeRemove() {
  throw new Error("SIF_VIOLATION: Borrado de EventosSistemaFacturacion prohibida por normativa SIF");
}

export function RegistrosHorariosStaff_beforeUpdate() {
  throw new Error("LABOR_LOG_VIOLATION: Modificacion de RegistrosHorariosStaff prohibida por Art. 34.9 ET");
}

export function RegistrosHorariosStaff_beforeRemove() {
  throw new Error("LABOR_LOG_VIOLATION: Borrado de RegistrosHorariosStaff prohibida por Art. 34.9 ET");
}

export function CajaActual_beforeRemove() {
  throw new Error("SINGLETON_PROTECTED: No se puede eliminar el estado de caja");
}

export function ServiciosCatalogo_beforeInsert(item) {
  validarServiciosCatalogo(item);
  return item;
}

export function ServiciosCatalogo_beforeUpdate(item) {
  validarServiciosCatalogo(item);
  return item;
}

function validarServiciosCatalogo(item) {
  item = item || {};

  if (item.allowCombine === true && !item.linkedPhases) {
    schemaError("Servicio dual requiere linkedPhases (F2)");
  }

  if (item.serviceId && !GUID_REGEX.test(String(item.serviceId))) {
    schemaError("serviceId debe ser un GUID valido");
  }

  var phase1 = Number(item.phase1Duration);
  var exposure = Number(item.exposureDuration);
  var phase2 = Number(item.phase2Duration);
  var total = Number(item.totalDuration);

  phase1 = isNaN(phase1) ? 0 : phase1;
  exposure = isNaN(exposure) ? 0 : exposure;
  phase2 = isNaN(phase2) ? 0 : phase2;
  total = isNaN(total) ? 0 : total;

  if (phase1 < 0 || exposure < 0 || phase2 < 0 || total < 0) {
    schemaError("Las duraciones no pueden ser negativas");
  }

  if (item.allowCombine === true && total > 0) {
    var expected = phase1 + exposure + phase2;
    if (expected > 0 && Math.abs(total - expected) > 1) {
      schemaError("totalDuration (" + total + ") no coincide con suma de fases (" + expected + ")");
    }
  }
}

export function MapaStaff_beforeInsert(item) {
  return validarMapaStaff(item);
}

export function MapaStaff_beforeUpdate(item) {
  return validarMapaStaff(item);
}

async function validarMapaStaff(item) {
  item = item || {};
  var itemId = item._id ? String(item._id) : "";

  if (item.resourceId) {
    var resourceQuery = await wixData.query("MapaStaff")
      .eq("resourceId", String(item.resourceId))
      .limit(100)
      .find({ suppressAuth: true });

    var resourceItems = resourceQuery.items || [];
    for (var i = 0; i < resourceItems.length; i++) {
      if (String(resourceItems[i]._id) !== itemId) {
        schemaError("resourceId duplicado en MapaStaff");
      }
    }
  }

  if (item.staffMemberId) {
    var memberQuery = await wixData.query("MapaStaff")
      .eq("staffMemberId", String(item.staffMemberId))
      .limit(100)
      .find({ suppressAuth: true });

    var memberItems = memberQuery.items || [];
    for (var j = 0; j < memberItems.length; j++) {
      if (String(memberItems[j]._id) !== itemId) {
        schemaError("staffMemberId duplicado en MapaStaff");
      }
    }
  }

  return item;
}

export function AsientosContables_beforeUpdate(item) {
  item = item || {};
  if (item.entryStatus === "POSTED" || item.entryStatus === "LOCKED") {
    fiscalError("No se puede modificar un asiento POSTED o LOCKED");
  }
  return item;
}

export function AsientosContables_beforeRemove(item) {
  item = item || {};
  if (item.entryStatus === "POSTED" || item.entryStatus === "LOCKED") {
    fiscalError("No se puede eliminar un asiento POSTED o LOCKED");
  }
  return item;
}

export async function LineasAsientoContable_beforeUpdate(item) {
  item = item || {};

  if (item.journalEntryId) {
    var parentEntry = null;
    try {
      parentEntry = await wixData.get("AsientosContables", item.journalEntryId, { suppressAuth: true });
    } catch (error) {
      parentEntry = null;
    }

    if (parentEntry && (parentEntry.entryStatus === "POSTED" || parentEntry.entryStatus === "LOCKED")) {
      fiscalError("No se puede modificar linea de asiento POSTED o LOCKED");
    }
  }

  return item;
}

export async function LineasAsientoContable_beforeRemove(item) {
  return LineasAsientoContable_beforeUpdate(item);
}

export async function SecuenciaTickets_beforeUpdate(item) {
  item = item || {};
  if (!item._id) return item;

  var existing = null;
  try {
    existing = await wixData.get("SecuenciaTickets", item._id, { suppressAuth: true });
  } catch (error) {
    existing = null;
  }

  if (existing && existing.sequenceCounters) {
    var oldGlobal = Number(existing.sequenceCounters.seqGlobal);
    var newGlobal = Number(item.sequenceCounters && item.sequenceCounters.seqGlobal);

    oldGlobal = isNaN(oldGlobal) ? 0 : oldGlobal;
    newGlobal = isNaN(newGlobal) ? 0 : newGlobal;

    if (newGlobal < oldGlobal) {
      throw new Error("SEQUENCE_VIOLATION: No se permite salto regresivo en secuencia de tickets");
    }
  }

  return item;
}

export function InventarioStockVentaCierre_beforeUpdate(item) {
  item = item || {};
  if (item.closingHash) {
    fiscalError("No se puede modificar un cierre de inventario firmado");
  }
  return item;
}

export function InventarioStockVentaCierre_beforeRemove(item) {
  item = item || {};
  if (item.closingHash) {
    fiscalError("No se puede eliminar un cierre de inventario firmado");
  }
}
