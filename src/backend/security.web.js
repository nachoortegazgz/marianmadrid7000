/*
=============================================================================
MODULE: backend/security.web.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 12.9 + DIRECTRICES V19
RESPONSIBILITY: Web methods que envuelven las verificaciones de seguridad
                para consumo desde frontend. Capa delgada que delega en
                backend/security.js.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           No reimplementa logica de seguridad.
CORRECTIONS APPLIED:
  [SECW-01] Delegacion pura en security.js sin duplicacion.
  [SECW-02] Respuestas uniformes { status, data, error }.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";
import { isAdmin, isCajero, isStaffCollaborator } from "backend/security";
import { _toPublicError } from "backend/responseUtils";

const log = logger;

// =============================================================================
// BLOQUE 1 — CHECK ADMIN ACCESS
// =============================================================================

export const checkAdminAccess = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("sec-admin");
  try {
    const authorized = await isAdmin(traceId);
    return {
      status: "SUCCESS",
      data: { authorized, role: authorized ? "ADMIN" : null },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "SEC_ADMIN_FAIL") };
  }
});

// =============================================================================
// BLOQUE 2 — CHECK CAJERO ACCESS
// =============================================================================

export const checkCajeroAccess = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("sec-cajero");
  try {
    const authorized = await isCajero(traceId);
    return {
      status: "SUCCESS",
      data: { authorized, role: authorized ? "CAJERO" : null },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "SEC_CAJERO_FAIL") };
  }
});

// =============================================================================
// BLOQUE 3 — CHECK STAFF COLLABORATOR ACCESS
// =============================================================================

export const checkStaffCollaboratorAccess = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("sec-staff");
  try {
    const authorized = await isStaffCollaborator(traceId);
    return {
      status: "SUCCESS",
      data: { authorized, role: authorized ? "COLLABORATOR" : null },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "SEC_STAFF_FAIL") };
  }
});