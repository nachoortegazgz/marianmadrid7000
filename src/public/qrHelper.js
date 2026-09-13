/*
=============================================================================
MODULE: public/qrHelper.js
VERSION: v5007.3-FINAL
=============================================================================
*/
export const AEAT_VERIFACTU_ENDPOINTS = Object.freeze({
  VERIFICATION_BASE_URL: "https://sede.agenciatributaria.gob.es/verifactu",
  DEV_ENVIRONMENT: false,
});

function _formatDateToAeatDdMmYyyy(dateValue) {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function _escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function generateVerifactuQrUrl(params = {}) {
  const nifEmisor = String(params.nifEmisor || params.businessTaxId || "").trim();
  const numFactura = String(params.numFactura || params.invoiceNumber || "").trim();
  const fechaEmision = String(params.fechaEmision || "").trim();
  const qrImporteTotal = String(params.qrImporteTotal || params.totalAmount || "0").trim();
  const hashCadena = String(params.hashCadena || params.currentRecordHash || "").trim();
  if (!nifEmisor || !numFactura || !fechaEmision) return null;
  const baseUrl = AEAT_VERIFACTU_ENDPOINTS.VERIFICATION_BASE_URL;
  return `${baseUrl}?nif=${encodeURIComponent(nifEmisor)}&numFactura=${encodeURIComponent(numFactura)}&fecha=${encodeURIComponent(fechaEmision)}&importe=${encodeURIComponent(qrImporteTotal)}&hash=${encodeURIComponent(hashCadena)}`;
}

export function extractVerifactuData(movimiento = {}, options = {}) {
  return {
    nifEmisor: String(movimiento.nifEmisor || movimiento.businessTaxId || options.businessTaxId || "").trim(),
    numTicketFactura: String(movimiento.numTicketFactura || movimiento.invoiceNumber || "").trim(),
    fechaEmision: String(movimiento.fechaEmision || "").trim() || _formatDateToAeatDdMmYyyy(movimiento.registeredAt),
    qrImporteTotal: String(movimiento.qrImporteTotal || movimiento.totalAmount || "0").trim(),
    hashCadena: String(movimiento.hashCadena || movimiento.currentRecordHash || "").trim(),
    firmaDigital: String(movimiento.firmaDigital || movimiento.digitalSignature || "").trim(),
    qrUrl: generateVerifactuQrUrl(movimiento),
  };
}

export function buildVerifactuReceiptHtml(movimiento = {}, options = {}) {
  const data = extractVerifactuData(movimiento, options);
  if (!data.qrUrl) return "";
  return `<div style="font-family:Arial,sans-serif;padding:16px;border:1px solid #ccc;border-radius:8px;"><h3 style="margin:0 0 12px;">Factura Simplificada</h3><p><strong>NIF Emisor:</strong> ${_escapeHtml(data.nifEmisor)}</p><p><strong>Numero:</strong> ${_escapeHtml(data.numTicketFactura)}</p><p><strong>Fecha:</strong> ${_escapeHtml(data.fechaEmision)}</p><p><strong>Importe:</strong> ${_escapeHtml(data.qrImporteTotal)} EUR</p><p><strong>Verificacion:</strong> <a href="${data.qrUrl}" target="_blank">Verificar factura</a></p><p style="font-size:10px;color:#666;">Hash: ${_escapeHtml(data.hashCadena.substring(0, 16))}...</p></div>`;
}