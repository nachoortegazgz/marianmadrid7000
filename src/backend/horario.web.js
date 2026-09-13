/*
=============================================================================
MODULE: backend/horario.web.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 12.7 + ESQUEMA CMS 4.29 + DOSSIER CAJA Flujo 16
RESPONSIBILITY: Registro horario laboral del personal. Fichajes inmutables,
                estado de jornada, calculo de horas trabajadas y ajustes
                administrativos. Cumplimiento Art. 34.9 ET y RD-ley 8/2019.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Registros inmutables (beforeUpdate/beforeRemove bloqueados en data.js).
           Minimizacion de datos personales (RGPD).
CORRECTIONS APPLIED:
  [HOR-01] Fichajes inmutables: solo INSERT, nunca UPDATE/REMOVE.
  [HOR-02] dayKey y monthKey calculados en Europe/Madrid.
  [HOR-03] Firma HMAC del registro para integridad.
  [HOR-04] registeredBy: SELF o ADMIN.
  [HOR-05] Ajustes solo por ADMIN con motivo obligatorio.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { currentMember } from "wix-members-backend";

import {
  COLLECTIONS,
  TIPO_FICHAJE,
  SDK_CONFIG,
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _normalizeLocalIsoStr,
  _readDate,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { hashSHA256, hmacSha256Hex } from "backend/securityEngine";
import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import { requireAdmin, requireCajero, isStaffCollaborator } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { findStaff, getStaffDisplayName } from "backend/staff";

const log = logger;
const REGISTROS_COL = COLLECTIONS.REGISTROS_HORARIOS_STAFF;
const MAPA_STAFF_COL = COLLECTIONS.MAPA_STAFF;

// =============================================================================
// BLOQUE 1 — HELPERS INTERNOS
// =============================================================================

function _getMadridNow() {
  return new Date();
}

function _getMadridDayKey(date) {
  try {
    return date.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function _getMadridMonthKey(date) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SDK_CONFIG.TZ,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    return `${year}-${month}`;
  } catch (_) {
    return date.toISOString().slice(0, 7);
  }
}

function _getMadridTime(date) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SDK_CONFIG.TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const hour = parts.find((p) => p.type === "hour")?.value || "00";
    const minute = parts.find((p) => p.type === "minute")?.value || "00";
    const second = parts.find((p) => p.type === "second")?.value || "00";
    return `${hour === "24" ? "00" : hour}:${minute}:${second}`;
  } catch (_) {
    return "00:00:00";
  }
}

async function _getCurrentMemberContext(traceId) {
  try {
    const member = await currentMember.getMember();
    if (!member) return null;
    return {
      memberId: member._id,
      email: (member.loginEmail || member.contactDetails?.email || "").toLowerCase(),
    };
  } catch (_) {
    return null;
  }
}

async function _resolveStaffContext(traceId) {
  const memberCtx = await _getCurrentMemberContext(traceId);
  if (!memberCtx) return null;

  const staff = await findStaff(memberCtx.email);
  if (!staff || !staff.active) return null;

  return {
    memberId: memberCtx.memberId,
    email: memberCtx.email,
    resourceId: staff.resourceId,
    displayName: staff.displayName,
    staffMemberId: staff.staffMemberId,
  };
}

// =============================================================================
// BLOQUE 2 — GET MY STAFF CONTEXT
// =============================================================================

export const getMyStaffContext = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("staff-ctx");
  try {
    const staffCtx = await _resolveStaffContext(traceId);
    if (!staffCtx) {
      return { status: "ERROR", data: null, error: { code: "NOT_STAFF", message: "Current member is not active staff" } };
    }
    return {
      status: "SUCCESS",
      data: {
        resourceId: staffCtx.resourceId,
        displayName: staffCtx.displayName,
        staffMemberId: staffCtx.staffMemberId,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "STAFF_CTX_FAIL") };
  }
});

// =============================================================================
// BLOQUE 3 — REGISTRAR FICHAJE
// [HOR-01] Solo INSERT, nunca UPDATE
// =============================================================================

export const registrarFichaje = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("fichaje");
  try {
    const clockEventType = _safeTrim(options?.clockEventType || options?.tipo).toUpperCase();
    const validTypes = Object.values(TIPO_FICHAJE);
    if (!validTypes.includes(clockEventType)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_CLOCK_TYPE", message: `Tipo de fichaje invalido. Validos: ${validTypes.join(", ")}` } };
    }

    const staffCtx = await _resolveStaffContext(traceId);
    if (!staffCtx) {
      return { status: "ERROR", data: null, error: { code: "NOT_STAFF", message: "Current member is not active staff" } };
    }

    const now = _getMadridNow();
    const dayKey = _getMadridDayKey(now);
    const monthKey = _getMadridMonthKey(now);
    const recordedTime = _getMadridTime(now);

    // [HOR-03] Firma HMAC del registro
    let signature = "";
    try {
      const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
      const recordPayload = `${staffCtx.resourceId}|${clockEventType}|${now.toISOString()}|${dayKey}`;
      signature = await hmacSha256Hex(fiscalKey, recordPayload);
    } catch (_) {
      signature = "SIGNATURE_UNAVAILABLE";
    }

    // Verificar ultimo fichaje del dia para evitar duplicados
    const lastFichajeRes = await wixData
      .query(REGISTROS_COL)
      .eq("resourceId", staffCtx.resourceId)
      .eq("dayKey", dayKey)
      .descending("recordedAt")
      .limit(1)
      .find({ suppressAuth: true });

    const lastFichaje = lastFichajeRes?.items?.[0];

    // Validar secuencia logica de fichajes
    if (clockEventType === TIPO_FICHAJE.SALIDA) {
      if (!lastFichaje || lastFichaje.clockEventType === TIPO_FICHAJE.SALIDA) {
        return { status: "ERROR", data: null, error: { code: "INVALID_SEQUENCE", message: "No se puede registrar SALIDA sin ENTRADA previa" } };
      }
    }
    if (clockEventType === TIPO_FICHAJE.ENTRADA) {
      if (lastFichaje && lastFichaje.clockEventType === TIPO_FICHAJE.ENTRADA) {
        return { status: "ERROR", data: null, error: { code: "INVALID_SEQUENCE", message: "Ya existe una ENTRADA sin SALIDA correspondiente" } };
      }
    }

    const record = {
      resourceId: staffCtx.resourceId,
      displayName: staffCtx.displayName,
      staffMemberId: staffCtx.staffMemberId,
      recordedAt: now,
      recordedTime,
      dayKey,
      monthKey,
      clockEventType,
      type: "REGULAR",
      employeeIdentifier: null,
      employeeName: staffCtx.displayName,
      registeredBy: "SELF",
      registeredByMemberId: staffCtx.memberId,
      recordingName: staffCtx.displayName,
      adjustmentReason: null,
      deviceIp: null,
      deviceIpAddress: null,
      signature,
      meta: {},
      traceId,
    };

    const saved = await wixData.insert(REGISTROS_COL, record, { suppressAuth: true });

    log.info("Fichaje registrado", {
      resourceId: staffCtx.resourceId,
      clockEventType,
      dayKey,
      traceId,
    });

    return { status: "SUCCESS", data: saved, error: null };
  } catch (err) {
    log.error("registrarFichaje failed", { error: err?.message, traceId });
    return { status: "ERROR", data: null, error: _toPublicError(err, "FICHAJE_FAIL") };
  }
});

// =============================================================================
// BLOQUE 4 — GET ESTADO JORNADA
// =============================================================================

export const getEstadoJornada = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("estado-jornada");
  try {
    const staffCtx = await _resolveStaffContext(traceId);
    if (!staffCtx) {
      return { status: "ERROR", data: null, error: { code: "NOT_STAFF", message: "Current member is not active staff" } };
    }

    const today = _getMadridDayKey(_getMadridNow());

    const fichajesRes = await wixData
      .query(REGISTROS_COL)
      .eq("resourceId", staffCtx.resourceId)
      .eq("dayKey", today)
      .ascending("recordedAt")
      .find({ suppressAuth: true });

    const fichajes = fichajesRes?.items || [];
    const lastFichaje = fichajes.length > 0 ? fichajes[fichajes.length - 1] : null;

    let estadoActual = "SIN_FICHAJE";
    if (lastFichaje) {
      if (lastFichaje.clockEventType === TIPO_FICHAJE.ENTRADA) estadoActual = "TRABAJANDO";
      else if (lastFichaje.clockEventType === TIPO_FICHAJE.SALIDA) estadoActual = "FUERA";
      else if (lastFichaje.clockEventType === TIPO_FICHAJE.PAUSA_INICIO) estadoActual = "EN_PAUSA";
      else if (lastFichaje.clockEventType === TIPO_FICHAJE.PAUSA_FIN) estadoActual = "TRABAJANDO";
    }

    return {
      status: "SUCCESS",
      data: {
        resourceId: staffCtx.resourceId,
        displayName: staffCtx.displayName,
        dayKey: today,
        estadoActual,
        fichajes: fichajes.map((f) => ({
          clockEventType: f.clockEventType,
          recordedAt: f.recordedAt,
          recordedTime: f.recordedTime,
        })),
        totalFichajes: fichajes.length,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "ESTADO_JORNADA_FAIL") };
  }
});

// =============================================================================
// BLOQUE 5 — CALCULAR HORAS TRABAJADAS
// =============================================================================

export const calcularHorasTrabajadas = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("calc-horas");
  try {
    const staffCtx = await _resolveStaffContext(traceId);
    if (!staffCtx) {
      return { status: "ERROR", data: null, error: { code: "NOT_STAFF", message: "Current member is not active staff" } };
    }

    const dayKey = _readDate(options?.dayKey) || _getMadridDayKey(_getMadridNow());

    const fichajesRes = await wixData
      .query(REGISTROS_COL)
      .eq("resourceId", staffCtx.resourceId)
      .eq("dayKey", dayKey)
      .ascending("recordedAt")
      .find({ suppressAuth: true });

    const fichajes = fichajesRes?.items || [];

    // Calcular horas trabajadas: ENTRADA-SALIDA menos PAUSA_INICIO-PAUSA_FIN
    let totalMs = 0;
    let entradaMs = null;
    let pausaInicioMs = null;

    for (const f of fichajes) {
      const ts = new Date(f.recordedAt).getTime();
      if (f.clockEventType === TIPO_FICHAJE.ENTRADA) {
        entradaMs = ts;
      } else if (f.clockEventType === TIPO_FICHAJE.SALIDA && entradaMs !== null) {
        totalMs += ts - entradaMs;
        entradaMs = null;
      } else if (f.clockEventType === TIPO_FICHAJE.PAUSA_INICIO) {
        pausaInicioMs = ts;
      } else if (f.clockEventType === TIPO_FICHAJE.PAUSA_FIN && pausaInicioMs !== null) {
        totalMs -= ts - pausaInicioMs;
        pausaInicioMs = null;
      }
    }

    const horasTrabajadas = Math.round((totalMs / 3600000) * 100) / 100;

    return {
      status: "SUCCESS",
      data: {
        resourceId: staffCtx.resourceId,
        dayKey,
        horasTrabajadas,
        minutosTrabajados: Math.round(totalMs / 60000),
        totalFichajes: fichajes.length,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "CALC_HORAS_FAIL") };
  }
});

// =============================================================================
// BLOQUE 6 — GET HISTORIAL FICHAJES
// =============================================================================

export const getHistorialFichajes = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("hist-fichajes");
  try {
    const staffCtx = await _resolveStaffContext(traceId);
    if (!staffCtx) {
      return { status: "ERROR", data: null, error: { code: "NOT_STAFF", message: "Current member is not active staff" } };
    }

    const limit = Math.min(Number(options?.limit) || 30, 100);
    const query = wixData
      .query(REGISTROS_COL)
      .eq("resourceId", staffCtx.resourceId);

    if (options?.monthKey) {
      query.eq("monthKey", options.monthKey);
    }

    const fichajesRes = await query
      .descending("recordedAt")
      .limit(limit)
      .find({ suppressAuth: true });

    return {
      status: "SUCCESS",
      data: {
        resourceId: staffCtx.resourceId,
        fichajes: fichajesRes?.items || [],
        total: fichajesRes?.items?.length || 0,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "HISTORIAL_FAIL") };
  }
});

// =============================================================================
// BLOQUE 7 — REGISTRAR AJUSTE HORARIO (SOLO ADMIN)
// [HOR-05] Ajustes solo por ADMIN con motivo obligatorio
// =============================================================================

export const registrarAjusteHorario = webMethod(Permissions.Admin, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("ajuste-horario");
  try {
    await requireAdmin(traceId);

    const targetResourceId = _safeTrim(options?.resourceId);
    const clockEventType = _safeTrim(options?.clockEventType).toUpperCase();
    const adjustmentReason = _safeTrim(options?.adjustmentReason || options?.motivo);
    const recordedAtStr = options?.recordedAt || options?.fechaHora;

    if (!targetResourceId) {
      return { status: "ERROR", data: null, error: { code: "INVALID_RESOURCE", message: "resourceId del trabajador requerido" } };
    }
    if (!adjustmentReason || adjustmentReason.length < 5) {
      return { status: "ERROR", data: null, error: { code: "REASON_REQUIRED", message: "Motivo de ajuste obligatorio (min 5 caracteres)" } };
    }
    if (!Object.values(TIPO_FICHAJE).includes(clockEventType)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_CLOCK_TYPE", message: "Tipo de fichaje invalido" } };
    }

    const recordedAt = recordedAtStr ? new Date(recordedAtStr) : _getMadridNow();
    if (isNaN(recordedAt.getTime())) {
      return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "Fecha/hora invalida" } };
    }

    const staff = await findStaff(targetResourceId);
    if (!staff) {
      return { status: "ERROR", data: null, error: { code: "STAFF_NOT_FOUND", message: "Trabajador no encontrado" } };
    }

    const dayKey = _getMadridDayKey(recordedAt);
    const monthKey = _getMadridMonthKey(recordedAt);
    const recordedTime = _getMadridTime(recordedAt);

    const adminCtx = await _getCurrentMemberContext(traceId);

    let signature = "";
    try {
      const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
      const recordPayload = `${targetResourceId}|AJUSTE|${recordedAt.toISOString()}|${dayKey}`;
      signature = await hmacSha256Hex(fiscalKey, recordPayload);
    } catch (_) {
      signature = "SIGNATURE_UNAVAILABLE";
    }

    const record = {
      resourceId: targetResourceId,
      displayName: staff.displayName,
      staffMemberId: staff.staffMemberId,
      recordedAt,
      recordedTime,
      dayKey,
      monthKey,
      clockEventType,
      type: "AJUSTE",
      employeeIdentifier: null,
      employeeName: staff.displayName,
      registeredBy: "ADMIN",
      registeredByMemberId: adminCtx?.memberId || null,
      recordingName: adminCtx?.email || "ADMIN",
      adjustmentReason,
      deviceIp: null,
      deviceIpAddress: null,
      signature,
      meta: { originalRequest: options },
      traceId,
    };

    const saved = await wixData.insert(REGISTROS_COL, record, { suppressAuth: true });

    log.info("Ajuste horario registrado", {
      resourceId: targetResourceId,
      clockEventType,
      adjustmentReason,
      traceId,
    });

    return { status: "SUCCESS", data: saved, error: null };
  } catch (err) {
    log.error("registrarAjusteHorario failed", { error: err?.message, traceId });
    return { status: "ERROR", data: null, error: _toPublicError(err, "AJUSTE_FAIL") };
  }
});

// =============================================================================
// BLOQUE 8 — GET RESUMEN HORAS
// =============================================================================

export const getResumenHoras = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("resumen-horas");
  try {
    const staffCtx = await _resolveStaffContext(traceId);
    if (!staffCtx) {
      return { status: "ERROR", data: null, error: { code: "NOT_STAFF", message: "Current member is not active staff" } };
    }

    const monthKey = options?.monthKey || _getMadridMonthKey(_getMadridNow());

    const fichajesRes = await wixData
      .query(REGISTROS_COL)
      .eq("resourceId", staffCtx.resourceId)
      .eq("monthKey", monthKey)
      .ascending("recordedAt")
      .limit(1000)
      .find({ suppressAuth: true });

    const fichajes = fichajesRes?.items || [];

    // Agrupar por dia
    const diasMap = {};
    for (const f of fichajes) {
      if (!diasMap[f.dayKey]) diasMap[f.dayKey] = [];
      diasMap[f.dayKey].push(f);
    }

    const resumen = [];
    for (const [dayKey, dayFichajes] of Object.entries(diasMap)) {
      let totalMs = 0;
      let entradaMs = null;
      let pausaInicioMs = null;

      for (const f of dayFichajes) {
        const ts = new Date(f.recordedAt).getTime();
        if (f.clockEventType === TIPO_FICHAJE.ENTRADA) {
          entradaMs = ts;
        } else if (f.clockEventType === TIPO_FICHAJE.SALIDA && entradaMs !== null) {
          totalMs += ts - entradaMs;
          entradaMs = null;
        } else if (f.clockEventType === TIPO_FICHAJE.PAUSA_INICIO) {
          pausaInicioMs = ts;
        } else if (f.clockEventType === TIPO_FICHAJE.PAUSA_FIN && pausaInicioMs !== null) {
          totalMs -= ts - pausaInicioMs;
          pausaInicioMs = null;
        }
      }

      resumen.push({
        dayKey,
        horasTrabajadas: Math.round((totalMs / 3600000) * 100) / 100,
        fichajes: dayFichajes.length,
      });
    }

    const totalHorasMes = resumen.reduce((sum, d) => sum + d.horasTrabajadas, 0);

    return {
      status: "SUCCESS",
      data: {
        resourceId: staffCtx.resourceId,
        monthKey,
        totalHorasMes: Math.round(totalHorasMes * 100) / 100,
        diasTrabajados: resumen.length,
        detalle: resumen,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "RESUMEN_FAIL") };
  }
});

// =============================================================================
// BLOQUE 9 — VALIDAR SOLAPAMIENTO DE HORARIOS
// =============================================================================

export async function _validateScheduleNoOverlap(resourceId, dayOfWeek, startTime, endTime, excludeId) {
  // Placeholder para validacion de solapamiento de horarios
  // Se implementara en iteracion futura cuando se anada coleccion de horarios
  return { valid: true };
}