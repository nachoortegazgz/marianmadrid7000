/*
=============================================================================
MODULE: public/marianAdministrationController.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 13.4
RESPONSIBILITY: Controlador del widget de administracion. Despacha acciones
                admin, lee parametros de periodo y gestiona errores de
                postMessage.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/

import { createWidgetBridge } from "public/widgetBridge";

function _postError(post, responseType, messageId, message, code) {
  try {
    post({
      type: responseType,
      messageId,
      status: "ERROR",
      error: { code: code || "UNKNOWN", message: message || "Unknown error" },
    });
  } catch (_) {
    // Silenciar errores de postMessage
  }
}

function _readYear(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 2020 || n > 2100) return null;
  return Math.floor(n);
}

function _readQuarter(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 4) return null;
  return Math.floor(n);
}

function _readEmail(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

function _readDocumentId(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 200) return null;
  return s;
}

function _readPeriodParams(payload) {
  const year = _readYear(payload?.year);
  const quarter = _readQuarter(payload?.quarter);
  const month = payload?.month ? Number(payload.month) : null;
  return { year, quarter, month };
}

const ADMIN_ACTION_DISPATCH = Object.freeze({
  "GET_CASHIER_STATE": "getCashierState",
  "REGISTER_MANUAL_TX": "registerManualTransaction",
  "REGISTER_X_COUNT": "registerXCount",
  "REGISTER_Z_CLOSING": "registerZClosing",
  "VERIFY_HASH_CHAIN": "verifyFiscalHashChainIntegrity",
  "GET_INVENTORY_DASHBOARD": "getInventoryDashboard",
  "GET_RECONCILIATION_QUEUE": "getInventoryReconciliationQueue",
  "GET_STAFF_CONTEXT": "getMyStaffContext",
  "REGISTER_FICHAJE": "registrarFichaje",
  "GET_JORNADA_STATE": "getEstadoJornada",
  "CHECK_ADMIN_ACCESS": "checkAdminAccess",
  "CHECK_CAJERO_ACCESS": "checkCajeroAccess",
  "GET_FISCAL_REPORT": "generateLibroIVAExpedidas",
  "GET_Z_CLOSING_REPORT": "generateCierreZReport",
});

export function initMarianAdministration(widget, slug) {
  if (!widget) {
    throw new Error("initMarianAdministration: widget is required");
  }

  const bridge = createWidgetBridge(widget, {
    messageType: "MM_ADMIN",
    onMessage: async (payload, event) => {
      const action = payload?.action;
      const messageId = payload?.messageId || `msg_${Date.now()}`;

      if (!action || !ADMIN_ACTION_DISPATCH[action]) {
        _postError(bridge.postMessage.bind(bridge), "MM_ADMIN_RESPONSE", messageId, `Unknown action: ${action}`, "UNKNOWN_ACTION");
        return;
      }

      const targetMethod = ADMIN_ACTION_DISPATCH[action];

      try {
        // Despachar al metodo backend correspondiente via webMethod
        // La invocacion real depende del contexto de la pagina Wix
        // Ejemplo: const result = await import(`backend/${targetModule}`).then(m => m[targetMethod](payload.params));

        bridge.postMessage({
          type: "MM_ADMIN_RESPONSE",
          messageId,
          status: "DISPATCHED",
          action,
          targetMethod,
          params: payload?.params || {},
        });
      } catch (err) {
        _postError(bridge.postMessage.bind(bridge), "MM_ADMIN_RESPONSE", messageId, err?.message || "Dispatch failed", "DISPATCH_FAIL");
      }
    },
    onError: (err, data) => {
      console.error("[MarianAdministration] Error:", err, data);
    },
  });

  return {
    bridge,
    destroy: () => bridge.destroy(),
  };
}