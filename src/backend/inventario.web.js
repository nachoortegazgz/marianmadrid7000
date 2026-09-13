// ============================================================================
// FLUJO 15 — CIERRE DE INVENTARIO VALORADO (FIX C3)
// DOSSIER CAJA §20 — Fotografia valorada del inventario al cierre de ejercicio
// ============================================================================

import { hashSHA256, hmacSha256Hex } from "backend/securityEngine";
import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";

/**
 * Genera un cierre de inventario valorado para un ejercicio fiscal.
 * Crea un registro inmutable en InventarioStockVentaCierre por cada SKU activo.
 */
export const generateInventoryClosing = webMethod(Permissions.Admin, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("inv-close");
  try {
    await requireAdmin(traceId);

    const fiscalYear = Number(options?.fiscalYear);
    if (!Number.isFinite(fiscalYear) || fiscalYear < 2020 || fiscalYear > 2100) {
      return { status: "ERROR", data: null, error: { code: "INVALID_FISCAL_YEAR", message: "fiscalYear invalido" } };
    }

    const closingType = _safeTrim(options?.closingType).toUpperCase() || "ANUAL";
    if (!["ANUAL", "MENSUAL", "EXTRAORDINARIO"].includes(closingType)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_CLOSING_TYPE", message: "closingType debe ser ANUAL, MENSUAL o EXTRAORDINARIO" } };
    }

    const closingDate = _readDate(options?.closingDate) || new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });

    // Verificar que no existe ya un cierre para este ejercicio + tipo
    const existingClosing = await wixData
      .query(CIERRE_INV_COL)
      .eq("fiscalYear", fiscalYear)
      .eq("closingType", closingType)
      .limit(1)
      .find({ suppressAuth: true });

    if (existingClosing?.items?.length > 0) {
      return { status: "ERROR", data: null, error: { code: "CLOSING_ALREADY_EXISTS", message: "Ya existe un cierre para este ejercicio y tipo" } };
    }

    // Obtener todos los articulos activos
    const stockRes = await wixData
      .query(INVENTARIO_COL)
      .eq("active", true)
      .limit(1000)
      .find({ suppressAuth: true });

    const stockItems = stockRes?.items || [];
    if (stockItems.length === 0) {
      return { status: "ERROR", data: null, error: { code: "NO_STOCK_ITEMS", message: "No hay articulos activos en inventario" } };
    }

    // Obtener clave fiscal para firma
    let fiscalKey = "";
    try {
      fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
    } catch (_) {
      fiscalKey = "";
    }

    const closingRecords = [];
    let totalStockValue = 0;

    for (const item of stockItems) {
      const sku = _safeTrim(item.sku);
      const stockQuantity = Number(item.stockExpected) || 0;
      const unitCost = Number(item.costExTax) || 0;
      const stockValue = _roundMoney(stockQuantity * unitCost);
      totalStockValue += stockValue;

      const closingId = `CLOSING_${fiscalYear}_${closingType}_${sku}`;

      // Calcular hash del registro
      const recordPayload = _stableSerializeLocal({
        closingId,
        fiscalYear,
        closingDate,
        closingType,
        sku,
        stockQuantity,
        unitCost,
        stockValue,
      });
      const closingHash = fiscalKey ? await hashSHA256(recordPayload) : "";
      const closingSignature = fiscalKey && closingHash ? await hmacSha256Hex(fiscalKey, closingHash) : "";

      const closingRecord = {
        _id: closingId,
        inventoryClosingId: closingId,
        fiscalYear,
        closingDate: new Date(closingDate),
        closingType,
        sku,
        productId: item.wixProductId || null,
        productDescription: _safeTrim(item.productName) || _safeTrim(item.description) || "",
        stockQuantity,
        unitCost,
        stockValue,
        accountCode: "300000",
        debitBalance: stockValue > 0 ? stockValue : 0,
        creditBalance: stockValue < 0 ? Math.abs(stockValue) : 0,
        closingHash,
        closingSignature,
        traceId,
        _createdDate: new Date(),
      };

      closingRecords.push(closingRecord);
    }

    // Insertar todos los registros de cierre
    for (const record of closingRecords) {
      await wixData.insert(CIERRE_INV_COL, record, { suppressAuth: true });
    }

    await _logAuditEventLocal("INVENTORY_CLOSING_GENERATED", "INFO", `Cierre de inventario generado: ${fiscalYear} ${closingType}`, { fiscalYear, closingType, totalItems: closingRecords.length, totalStockValue, traceId }, traceId, `CLOSING_${fiscalYear}`);

    return {
      status: "SUCCESS",
      data: {
        fiscalYear,
        closingType,
        closingDate,
        totalItems: closingRecords.length,
        totalStockValue: _roundMoney(totalStockValue),
        closingIds: closingRecords.map((r) => r._id),
      },
      error: null,
    };
  } catch (err) {
    const norm = normalizeErrorLocal(err);
    log.error("generateInventoryClosing failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "INV_CLOSE_FAIL", message: norm.message } };
  }
});

/**
 * Lista los cierres de inventario generados.
 */
export const listInventoryClosings = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("list-inv-close");
  try {
    await requireCajero(traceId);

    const fiscalYear = Number(options?.fiscalYear);
    const closingType = _safeTrim(options?.closingType);

    let query = wixData.query(CIERRE_INV_COL);
    if (fiscalYear) query = query.eq("fiscalYear", fiscalYear);
    if (closingType) query = query.eq("closingType", closingType);

    const res = await query
      .descending("closingDate")
      .limit(Math.min(Number(options?.limit) || 50, 200))
      .find({ suppressAuth: true });

    return {
      status: "SUCCESS",
      data: {
        closings: res?.items || [],
        total: res?.items?.length || 0,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "LIST_INV_CLOSE_FAIL") };
  }
});

// Helpers locales para evitar conflictos de import
function _stableSerializeLocal(value) {
  const seen = new WeakSet();
  function stable(val) {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "string") return JSON.stringify(val);
    if (typeof val !== "object") return "null";
    if (seen.has(val)) return '"[Circular]"';
    seen.add(val);
    if (Array.isArray(val)) return "[" + val.map((item) => stable(item)).join(",") + "]";
    const keys = Object.keys(val).sort();
    const parts = keys.map((key) => JSON.stringify(key) + ":" + stable(val[key]));
    return "{" + parts.join(",") + "}";
  }
  return stable(value);
}

async function _logAuditEventLocal(tipoEvento, level, message, data = {}, traceId, entityId = "system") {
  try {
    const logId = `AUDIT_${_safeTrim(tipoEvento).slice(0, 30)}_${_safeTrim(entityId).slice(0, 20)}_${Date.now()}`;
    await wixData.insert(
      COLLECTIONS.MM_AUDIT_LOG,
      {
        _id: logId,
        eventType: tipoEvento,
        level,
        message,
        data,
        resourceId: "SYSTEM",
        source: "backend/inventario.web.js",
        loggedAt: new Date(),
        traceId,
      },
      { suppressAuth: true }
    ).catch(() => null);
  } catch (err) {
    log.error("Failed to write to AUDIT_LOG", { error: err?.message, traceId });
  }
}

function normalizeErrorLocal(err) {
  if (err && typeof err === "object" && err.code) {
    return { code: String(err.code), message: String(err.message || "Unknown error") };
  }
  if (err instanceof Error) {
    return { code: err.code || "UNKNOWN_ERROR", message: err.message || "Unknown error" };
  }
  return { code: "UNKNOWN_ERROR", message: String(err || "Unknown error") };
}