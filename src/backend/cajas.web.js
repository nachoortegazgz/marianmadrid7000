// ============================================================================
// FLUJO 7 — TARJETAS REGALO (FIX C1)
// DOSSIER CAJA §12 — Venta y canje de tarjetas regalo
// Tratamiento fiscal: anticipo/pasivo hasta el canje (validar con asesoria)
// ============================================================================

/**
 * Registra la venta de una tarjeta regalo.
 * Tratamiento fiscal: anticipo/pasivo hasta el canje.
 * IVA no repercutido en venta de tarjeta regalo (taxRate = 0).
 */
export const registerGiftCardSale = webMethod(Permissions.SiteMember, async (payload) => {
  const traceId = payload?.traceId || makeTraceId("gc-sale");
  try {
    await requireCajero(traceId);
    await validateFiscalConfig(traceId);
    const { fiscalKey, businessTaxId } = await _getFiscalKeys(traceId);

    const giftCardId = _safeTrim(payload?.giftCardId);
    if (!giftCardId) {
      return { status: "ERROR", data: null, error: { code: "INVALID_GIFT_CARD", message: "giftCardId requerido" } };
    }

    const amount = _readPositiveAmount(payload?.amount);
    if (!amount) {
      return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
    }

    const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
    if (!Object.values(FORMA_PAGO).includes(paymentMethod)) {
      return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
    }

    // Idempotencia por giftCardId + tipo
    const existingRes = await wixData
      .query(COLLECTIONS.MOVIMIENTOS_CAJA)
      .eq("transactionId", `GC_SALE-${giftCardId}`)
      .limit(1)
      .find({ suppressAuth: true, consistentRead: true });

    if (existingRes?.items?.length > 0) {
      return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
    }

    // IVA no repercutido en venta de tarjeta regalo (anticipo)
    const taxRate = 0;
    const taxableAmount = amount;
    const taxAmount = 0;

    const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
    await _assertPeriodNotClosed(operationDate, traceId);

    return await executeLedgerWithBackoff(async () => {
      const seq = await _getNextSequence(traceId);
      const lastMov = await _getLastMovement(traceId);
      const previousRecordHash = lastMov?.currentRecordHash || GENESIS_HASH;

      const movBase = {
        sequenceNumber: seq.sequenceNumber,
        invoiceNumber: seq.invoiceNumber,
        operationDate,
        fiscalPeriod: operationDate.slice(0, 7),
        movementType: TIPO_MOVIMIENTO.VENTA_TARJETA_REGALO,
        operationNature: "ANTICIPO",
        paymentMethod,
        totalAmount: amount,
        taxableAmount,
        taxAmount,
        taxRate,
        taxTreatment: "ANTICIPO_CLIENTE",
        accountingSign: 1,
        accountingAmount: amount,
        description: `Venta tarjeta regalo ${giftCardId}`,
        lineItems: [],
        rectifiedInvoiceReference: null,
        businessTaxId,
        schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
        recordSource: "POS",
        resourceId: _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
        reservaIdVinculada: null,
        transactionId: `GC_SALE-${giftCardId}`,
        orderId: null,
        refundId: null,
        giftCardId,
        giftCardOperation: "SALE",
        customerEmail: payload?.customerEmail || null,
      };

      const payloadStr = _buildLedgerPayload(movBase);
      const currentRecordHash = await _computeCurrentHash(previousRecordHash, payloadStr);
      const digitalSignature = await _computeSignature(fiscalKey, currentRecordHash, payloadStr);

      const movimiento = {
        ...movBase,
        previousRecordHash,
        currentRecordHash,
        digitalSignature,
        registeredAt: new Date(),
        traceId,
        _createdDate: new Date(),
      };

      const saved = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true });
      await _updateCajaActual(movimiento, traceId);
      await _registerSystemEvent(saved, traceId);

      await _logAuditEvent("GIFT_CARD_SOLD", "INFO", `Tarjeta regalo vendida: ${giftCardId}`, { giftCardId, amount, traceId }, traceId, giftCardId);

      return { status: "SUCCESS", data: saved, error: null };
    });
  } catch (err) {
    const norm = normalizeError(err);
    log.error("registerGiftCardSale failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "GC_SALE_FAIL", message: norm.message } };
  }
});

/**
 * Registra el canje de una tarjeta regalo para pagar un servicio/producto.
 * Reconoce el ingreso diferido y aplica IVA segun servicio/producto.
 */
export const registerGiftCardRedemption = webMethod(Permissions.SiteMember, async (payload) => {
  const traceId = payload?.traceId || makeTraceId("gc-redeem");
  try {
    await requireCajero(traceId);
    await validateFiscalConfig(traceId);
    const { fiscalKey, businessTaxId } = await _getFiscalKeys(traceId);

    const giftCardId = _safeTrim(payload?.giftCardId);
    if (!giftCardId) {
      return { status: "ERROR", data: null, error: { code: "INVALID_GIFT_CARD", message: "giftCardId requerido" } };
    }

    const amount = _readPositiveAmount(payload?.amount);
    if (!amount) {
      return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
    }

    const serviceId = _safeTrim(payload?.serviceId);
    const bookingId = _safeTrim(payload?.bookingId);

    // Calcular IVA segun servicio canjeado
    let taxRate = IVA_RATES.GENERAL;
    if (serviceId) {
      const serviceRes = await wixData
        .query(COLLECTIONS.SERVICIOS_CATALOGO)
        .eq("serviceId", serviceId)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(() => ({ items: [] }));

      if (serviceRes?.items?.length > 0) {
        taxRate = Number(serviceRes.items[0].taxRate) || IVA_RATES.GENERAL;
      }
    }

    const taxableAmount = _roundMoney(amount / (1 + taxRate));
    const taxAmount = _roundMoney(amount - taxableAmount);

    const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
    await _assertPeriodNotClosed(operationDate, traceId);

    const redemptionId = `GC_REDEEM-${giftCardId}-${Date.now()}`;

    return await executeLedgerWithBackoff(async () => {
      const seq = await _getNextSequence(traceId);
      const lastMov = await _getLastMovement(traceId);
      const previousRecordHash = lastMov?.currentRecordHash || GENESIS_HASH;

      const movBase = {
        sequenceNumber: seq.sequenceNumber,
        invoiceNumber: seq.invoiceNumber,
        operationDate,
        fiscalPeriod: operationDate.slice(0, 7),
        movementType: TIPO_MOVIMIENTO.CANJE_TARJETA_REGALO,
        operationNature: "APLICACION_ANTICIPO",
        paymentMethod: FORMA_PAGO.TARJETA_REGALO,
        totalAmount: amount,
        taxableAmount,
        taxAmount,
        taxRate,
        taxTreatment: "IVA_GENERAL",
        accountingSign: 1,
        accountingAmount: amount,
        description: `Canje tarjeta regalo ${giftCardId}${serviceId ? ` - servicio ${serviceId}` : ""}`,
        lineItems: [],
        rectifiedInvoiceReference: null,
        businessTaxId,
        schemaIntegrityVersion: LEDGER_SCHEMA_VERSION,
        recordSource: "POS",
        resourceId: _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
        reservaIdVinculada: bookingId ? _linkedBookingValue([bookingId]) : null,
        transactionId: redemptionId,
        orderId: null,
        refundId: null,
        giftCardId,
        giftCardOperation: "REDEMPTION",
        serviceIdRedeemed: serviceId || null,
      };

      const payloadStr = _buildLedgerPayload(movBase);
      const currentRecordHash = await _computeCurrentHash(previousRecordHash, payloadStr);
      const digitalSignature = await _computeSignature(fiscalKey, currentRecordHash, payloadStr);

      const movimiento = {
        ...movBase,
        previousRecordHash,
        currentRecordHash,
        digitalSignature,
        registeredAt: new Date(),
        traceId,
        _createdDate: new Date(),
      };

      const saved = await wixData.insert(COLLECTIONS.MOVIMIENTOS_CAJA, movimiento, { suppressAuth: true });
      await _updateCajaActual(movimiento, traceId);
      await _registerSystemEvent(saved, traceId);

      await _logAuditEvent("GIFT_CARD_REDEEMED", "INFO", `Tarjeta regalo canjeada: ${giftCardId}`, { giftCardId, amount, serviceId, traceId }, traceId, giftCardId);

      return { status: "SUCCESS", data: saved, error: null };
    });
  } catch (err) {
    const norm = normalizeError(err);
    log.error("registerGiftCardRedemption failed", { code: norm.code, error: norm.message, traceId });
    return { status: "ERROR", data: null, error: { code: norm.code || "GC_REDEEM_FAIL", message: norm.message } };
  }
});