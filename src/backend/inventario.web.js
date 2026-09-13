/*
=============================================================================
MODULE: backend/inventario.web.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 12.14 + ESQUEMA CMS 4.11-4.13 + DOSSIER CAJA Flujos 9-15
RESPONSIBILITY: Dashboard de inventario, cola de conciliacion Wix y
                movimiento seguro de inventario. Integracion con Wix Stores V1.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Idempotencia por movementToken.
           Conciliacion con Wix Stores V1 (no V3).
CORRECTIONS APPLIED:
  [INV-01] movementToken como clave de idempotencia.
  [INV-02] stockBefore/stockAfter para trazabilidad.
  [INV-03] needsWixReconciliation cuando aplica.
  [INV-04] recordOnlineInventoryOrderInternal para webhooks eCommerce.
  [INV-05] recordOnlineInventoryRefundInternal para reembolsos.
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
} from "public/mmUtils";

import { logger } from "backend/logger";
import { requireAdmin, requireCajero } from "backend/security";
import { _toPublicError } from "backend/responseUtils";

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

    // Resumen
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

  // [INV-01] Idempotencia por movementToken
  const movementToken = meta.movementToken || _generateUUID();

  const existingRes = await wixData
    .query(MOVIMIENTOS_INV_COL)
    .eq("movementToken", movementToken)
    .limit(1)
    .find({ suppressAuth: true });

  if (existingRes?.items?.length > 0) {
    return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
  }

  // Obtener stock actual
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

  // Validar stock negativo
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

  // Actualizar stock en InventarioStockVenta
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
// BLOQUE 4 — RECORD ONLINE INVENTORY ORDER (Webhook eCommerce)
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
// BLOQUE 5 — RECORD ONLINE INVENTORY REFUND (Webhook eCommerce)
// [INV-05] Llamado desde events.js wixEcom_onOrderRefunded
// =============================================================================

export async function recordOnlineInventoryRefundInternal(order, refundObj, restockInfo, traceId) {
  const orderId = _safeTrim(order?._id || order?.id);
  const refundId = _safeTrim(refundObj?._id || refundObj?.id);

  if (!orderId || !refundId) {
    return { status: "SKIPPED", reason: "MISSING_IDS" };
  }

  // Verificar si hay restock confirmado
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