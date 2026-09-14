/*
=============================================================================
MODULE: backend/contabilidad.js
VERSION: v5007.3-FINAL
BASE: BIBLIA v5002.5 Bloque 12 + DOSSIER CAJA Flujos 11-17
RESPONSIBILITY: Proyeccion contable de movimientos de caja, asientos en
                partida doble, libro mayor y conciliacion contable.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
CORRECTIONS APPLIED:
  [CONT-01] hashOrigen anadido en _buildBase.
  [CONT-02] await en hashChain y hmacSha256Hex.
=============================================================================
*/

import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";
import { COLLECTIONS, SDK_CONFIG, TIPO_MOVIMIENTO, IVA_RATES } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { hmacSha256Hex, hashChain, hashSHA256 } from "backend/securityEngine";
import { _roundMoney, _cleanText, makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;
const MONEY_EPSILON = 0.005;

// =============================================================================
// HELPERS INTERNOS
// =============================================================================

function _normalizeDate(value) {
  const parsed = value instanceof Date ? value : new Date(value || Date.now());
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function _toFiscalKeys(date) {
  const local = date.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
  return {
    diaKey: local.slice(0, 10),
    fiscalYear: Number(local.slice(0, 4)),
    fiscalPeriod: local.slice(5, 7),
  };
}

function _linePayload(line) {
  return [
    line.lineHash,
    line.journalEntryId,
    line.lineNumber,
    line.accountCode,
    line.debitAmount,
    line.creditAmount,
    line.taxableAmount,
    line.taxRate,
    line.taxAmount,
    line.traceId,
  ].join("|");
}

// =============================================================================
// CONSTRUCCION DE LINEAS DE ASIENTO
// =============================================================================

function _asAccountingLine(base, number, accountCode, accountName, debit, credit, tax) {
  const line = {
    _id: `${base.journalEntryId}_L${String(number).padStart(3, "0")}`,
    lineHash: `${base.journalEntryId}_L${String(number).padStart(3, "0")}`,
    journalEntryId: base.journalEntryId,
    lineNumber: number,
    operationDate: base.operationDate,
    accountCode: accountCode,
    accountName: accountName,
    accountGroup: "",
    debitAmount: _roundMoney(debit),
    creditAmount: _roundMoney(credit),
    netAmount: _roundMoney(debit - credit),
    operationCategory: base.operationCategory,
    costCenterId: base.costCenterId || null,
    operationalResponsibleId: base.operationalResponsibleId || null,
    productServiceCode: null,
    lineDescription: base.conceptoAsiento,
    taxableAmount: tax?.taxableAmount ?? null,
    taxRate: tax?.taxRate ?? null,
    taxAmount: tax?.taxAmount ?? null,
    vatOperationKey: null,
    counterpartNif: null,
    counterpartName: null,
    externalReference: base.externalReference || null,
    traceId: base.traceId,
    registeredAt: base.registeredAt,
  };
  // [CONT-02] await en hashChain
  line.lineHash = hashChain(base.hashOrigen, _linePayload(line));
  return line;
}

// =============================================================================
// BUSQUEDA DE CUENTAS CONTABLES
// =============================================================================

function _isApprovedMap(map) {
  return Boolean(map?.activa) && Boolean(map?.validadaPorGestoria) &&
    _cleanText(map?.codigoCuentaDebePredeterminada, 40) &&
    _cleanText(map?.nombreCuentaDebePredeterminada, 120) &&
    _cleanText(map?.codigoCuentaHaberPredeterminada, 40) &&
    _cleanText(map?.nombreCuentaHaberPredeterminada, 120);
}

async function _findAccountMap(tipoMovimiento) {
  const result = await wixData
    .query(COLLECTIONS.PLAN_CUENTAS_CONTABLES)
    .eq("categoriaOperacion", String(tipoMovimiento || "").toUpperCase())
    .eq("activa", true)
    .limit(1)
    .find({ suppressAuth: true });
  return result?.items?.[0] || null;
}

// =============================================================================
// IDEMPOTENCIA Y LECTURA
// =============================================================================

async function _getExisting(id) {
  return await wixData
    .get(COLLECTIONS.ASIENTOS_CONTABLES, id, { suppressAuth: true, consistentRead: true })
    .catch(() => null);
}

async function _insertLineIfMissing(line) {
  const existing = await wixData
    .get(COLLECTIONS.LINEAS_ASIENTO_CONTABLE, line._id, { suppressAuth: true, consistentRead: true })
    .catch(() => null);
  if (existing) return { idempotent: true };
  await wixData.insert(COLLECTIONS.LINEAS_ASIENTO_CONTABLE, line, { suppressAuth: true });
  return { idempotent: false };
}

// =============================================================================
// CONSTRUCCION DE BASE DE ASIENTO
// [CONT-01] hashOrigen anadido
// =============================================================================

function _buildBase(movimiento) {
  const operationDate = _normalizeDate(movimiento?.registeredAt);
  const keys = _toFiscalKeys(operationDate);
  const journalEntryId = `ASIENTO_${_cleanText(movimiento?._id, 120)}`;
  return {
    journalEntryId,
    sequenceNumber: Number(movimiento?.sequenceNumber || 0),
    fiscalYear: keys.fiscalYear,
    fiscalPeriod: keys.fiscalPeriod,
    operationDate,
    registeredAt: new Date(),
    timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
    entryType: String(movimiento?.movementType || "AJUSTE").toUpperCase(),
    operationCategory: String(movimiento?.movementType || "AJUSTE").toUpperCase(),
    operationSubcategory: null,
    description: _cleanText(movimiento?.concepto || movimiento?.movementType || "Movimiento de caja"),
    recordSource: _cleanText(movimiento?.origen || "MOVIMIENTO_CAJA", 80),
    sourceId: _cleanText(movimiento?._id, 120),
    transactionId: _cleanText(movimiento?.transactionId, 120),
    wixOrderId: _cleanText(movimiento?.orderId, 120) || null,
    wixRefundId: _cleanText(movimiento?.refundId, 120) || null,
    wixBookingId: _cleanText(movimiento?.reservaIdVinculada, 120) || null,
    externalReference: _cleanText(movimiento?.numTicketFactura, 120) || null,
    invoiceSeries: null,
    invoiceNumber: _cleanText(movimiento?.numTicketFactura, 120) || null,
    invoiceIssueDate: operationDate,
    fiscalOperationDate: operationDate,
    invoiceType: null,
    rectifiedEntryId: null,
    rectificationReason: null,
    currency: "EUR",
    totalDocumentAmount: Math.abs(Number(movimiento?.accountingAmount) || 0),
    paymentMethod: _cleanText(movimiento?.paymentMethod, 40) || null,
    entryStatus: "CONFIRMADO",
    operationalResponsibleId: _cleanText(movimiento?.resourceId, 120) || null,
    recordingMemberId: "SYSTEM_FISCAL_LEDGER",
    recorderName: "SISTEMA_FISCAL",
    costCenterId: null,
    iaeActivityCode: null,
    schemaVersion: "ASIENTO_V1",
    integrityAlgorithmVersion: "HMAC_SHA256_V1",
    previousHash: _cleanText(movimiento?.hashCadena, 64),
    sourceHash: _cleanText(movimiento?.hashCadena, 64),
    // [CONT-01] hashOrigen anadido
    hashOrigen: _cleanText(movimiento?.hashCadena, 64),
    traceId: _cleanText(movimiento?.traceId, 120),
  };
}

// =============================================================================
// CONSTRUCCION DE LINEAS DE ASIENTO
// =============================================================================

function _buildLines(base, movimiento, map) {
  const signedTotal = Number(movimiento?.accountingAmount) || 0;
  const total = Math.abs(signedTotal);
  const vat = Math.abs(Number(movimiento?.cuotaIva) || 0);
  const net = _roundMoney(total - vat);
  const rate = Number(movimiento?.tasaIva);
  const baseTax = {
    baseImponible: Math.abs(Number(movimiento?.baseImponible) || 0),
    tipoIva: Number.isFinite(rate) ? rate : null,
    cuotaIva: vat || null,
  };
  if (total <= MONEY_EPSILON || net < -MONEY_EPSILON || vat > total + MONEY_EPSILON) {
    throw new Error("ACCOUNTING_PROJECTION_INVALID_AMOUNT");
  }
  const lines = [];
  const isRefund = signedTotal < 0;
  const requiresVatLine = vat > MONEY_EPSILON;
  const vatCode = _cleanText(map?.codigoCuentaIvaRepercutido, 40);
  const vatName = _cleanText(map?.nombreCuentaIvaRepercutido, 120);
  if (requiresVatLine && (!vatCode || !vatName)) {
    throw new Error("ACCOUNTING_PROJECTION_MISSING_VAT_ACCOUNT");
  }
  if (!isRefund) {
    // Linea 1: Caja/Banco (Debe)
    lines.push(_asAccountingLine(base, 1, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, total, 0, null));
    // Linea 2: Ingresos (Haber)
    lines.push(_asAccountingLine(base, 2, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, 0, net, baseTax));
    // Linea 3: IVA (Haber)
    if (requiresVatLine) {
      lines.push(_asAccountingLine(base, 3, vatCode, vatName, 0, vat, baseTax));
    }
  } else {
    // Devolucion: invertir asientos
    lines.push(_asAccountingLine(base, 1, map.codigoCuentaHaberPredeterminada, map.nombreCuentaHaberPredeterminada, net, 0, baseTax));
    if (requiresVatLine) {
      lines.push(_asAccountingLine(base, 2, vatCode, vatName, vat, 0, baseTax));
    }
    lines.push(_asAccountingLine(base, requiresVatLine ? 3 : 2, map.codigoCuentaDebePredeterminada, map.nombreCuentaDebePredeterminada, 0, total, null));
  }
  // Verificar equilibrio debe/haber
  const totalDebe = _roundMoney(lines.reduce((sum, line) => sum + Number(line.debitAmount || 0), 0));
  const totalHaber = _roundMoney(lines.reduce((sum, line) => sum + Number(line.creditAmount || 0), 0));
  if (Math.abs(totalDebe - totalHaber) > MONEY_EPSILON) {
    throw new Error("ACCOUNTING_PROJECTION_UNBALANCED");
  }
  return { lines, totalDebe, totalHaber };
}

// =============================================================================
// FUNCION PRINCIPAL: PROYECCION CONTABLE
// =============================================================================

/**
 * Proyecta un movimiento de caja a asiento contable en partida doble.
 * Idempotente por journalEntryId.
 */
export async function projectLedgerMovementToAccounting(movimiento) {
  const traceId = makeTraceId("contabilidad");
  const sourceId = _cleanText(movimiento?._id, 120);
  if (!sourceId || !movimiento?.hashCadena || !movimiento?.transactionId) {
    return { status: "SKIPPED", reason: "INVALID_SOURCE_LEDGER" };
  }
  if (movimiento?.movementType === TIPO_MOVIMIENTO.PROPINA || movimiento?.taxTreatment === "PROPINA_PENDIENTE_GESTORIA") {
    return { status: "SKIPPED", reason: "TIP_TREATMENT_PENDING_PROFESSIONAL_REVIEW" };
  }
  if (SDK_CONFIG?.ACCOUNTING?.ENABLED !== true) {
    return { status: "SKIPPED", reason: "ACCOUNTING_DISABLED" };
  }
  const base = _buildBase(movimiento);
  const existing = await _getExisting(base.journalEntryId);
  if (existing) return { status: "SUCCESS", idempotent: true, idAsiento: base.journalEntryId };
  const map = await _findAccountMap(base.categoriaOperacion);
  if (!_isApprovedMap(map)) {
    return { status: "SKIPPED", reason: "NO_APPROVED_ACCOUNT_MAP" };
  }
  const projected = _buildLines(base, movimiento, map);
  for (const line of projected.lines) {
    await _insertLineIfMissing(line);
  }
  const fiscalKey = await getSecret(SECRETS.FISCAL_KEY);
  if (!fiscalKey) throw new Error("ACCOUNTING_PROJECTION_SIGNING_KEY_MISSING");
  // [CONT-02] await en hashChain y hmacSha256Hex
  const headerPayload = [
    base.journalEntryId,
    base.sequenceNumber,
    base.sourceId,
    base.transactionId,
    projected.totalDebe,
    projected.totalHaber,
    ...projected.lines.map((line) => line.lineHash),
  ].join("|");
  const hashAsiento = await hashChain(base.hashOrigen, headerPayload);
  const firmaAsiento = `${await hmacSha256Hex(fiscalKey, headerPayload)}|${hashAsiento}`;
  const header = {
    ...base,
    totalDebe: projected.totalDebe,
    totalHaber: projected.totalHaber,
    hashAsiento,
    firmaAsiento,
  };
  delete header.hashOrigen;
  await wixData.insert(COLLECTIONS.ASIENTOS_CONTABLES, header, { suppressAuth: true });
  return { status: "SUCCESS", idempotent: false, idAsiento: base.journalEntryId, lineCount: projected.lines.length };
}

/**
 * Verifica si un error es de proyeccion contable.
 */
export function isAccountingProjectionError(error) {
  return String(error?.message || error || "").startsWith("ACCOUNTING_PROJECTION_");
}