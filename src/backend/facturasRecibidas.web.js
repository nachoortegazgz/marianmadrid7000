/*
=============================================================================
MODULE: backend/facturasRecibidas.web.js
VERSION: v5007.2-FINAL (FIX C2 — MODULO NUEVO)
BASE: DOSSIER CAJA §17 + BIBLIA v5002.5 + ESQUEMA CMS 4.22
RESPONSIBILITY: Registro de facturas recibidas de proveedores.
                Genera asiento contable y actualiza LibroIVAFacturasRecibidas.
                Valida NIF proveedor, base, cuota y tipo impositivo.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [FR-01] Idempotencia por receptionNumber.
  [FR-02] Validacion de NIF proveedor.
  [FR-03] Asiento contable automatico en partida doble.
  [FR-04] Integracion con movimiento de caja si se paga inmediatamente.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";

import {
  COLLECTIONS,
  SDK_CONFIG,
  FORMA_PAGO,
  IVA_RATES,
  TIPO_MOVIMIENTO,
} from "backend/internalConfig";

import {
  makeTraceId,
  _safeTrim,
  _readPositiveAmount,
  _readDate,
  _roundMoney,
  _normalizeIdPart,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { requireAdmin, requireCajero } from "backend/security";
import { _toPublicError } from "backend/responseUtils";
import { registerManualTransaction } from "backend/cajas.web";

const log = logger;

// =============================================================================
// VALIDACION DE NIF
// =============================================================================

function _isValidNIF(nif) {
  const n = _safeTrim(nif).toUpperCase();
  if (!n) return false;
  return /^[A-Z0-9]{9}$/.test(n) || /^[A-Z]{1}[0-9]{8}$/.test(n);
}

// =============================================================================
// WEBMETHOD: REGISTRAR FACTURA RECIBIDA
// [FR-01] Idempotencia por receptionNumber
// [FR-02] Validacion de NIF proveedor
// [FR-03] Asiento contable automatico
// =============================================================================

export const registerReceivedInvoice = webMethod(Permissions.SiteMember, async (payload) => {
  const traceId = payload?.traceId || makeTraceId("rec-inv");
  try {
    await requireCajero(traceId);

    const receptionNumber = _safeTrim(payload?.receptionNumber);
    if (!receptionNumber) {
      return { status: "ERROR", data: null, error: { code: "INVALID_RECEPTION_NUMBER", message: "receptionNumber requerido" } };
    }

    // [FR-01] Idempotencia
    const existingRes = await wixData
      .query(COLLECTIONS.LIBRO_IVA_FACTURAS_RECIBIDAS)
      .eq("receptionNumber", receptionNumber)
      .limit(1)
      .find({ suppressAuth: true });

    if (existingRes?.items?.length > 0) {
      return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
    }

    // [FR-02] Validar NIF proveedor
    const supplierTaxId = _safeTrim(payload?.supplierTaxId).toUpperCase();
    if (!_isValidNIF(supplierTaxId)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_NIF", message: "NIF proveedor invalido" } };
    }

    const supplierName = _safeTrim(payload?.supplierName);
    if (!supplierName) {
      return { status: "ERROR", data: null, error: { code: "INVALID_SUPPLIER", message: "supplierName requerido" } };
    }

    const supplierInvoiceSeriesNumber = _safeTrim(payload?.supplierInvoiceSeriesNumber);
    if (!supplierInvoiceSeriesNumber) {
      return { status: "ERROR", data: null, error: { code: "INVALID_INVOICE_NUMBER", message: "supplierInvoiceSeriesNumber requerido" } };
    }

    const issueDate = _readDate(payload?.issueDate);
    const receptionDate = _readDate(payload?.receptionDate) || issueDate;
    if (!issueDate) {
      return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "issueDate invalida" } };
    }

    const totalInvoiceAmount = _readPositiveAmount(payload?.totalInvoiceAmount);
    if (!totalInvoiceAmount) {
      return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "totalInvoiceAmount positivo requerido" } };
    }

    const taxRate = Number(payload?.taxRate);
    if (![0, 0.04, 0.10, 0.21].includes(taxRate)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_TAX_RATE", message: "taxRate debe ser 0, 0.04, 0.10 o 0.21" } };
    }

    const taxableAmount = _roundMoney(totalInvoiceAmount / (1 + taxRate));
    const inputTaxAmount = _roundMoney(totalInvoiceAmount - taxableAmount);
    const deductibleTaxAmount = payload?.deductibleTaxAmount !== undefined ? _roundMoney(payload.deductibleTaxAmount) : inputTaxAmount;
    const deductibleExpenseAmount = payload?.deductibleExpenseAmount !== undefined ? _roundMoney(payload.deductibleExpenseAmount) : taxableAmount;

    const fiscalYear = Number(issueDate.slice(0, 4));
    const fiscalPeriod = issueDate.slice(0, 7);

    const expenseConcept = _safeTrim(payload?.expenseConcept) || "Gasto";
    const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase() || FORMA_PAGO.EFECTIVO;
    const paymentDate = _readDate(payload?.paymentDate) || null;

    // Insertar en LibroIVAFacturasRecibidas
    const invoiceRecord = {
      _id: receptionNumber,
      receptionNumber,
      supplierInvoiceSeriesNumber,
      issueDate: new Date(issueDate),
      receptionDate: new Date(receptionDate),
      fiscalYear,
      fiscalPeriod,
      totalInvoiceAmount,
      taxableAmount,
      taxRate,
      inputTaxAmount,
      deductibleTaxAmount,
      expenseConcept,
      deductibleExpenseAmount,
      supplierTaxId,
      supplierName,
      paymentDate: paymentDate ? new Date(paymentDate) : null,
      paymentMethod,
      traceId,
      _createdDate: new Date(),
    };

    const saved = await wixData.insert(COLLECTIONS.LIBRO_IVA_FACTURAS_RECIBIDAS, invoiceRecord, { suppressAuth: true });

    // [FR-03] Generar asiento contable automatico
    await _generateExpenseAccountingEntry(saved, traceId);

    // [FR-04] Si se paga inmediatamente, registrar movimiento de caja
    if (paymentDate && paymentMethod !== "PENDIENTE") {
      await registerManualTransaction({
        amount: totalInvoiceAmount,
        paymentMethod,
        tipoMovimiento: TIPO_MOVIMIENTO.PAGO_PROVEEDOR,
        concept: `Pago factura proveedor ${supplierName} - ${supplierInvoiceSeriesNumber}`,
        resourceId: "CAJA_LOCAL",
        traceId,
        transactionId: `INV_REC-${receptionNumber}`,
        origen: "RECEIVED_INVOICE_PAYMENT",
      });
    }

    await _logAuditEvent("RECEIVED_INVOICE_REGISTERED", "INFO", `Factura recibida registrada: ${receptionNumber}`, { receptionNumber, supplierTaxId, totalInvoiceAmount, traceId }, traceId, receptionNumber);

    return { status: "SUCCESS", data: saved, error: null };
  } catch (err) {
    const norm = normalizeError(err);
    log.error("registerReceivedInvoice failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "REC_INV_FAIL", message: norm.message } };
  }
});

// =============================================================================
// GENERAR ASIENTO CONTABLE DE GASTO
// =============================================================================

async function _generateExpenseAccountingEntry(invoice, traceId) {
  try {
    const asientosCol = COLLECTIONS.ASIENTOS_CONTABLES;
    const lineasCol = COLLECTIONS.LINEAS_ASIENTO_CONTABLE;

    const journalEntryId = `GASTO_${invoice.receptionNumber}`;
    const totalDebit = _roundMoney(invoice.totalInvoiceAmount);
    const totalCredit = totalDebit;

    const asiento = {
      _id: journalEntryId,
      journalEntryId,
      sequenceNumber: 0,
      fiscalYear: invoice.fiscalYear,
      fiscalPeriod: invoice.fiscalPeriod,
      operationDate: new Date(invoice.issueDate),
      fiscalOperationDate: new Date(invoice.issueDate),
      description: `Gasto: ${invoice.expenseConcept} - ${invoice.supplierName}`,
      totalDebit,
      totalCredit,
      totalDocumentAmount: _roundMoney(invoice.totalInvoiceAmount),
      entryType: "GASTO",
      entryStatus: "POSTED",
      operationCategory: "GASTO",
      currency: "EUR",
      paymentMethod: invoice.paymentMethod,
      wixOrderId: null,
      wixRefundId: null,
      wixBookingId: null,
      transactionId: `INV_REC-${invoice.receptionNumber}`,
      invoiceNumber: invoice.supplierInvoiceSeriesNumber,
      invoiceIssueDate: new Date(invoice.issueDate),
      invoiceType: "RECIBIDA",
      recordSource: "RECEIVED_INVOICE",
      sourceId: invoice._id,
      schemaVersion: "LEDGER_V2",
      integrityAlgorithmVersion: "HMAC_SHA256_V1",
      previousHash: null,
      entryHash: null,
      entrySignature: null,
      traceId,
      registeredAt: new Date(),
      operationTimeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
      _createdDate: new Date(),
    };

    await wixData.insert(asientosCol, asiento, { suppressAuth: true });

    const lines = [];
    let lineNum = 1;

    // Debe: Cuenta de gasto
    lines.push({
      _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
      lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
      journalEntryId,
      lineNumber: lineNum++,
      accountCode: "600000",
      accountName: "Compras de mercaderias",
      debitAmount: _roundMoney(invoice.taxableAmount),
      creditAmount: 0,
      netAmount: _roundMoney(invoice.taxableAmount),
      lineDescription: invoice.expenseConcept,
      taxableAmount: _roundMoney(invoice.taxableAmount),
      taxRate: invoice.taxRate,
      taxAmount: _roundMoney(invoice.inputTaxAmount),
      traceId,
      operationDate: new Date(invoice.issueDate),
      registeredAt: new Date(),
      _createdDate: new Date(),
    });

    // Debe: IVA soportado
    if (invoice.inputTaxAmount > 0) {
      lines.push({
        _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
        lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
        journalEntryId,
        lineNumber: lineNum++,
        accountCode: "472000",
        accountName: "Hacienda Publica IVA Soportado",
        debitAmount: _roundMoney(invoice.inputTaxAmount),
        creditAmount: 0,
        netAmount: _roundMoney(invoice.inputTaxAmount),
        lineDescription: "IVA Soportado",
        taxableAmount: _roundMoney(invoice.taxableAmount),
        taxRate: invoice.taxRate,
        taxAmount: _roundMoney(invoice.inputTaxAmount),
        traceId,
        operationDate: new Date(invoice.issueDate),
        registeredAt: new Date(),
        _createdDate: new Date(),
      });
    }

    // Haber: Caja/Banco/Proveedor
    lines.push({
      _id: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
      lineHash: `${journalEntryId}_L${String(lineNum).padStart(3, "0")}`,
      journalEntryId,
      lineNumber: lineNum++,
      accountCode: invoice.paymentDate ? "570000" : "400000",
      accountName: invoice.paymentDate ? "Caja" : "Proveedores",
      debitAmount: 0,
      creditAmount: totalCredit,
      netAmount: -totalCredit,
      lineDescription: `Pago a ${invoice.supplierName}`,
      taxableAmount: null,
      taxRate: null,
      taxAmount: null,
      traceId,
      operationDate: new Date(invoice.issueDate),
      registeredAt: new Date(),
      _createdDate: new Date(),
    });

    for (const line of lines) {
      await wixData.insert(lineasCol, line, { suppressAuth: true });
    }
  } catch (err) {
    log.error("_generateExpenseAccountingEntry failed", { traceId, error: err?.message });
  }
}

// =============================================================================
// WEBMETHOD: LISTAR FACTURAS RECIBIDAS
// =============================================================================

export const listReceivedInvoices = webMethod(Permissions.SiteMember, async (options = {}) => {
  const traceId = options?.traceId || makeTraceId("list-rec-inv");
  try {
    await requireCajero(traceId);

    const fiscalYear = Number(options?.fiscalYear);
    const fiscalPeriod = _safeTrim(options?.fiscalPeriod);
    const supplierTaxId = _safeTrim(options?.supplierTaxId);

    let query = wixData.query(COLLECTIONS.LIBRO_IVA_FACTURAS_RECIBIDAS);

    if (fiscalYear) query = query.eq("fiscalYear", fiscalYear);
    if (fiscalPeriod) query = query.eq("fiscalPeriod", fiscalPeriod);
    if (supplierTaxId) query = query.eq("supplierTaxId", supplierTaxId.toUpperCase());

    const res = await query
      .descending("receptionDate")
      .limit(Math.min(Number(options?.limit) || 50, 200))
      .find({ suppressAuth: true });

    return {
      status: "SUCCESS",
      data: {
        invoices: res?.items || [],
        total: res?.items?.length || 0,
      },
      error: null,
    };
  } catch (err) {
    return { status: "ERROR", data: null, error: _toPublicError(err, "LIST_REC_INV_FAIL") };
  }
});

// =============================================================================
// HELPERS
// =============================================================================

async function _logAuditEvent(tipoEvento, level, message, data = {}, traceId, entityId = "system") {
  try {
    const logId = `AUDIT_${_normalizeIdPart(tipoEvento, 30)}_${_normalizeIdPart(entityId, 20)}_${Date.now()}`;
    await wixData.insert(
      COLLECTIONS.MM_AUDIT_LOG,
      {
        _id: logId,
        eventType: tipoEvento,
        level,
        message,
        data,
        resourceId: "SYSTEM",
        source: "backend/facturasRecibidas.web.js",
        loggedAt: new Date(),
        traceId,
      },
      { suppressAuth: true }
    ).catch(() => null);
  } catch (err) {
    log.error("Failed to write to AUDIT_LOG", { error: err?.message, traceId });
  }
}

function normalizeError(err) {
  if (err && typeof err === "object" && err.code) {
    return { code: String(err.code), message: String(err.message || "Unknown error") };
  }
  if (err instanceof Error) {
    return { code: err.code || "UNKNOWN_ERROR", message: err.message || "Unknown error" };
  }
  return { code: "UNKNOWN_ERROR", message: String(err || "Unknown error") };
}