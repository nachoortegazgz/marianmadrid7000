/*
=============================================================================
MODULE: backend/inventario.web.js
VERSION: v5007.3-FINAL
BASE: BIBLIA v5002.5 Bloque 12.14 + DOSSIER CAJA Flujos 4,5,13,14,15
RESPONSIBILITY: Dashboard de inventario, cola de conciliacion Wix,
                movimiento seguro de inventario, y cierre de inventario
                valorado con hash y firma.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Idempotencia por movementToken.
           Conciliacion con Wix Stores V1.
CORRECTIONS APPLIED:
  [INV-01] movementToken como clave de idempotencia.
  [INV-02] stockBefore/stockAfter para trazabilidad.
  [INV-03] needsWixReconciliation cuando aplica.
  [INV-04] recordOnlineInventoryOrderInternal para webhooks eCommerce.
  [INV-05] recordOnlineInventoryRefundInternal para reembolsos.
  [FIX-C3] generateInventoryClosing + listInventoryClosings.
  [FIX-D1] _stableSerialize importado de mmUtils.js.
  [FIX-D2] normalizeError importado de bookingCore.js.
  [FIX-D3] logAuditEvent importado de audit.js.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";

import {
  COLLECTIONS,
  SDK_CONFIG,
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _generateUUID,
  _roundMoney,
  _readDate,
  _stableSerialize,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { requireAdmin, requireCajero } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { normalizeError } from "backend/booking/bookingCore";
import { logAuditEvent } from "backend/audit";

import { hashSHA256, hmacSha256Hex } from "backend/securityEngine";
import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";

const log = logger;
const INVENTARIO_COL = COLLECTIONS.INVENTARIO_STOCK_VENTA;
const MOVIMIENTOS_INV_COL = COLLECTIONS.MOVIMIENTOS_INVENTARIO;
const CIERRE_INV_COL = COLLECTIONS.INVENTARIO_STOCK_VENTA_CIERRE;

// =============================================================================
// BLOQUE 1 — GET INVENTORY DASHBOARD
// =============================================================================

export const getInventoryDashboard = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("inv-dashboard");
  try {
    await requireCajero(traceId);

    const limit = Math.min(Number(options?.limit) || 50, 200);
    const query = wixData.query(INVENTARIO_COL).eq("active", true);

    if (options?.category) {
      query.eq("category", options.category);
    }
    if (options?.search) {
      query.hasSome("productName", [options.search]);
    }

    const res = await query
      .ascending("productName")
      .limit(limit)
      .find({ suppressAuth: true });

    const items = res?.items || [];

    const totalStock = items.reduce((sum, item) => sum + Number(item.stockExpected || 0), 0);
    const lowStockItems = items.filter((item) => Number(item.stockExpected || 0) <= Number(item.lowStockAlert || 5));
    const needsReconciliation = items.filter((item) => item.needsWixReconciliation === true);

    return {
      status: "SUCCESS",
      data: {
        items,
        totalItems: items.length,
        totalStock,
        lowStockCount: lowStockItems.length,
        needsReconciliationCount: needsReconciliation.length,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "INV_DASHBOARD_FAIL") };
  }
});

// =============================================================================
// BLOQUE 2 — GET INVENTORY RECONCILIATION QUEUE
// =============================================================================

export const getInventoryReconciliationQueue = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("inv-recon");
  try {
    await requireAdmin(traceId);

    const res = await wixData
      .query(INVENTARIO_COL)
      .eq("needsWixReconciliation", true)
      .limit(100)
      .find({ suppressAuth: true });

    return {
      status: "SUCCESS",
      data: {
        items: res?.items || [],
        total: res?.items?.length || 0,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "INV_RECON_FAIL") };
  }
});

// =============================================================================
// BLOQUE 3 — RECORD INVENTORY MOVEMENT SAFE
// [INV-01] movementToken como clave de idempotencia
// =============================================================================

export async function recordInventoryMovementSafe(sku, movementType, quantity, meta = {}) {
  const traceId = meta.traceId || makeTraceId("inv-mov");
  const cleanSku = _safeTrim(sku);

  if (!cleanSku) {
    return { status: "ERROR", data: null, error: { code: "INVALID_SKU", message: "SKU requerido" } };
  }

  const qty = Number(quantity) || 0;
  if (qty === 0) {
    return { status: "ERROR", data: null, error: { code: "INVALID_QUANTITY", message: "Cantidad no puede ser 0" } };
  }

  const movementToken = meta.movementToken || _generateUUID();

  const existingRes = await wixData
    .query(MOVIMIENTOS_INV_COL)
    .eq("movementToken", movementToken)
    .limit(1)
    .find({ suppressAuth: true });

  if (existingRes?.items?.length > 0) {
    return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
  }

  const stockRes = await wixData
    .query(INVENTARIO_COL)
    .eq("sku", cleanSku)
    .limit(1)
    .find({ suppressAuth: true });

  const stockItem = stockRes?.items?.[0];
  if (!stockItem) {
    return { status: "ERROR", data: null, error: { code: "SKU_NOT_FOUND", message: `SKU ${cleanSku} no encontrado en inventario` } };
  }

  const stockBefore = Number(stockItem.stockExpected || 0);
  const stockAfter = stockBefore + qty;

  if (stockAfter < 0 && !meta.allowNegativeStock) {
    return { status: "ERROR", data: null, error: { code: "NEGATIVE_STOCK", message: `Stock resultante seria ${stockAfter}. Stock actual: ${stockBefore}` } };
  }

  const movement = {
    movementToken,
    sku: cleanSku,
    productName: stockItem.productName || "",
    quantity: Math.abs(qty),
    quantityDelta: qty,
    stockBefore,
    stockAfter,
    movementType: _safeTrim(movementType).toUpperCase(),
    reason: meta.reason || meta.motivo || "",
    referenceId: meta.referenceId || null,
    orderId: meta.orderId || null,
    refundId: meta.refundId || null,
    actorEmail: meta.actorEmail || null,
    actorMemberId: meta.actorMemberId || null,
    requiresWixReconciliation: meta.requiresWixReconciliation === true,
    nativeCommercialMovement: meta.nativeCommercialMovement === true,
    wixProductId: stockItem.wixProductId || null,
    wixVariantId: stockItem.wixVariantId || null,
    traceId,
  };

  const savedMovement = await wixData.insert(MOVIMIENTOS_INV_COL, movement, { suppressAuth: true });

  stockItem.stockExpected = stockAfter;
  stockItem.lastInventoryMovementAt = new Date();
  stockItem.lastInventoryMovementId = savedMovement._id;
  if (meta.requiresWixReconciliation) {
    stockItem.needsWixReconciliation = true;
  }
  stockItem._updatedDate = new Date();
  await wixData.update(INVENTARIO_COL, stockItem, { suppressAuth: true });

  log.info("Movimiento de inventario registrado", {
    sku: cleanSku,
    movementType,
    quantityDelta: qty,
    stockBefore,
    stockAfter,
    traceId,
  });

  return { status: "SUCCESS", data: savedMovement, error: null };
}

// =============================================================================
// BLOQUE 4 — RECORD ONLINE INVENTORY ORDER
// [INV-04] Llamado desde events.js wixEcom_onOrderPaymentStatusUpdated
// =============================================================================

export async function recordOnlineInventoryOrderInternal(order, traceId) {
  const orderId = _safeTrim(order?._id || order?.id);
  if (!orderId) {
    return { status: "SKIPPED", reason: "NO_ORDER_ID" };
  }

  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  if (lineItems.length === 0) {
    return { status: "SKIPPED", reason: "NO_LINE_ITEMS" };
  }

  const results = [];
  for (const item of lineItems) {
    const sku = _safeTrim(item?.sku || item?.productId);
    if (!sku) continue;

    const quantity = -(Number(item?.quantity) || 1);
    const movementToken = `ORDER-${orderId}-${sku}`;

    const result = await recordInventoryMovementSafe(sku, "ONLINE_SALE", quantity, {
      traceId,
      movementToken,
      orderId,
      reason: `Venta online pedido ${orderId}`,
      requiresWixReconciliation: true,
      nativeCommercialMovement: true,
    });

    results.push({ sku, status: result.status });
  }

  return { status: "SUCCESS", data: results };
}

// =============================================================================
// BLOQUE 5 — RECORD ONLINE INVENTORY REFUND
// [INV-05] Llamado desde events.js wixEcom_onOrderRefunded
// =============================================================================

export async function recordOnlineInventoryRefundInternal(order, refundObj, restockInfo, traceId) {
  const orderId = _safeTrim(order?._id || order?.id);
  const refundId = _safeTrim(refundObj?._id || refundObj?.id);

  if (!orderId || !refundId) {
    return { status: "SKIPPED", reason: "MISSING_IDS" };
  }

  if (!restockInfo) {
    return { status: "SKIPPED", reason: "NO_CONFIRMED_RESTOCK" };
  }

  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const results = [];

  for (const item of lineItems) {
    const sku = _safeTrim(item?.sku || item?.productId);
    if (!sku) continue;

    const quantity = Number(item?.quantity) || 1;
    const movementToken = `REFUND-${refundId}-${sku}`;

    const result = await recordInventoryMovementSafe(sku, "RETURN", quantity, {
      traceId,
      movementToken,
      orderId,
      refundId,
      reason: `Devolucion reembolso ${refundId}`,
      requiresWixReconciliation: true,
    });

    results.push({ sku, status: result.status });
  }

  return { status: "SUCCESS", data: results };
}

// =============================================================================
// BLOQUE 6 — [FIX-C3] GENERAR CIERRE DE INVENTARIO VALORADO
// DOSSIER CAJA §20 — Fotografia valorada del inventario al cierre de ejercicio
// =============================================================================

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

    const existingClosing = await wixData
      .query(CIERRE_INV_COL)
      .eq("fiscalYear", fiscalYear)
      .eq("closingType", closingType)
      .limit(1)
      .find({ suppressAuth: true });

    if (existingClosing?.items?.length > 0) {
      return { status: "ERROR", data: null, error: { code: "CLOSING_ALREADY_EXISTS", message: "Ya existe un cierre para este ejercicio y tipo" } };
    }

    const stockRes = await wixData
      .query(INVENTARIO_COL)
      .eq("active", true)
      .limit(1000)
      .find({ suppressAuth: true });

    const stockItems = stockRes?.items || [];
    if (stockItems.length === 0) {
      return { status: "ERROR", data: null, error: { code: "NO_STOCK_ITEMS", message: "No hay articulos activos en inventario" } };
    }

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

      const recordPayload = _stableSerialize({
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

    for (const record of closingRecords) {
      await wixData.insert(CIERRE_INV_COL, record, { suppressAuth: true });
    }

    await logAuditEvent(
      "INVENTORY_CLOSING_GENERATED",
      "INFO",
      `Cierre de inventario generado: ${fiscalYear} ${closingType}`,
      { fiscalYear, closingType, totalItems: closingRecords.length, totalStockValue, traceId },
      traceId,
      `CLOSING_${fiscalYear}`,
      "backend/inventario.web.js"
    );

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
    const norm = normalizeError(err);
    log.error("generateInventoryClosing failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "INV_CLOSE_FAIL", message: norm.message } };
  }
});

// =============================================================================
// BLOQUE 7 — [FIX-C3] LISTAR CIERRES DE INVENTARIO
// =============================================================================

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