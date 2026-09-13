/*
=============================================================================
MODULE: backend/data.js
VERSION: v5005-5
RESPONSIBILITY: CMS data hooks and validation rules.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/

import { getMadridLocalStringNoZ } from "public/mmUtils";

import {
    SINGLETONS,
    TIPO_FICHAJE,
    CITA_FIELDS,
    ESTADO_CITA,
    ESTADO_PAGO,
    SERVICE_CATALOG
} from "backend/internalConfig";

import { findStaff } from "backend/staff";

const CAJA_ACTUAL_SINGLETON_ID =
    SINGLETONS?.CAJA || "CAJA_PRINCIPAL";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

const GUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SERVICE_STATES = new Set(
    SERVICE_CATALOG?.STATES || [
        "ACTIVO",
        "INACTIVO",
        "BORRADOR"
    ]
);

const PAYMENT_STATES = new Set(
    Object.values(ESTADO_PAGO || {})
);

function isObject(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}

function isSuppressed(context) {
    return context?.suppressHooks === true;
}

function toDate(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ?
        value :
        new Date(value);

    return Number.isNaN(date.getTime()) ?
        null :
        date;
}

function normalizeDateField(item, field, fallback = null) {
    const parsed = toDate(item[field]);
    item[field] = parsed || fallback;
}

function normalizeBoundedText(item, field, maxLength) {
    if (
        item[field] === undefined ||
        item[field] === null
    ) {
        return;
    }

    const text = String(item[field]).trim();

    if (text.length > maxLength) {
        throw new Error(
            `SERVICE_VALIDATION: ${field} exceeds the permitted length.`
        );
    }

    item[field] = text;
}

function normalizeCatalogReference(value) {
    const candidate = value &&
        typeof value === "object" ?
        (
            value.categoryName ||
            value._id ||
            value.id
        ) :
        value;

    return String(candidate || "")
        .trim()
        .toUpperCase();
}

function readDuration(item, field) {
    const raw = item[field];

    if (
        raw === undefined ||
        raw === null ||
        raw === ""
    ) {
        return 0;
    }

    const value = Number(raw);
    const maxDuration =
        SERVICE_CATALOG?.MAX_DURATION_MINUTES || 1440;

    if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > maxDuration
    ) {
        throw new Error(
            `SERVICE_VALIDATION: ${field} must be between 0 and ${maxDuration}.`
        );
    }

    return value;
}

function validateServiciosCatalogo(item, context) {
    if (
        !isObject(item) ||
        isSuppressed(context)
    ) {
        return item;
    }

    normalizeBoundedText(
        item,
        "title",
        SERVICE_CATALOG?.MAX_TITLE_LENGTH || 160
    );

    normalizeBoundedText(
        item,
        "tagLine",
        SERVICE_CATALOG?.MAX_SUMMARY_LENGTH || 120
    );

    normalizeBoundedText(
        item,
        "description",
        SERVICE_CATALOG?.MAX_DESCRIPTION_LENGTH || 6000
    );

    const status = normalizeCatalogReference(
        item.status
    );

    if (status) {
        if (!SERVICE_STATES.has(status)) {
            throw new Error(
                "SERVICE_VALIDATION: status is not valid."
            );
        }

        item.status = status;
    }

    const category = normalizeCatalogReference(
        item.categoryName
    );

    if (category) {
        item.categoryName = category;
    }

    const currency = normalizeCatalogReference(
        item.currency
    );

    if (
        currency &&
        currency !== (
            SERVICE_CATALOG?.CURRENCY || "EUR"
        )
    ) {
        throw new Error(
            "SERVICE_VALIDATION: only EUR is supported."
        );
    }

    if (
        item.price !== undefined &&
        item.price !== null &&
        item.price !== ""
    ) {
        const price = Number(item.price);

        if (
            !Number.isFinite(price) ||
            price < 0
        ) {
            throw new Error(
                "SERVICE_VALIDATION: price must be non-negative."
            );
        }

        item.price = Math.round(
            (price + Number.EPSILON) * 100
        ) / 100;
    }

    const phase1Duration = readDuration(
        item,
        "phase1Duration"
    );

    const exposureDuration = readDuration(
        item,
        "exposureDuration"
    );

    const phase2Duration = readDuration(
        item,
        "phase2Duration"
    );

    item.phase1Duration = phase1Duration;
    item.exposureDuration = exposureDuration;
    item.phase2Duration = phase2Duration;

    const calculatedTotal =
        phase1Duration +
        exposureDuration +
        phase2Duration;

    if (calculatedTotal > 0) {
        item.totalDuration = calculatedTotal;
    } else {
        const currentTotal = Number(item.totalDuration);

        item.totalDuration =
            Number.isFinite(currentTotal) &&
            currentTotal > 0 ?
            currentTotal :
            30;
    }

    const totalDuration = Number(item.totalDuration);

    if (
        !Number.isFinite(totalDuration) ||
        totalDuration <= 0 ||
        totalDuration >
        (SERVICE_CATALOG?.MAX_DURATION_MINUTES || 1440)
    ) {
        throw new Error(
            "SERVICE_VALIDATION: totalDuration is invalid."
        );
    }

    /*
     * If no phase has been configured, totalDuration is accepted
     * as the standalone service duration.
     */
    if (calculatedTotal > 0) {
        const difference = Math.abs(
            calculatedTotal - totalDuration
        );

        if (difference > 0.01) {
            throw new Error(
                "SERVICE_VALIDATION: phase durations must equal totalDuration."
            );
        }
    }

    item.totalDuration = totalDuration;

    return item;
}

export function ServiciosCatalogo_beforeInsert(
    item,
    context
) {
    return validateServiciosCatalogo(item, context);
}

export function ServiciosCatalogo_beforeUpdate(
    item,
    context
) {
    return validateServiciosCatalogo(item, context);
}

function validateMapaStaff(item, context) {
    if (
        !isObject(item) ||
        isSuppressed(context)
    ) {
        return item;
    }

    const resourceId = String(
        item.resourceId || ""
    ).trim();

    if (!GUID_RE.test(resourceId)) {
        throw new Error(
            "STAFF_VALIDATION: resourceId must be a valid GUID."
        );
    }

    item.resourceId = resourceId;

    normalizeBoundedText(
        item,
        "displayName",
        80
    );

    if (!item.displayName) {
        throw new Error(
            "STAFF_VALIDATION: displayName is required."
        );
    }

    normalizeBoundedText(
        item,
        "staffMemberId",
        120
    );

    normalizeBoundedText(
        item,
        "email",
        254
    );

    normalizeBoundedText(
        item,
        "scheduleId",
        120
    );

    normalizeBoundedText(
        item,
        "rol",
        60
    );

    if (item.email) {
        item.email = item.email
            .trim()
            .toLowerCase();
    }

    if (!item.staffMemberId) {
        throw new Error(
            "STAFF_VALIDATION: staffMemberId is required."
        );
    }

    item.active = item.active !== false;
    item.updatedAt = new Date();

    return item;
}

export function MapaStaff_beforeInsert(
    item,
    context
) {
    return validateMapaStaff(item, context);
}

export function MapaStaff_beforeUpdate(
    item,
    context
) {
    return validateMapaStaff(item, context);
}

function normalizeBookingStatus(item) {
    const status = String(
        item[CITA_FIELDS.STATUS] ||
        ESTADO_CITA.CONFIRMED
    ).trim().toUpperCase();

    const paymentStatus = String(
        item[CITA_FIELDS.STATUS_PAGO] ||
        ESTADO_PAGO.UNPAID ||
        "UNPAID"
    ).trim().toUpperCase();

    item[CITA_FIELDS.STATUS] = status;
    item[CITA_FIELDS.STATUS_PAGO] = paymentStatus;

    return {
        status,
        paymentStatus
    };
}

function validateBookingStatus(item) {
    const values = normalizeBookingStatus(item);

    if (
        !Object.values(ESTADO_CITA).includes(
            values.status
        )
    ) {
        throw new Error(
            "CITAS_VIOLATION: Invalid booking status."
        );
    }

    if (
        PAYMENT_STATES.size > 0 &&
        !PAYMENT_STATES.has(values.paymentStatus)
    ) {
        throw new Error(
            "CITAS_VIOLATION: Invalid payment status."
        );
    }
}

function validateCita(item, context, isInsert) {
    if (
        !isObject(item) ||
        isSuppressed(context)
    ) {
        return item;
    }

    const bookingId = String(
        item.bookingId || ""
    ).trim();

    if (!bookingId) {
        throw new Error(
            "CITAS_VIOLATION: Missing bookingId."
        );
    }

    item.bookingId = bookingId;

    const now = new Date();

    normalizeDateField(
        item,
        "startDate",
        null
    );

    normalizeDateField(
        item,
        "endDate",
        null
    );

    if (isInsert) {
        normalizeDateField(
            item,
            "registeredAt",
            now
        );

        normalizeDateField(
            item,
            "version",
            null
        );

        if (
            !Number.isInteger(
                Number(item.version)
            ) ||
            Number(item.version) < 1
        ) {
            item.version = 1;
        }
    } else {
        normalizeDateField(
            item,
            "updatedAt",
            now
        );

        if (
            item.version !== undefined &&
            item.version !== null
        ) {
            const version = Number(item.version);

            if (
                !Number.isInteger(version) ||
                version < 1
            ) {
                throw new Error(
                    "CITAS_VIOLATION: Invalid version."
                );
            }

            item.version = version;
        }
    }

    if (
        item.startDate &&
        item.endDate &&
        item.endDate <= item.startDate
    ) {
        throw new Error(
            "CITAS_VIOLATION: endDate must be after startDate."
        );
    }

    if (
        !item.dateYmd &&
        item.startDate
    ) {
        item.dateYmd = getMadridLocalStringNoZ(
            item.startDate
        ).slice(0, 10);
    }

    validateBookingStatus(item);

    return item;
}

export function CitasF2_beforeInsert(
    item,
    context
) {
    return validateCita(
        item,
        context,
        true
    );
}

export function CitasF2_beforeUpdate(
    item,
    context
) {
    return validateCita(
        item,
        context,
        false
    );
}

function validateSha256(value) {
    return SHA256_HEX_RE.test(
        String(value || "").trim()
    );
}

export function MovimientosCaja_beforeInsert(
    item,
    context
) {
    if (
        !isObject(item) ||
        isSuppressed(context)
    ) {
        return item;
    }

    if (
        !validateSha256(
            item.currentRecordHash
        )
    ) {
        throw new Error(
            "FISCAL_VIOLATION: Invalid currentRecordHash."
        );
    }

    if (
        !validateSha256(
            item.previousRecordHash
        )
    ) {
        throw new Error(
            "FISCAL_VIOLATION: Invalid previousRecordHash."
        );
    }

    const signatureParts = String(
        item.digitalSignature || ""
    ).trim().split("|");

    if (
        signatureParts.length !== 2 ||
        !validateSha256(signatureParts[0]) ||
        !validateSha256(signatureParts[1])
    ) {
        throw new Error(
            "FISCAL_VIOLATION: Invalid digitalSignature."
        );
    }

    if (!String(item.invoiceNumber || "").trim()) {
        throw new Error(
            "FISCAL_VIOLATION: Missing invoiceNumber."
        );
    }

    normalizeDateField(
        item,
        "registeredAt",
        new Date()
    );

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    throw new Error(
        "FISCAL_VIOLATION: Direct updates are forbidden."
    );
}

export function MovimientosCaja_beforeRemove() {
    throw new Error(
        "FISCAL_VIOLATION: Direct removals are forbidden."
    );
}

export async function RegistrosHorariosStaff_beforeInsert(
    item,
    context
) {
    if (
        !isObject(item) ||
        isSuppressed(context)
    ) {
        return item;
    }

    const resourceId = String(
        item.resourceId || ""
    ).trim();

    if (!GUID_RE.test(resourceId)) {
        throw new Error(
            "INVALID_EMPLOYEE: Invalid resourceId."
        );
    }

    const staff = await findStaff(resourceId);

    if (!staff) {
        throw new Error(
            "INVALID_EMPLOYEE: Employee is not registered."
        );
    }

    const clockEventType = String(
        item.clockEventType || ""
    ).trim().toUpperCase();

    if (
        !Object.values(TIPO_FICHAJE)
        .includes(clockEventType)
    ) {
        throw new Error(
            `INVALID_CLOCK_TYPE: Invalid type "${clockEventType}".`
        );
    }

    if (
        clockEventType === TIPO_FICHAJE.AJUSTE &&
        !String(item.adjustmentReason || "").trim()
    ) {
        throw new Error(
            "INVALID_CLOCK_ADJUSTMENT: Reason is required."
        );
    }

    const now = new Date();
    const recordedAt =
        toDate(item.recordedAt) || now;

    if (
        recordedAt.getTime() >
        now.getTime() + 60000
    ) {
        throw new Error(
            "INVALID_TIMESTAMP: Future timestamps are forbidden."
        );
    }

    const madrid = getMadridLocalStringNoZ(
        recordedAt
    );

    item.resourceId = staff.resourceId;
    item.displayName = staff.displayName;
    item.clockEventType = clockEventType;
    item.recordedAt = recordedAt;
    item.recordedTime = madrid.slice(11, 19);
    item.dayKey = madrid.slice(0, 10);
    item.monthKey = madrid.slice(0, 7);

    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    throw new Error(
        "LABOR_LOG_VIOLATION: Direct updates are forbidden."
    );
}

export function RegistrosHorariosStaff_beforeRemove() {
    throw new Error(
        "LABOR_LOG_VIOLATION: Direct removals are forbidden."
    );
}

export function HistoricoCierresZ_beforeUpdate() {
    throw new Error(
        "FISCAL_VIOLATION: Direct updates are forbidden."
    );
}

export function HistoricoCierresZ_beforeRemove() {
    throw new Error(
        "FISCAL_VIOLATION: Direct removals are forbidden."
    );
}

export function EventosSistemaFacturacion_beforeUpdate() {
    throw new Error(
        "SIF_VIOLATION: Direct updates are forbidden."
    );
}

export function EventosSistemaFacturacion_beforeRemove() {
    throw new Error(
        "SIF_VIOLATION: Direct removals are forbidden."
    );
}

export function CajaActual_beforeInsert(item) {
    if (isObject(item)) {
        item._id = CAJA_ACTUAL_SINGLETON_ID;
    }

    return item;
}

export function CajaActual_beforeUpdate(item) {
    if (isObject(item)) {
        item._id = CAJA_ACTUAL_SINGLETON_ID;
    }

    return item;
}

export function CajaActual_beforeRemove() {
    throw new Error(
        "SINGLETON_PROTECTED: Direct deletion is forbidden."
    );
}