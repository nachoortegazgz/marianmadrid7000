/*
=============================================================================
MODULE: backend/responseUtils.js
VERSION: v5005-3
RESPONSIBILITY: Centralized response standardization, AppError class,
and webMethod error handling helpers.
STANDARDS: G10 ASCII Strict.
=============================================================================
*/

import {
    _cloneDeep,
    _safeTrim
} from "public/mmUtils";

const MAX_ERROR_MESSAGE_LENGTH = 500;

function isPlainObject(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Error);
}

function normalizeCode(value, fallback = "INTERNAL_ERROR") {
    const code = _safeTrim(value);

    if (!code) {
        return fallback;
    }

    return code
        .replace(/[^A-Za-z0-9_.-]/g, "_")
        .slice(0, 100) || fallback;
}

function normalizeMessage(value, fallback = "Error interno") {
    let message = value;

    if (message instanceof Error) {
        message = message.message;
    }

    message = _safeTrim(message);

    if (!message) {
        message = fallback;
    }

    if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
        return `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
    }

    return message;
}

function cloneMeta(value) {
    if (!isPlainObject(value)) {
        return {};
    }

    try {
        return _cloneDeep(value);
    } catch (error) {
        return {
            metaSerializationError: true
        };
    }
}

export class AppError extends Error {
    constructor(
        code = "INTERNAL_ERROR",
        message = "Error interno",
        meta = {}
    ) {
        super(normalizeMessage(message));
        this.name = "AppError";
        this.code = normalizeCode(code);
        this.meta = isPlainObject(meta) ?
            cloneMeta(meta) :
            {
                details: normalizeMessage(meta, "")
            };

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }
}

export function successResponse(data = null, metaExtra = {}) {
    return {
        status: "SUCCESS",
        meta: {
            timestamp: new Date().toISOString(),
            ...cloneMeta(metaExtra)
        },
        data,
        error: null
    };
}

export function errorResponse(
    code = "INTERNAL_ERROR",
    message = "Error inesperado",
    metaExtra = {}
) {
    let finalCode = code;
    let finalMessage = message;
    let finalMeta = metaExtra;

    if (code instanceof Error) {
        finalCode = code.code || code.name;
        finalMessage = code.message;

        if (isPlainObject(code.meta)) {
            finalMeta = {
                ...code.meta,
                ...cloneMeta(metaExtra)
            };
        }
    } else if (isPlainObject(code)) {
        finalCode = code.code ||
            code.name ||
            "UNKNOWN_ERROR";

        finalMessage = code.message ||
            code.error ||
            code.reason ||
            "Error inesperado";

        finalMeta = {
            ...(isPlainObject(code.meta) ? code.meta : {}),
            ...cloneMeta(metaExtra)
        };
    } else if (
        typeof code === "string" &&
        (message === undefined || message === null)
    ) {
        finalCode = "UNKNOWN_ERROR";
        finalMessage = code;
    }

    return {
        status: "ERROR",
        meta: {
            timestamp: new Date().toISOString(),
            ...cloneMeta(finalMeta)
        },
        data: null,
        error: {
            code: normalizeCode(finalCode, "UNKNOWN_ERROR"),
            message: normalizeMessage(
                finalMessage,
                "Error no especificado"
            )
        }
    };
}

export function _toPublicError(
    error,
    fallbackCode = "INTERNAL_ERROR",
    fallbackMessage = "Error interno"
) {
    const source = error instanceof Error ?
        error :
        error && typeof error === "object" ?
        error :
        null;

    const code = source && source.code ?
        source.code :
        fallbackCode;

    const message = source && source.message ?
        source.message :
        fallbackMessage;

    return {
        code: normalizeCode(code, fallbackCode),
        message: normalizeMessage(message, fallbackMessage)
    };
}

export function toWebMethodResult(actionFn) {
    if (typeof actionFn !== "function") {
        throw new TypeError("WEB_METHOD_ACTION_REQUIRED");
    }

    return async (...args) => {
        try {
            const result = await actionFn(...args);

            if (
                result &&
                typeof result === "object" &&
                typeof result.status === "string"
            ) {
                return result;
            }

            return successResponse(result);
        } catch (error) {
            const publicError = _toPublicError(
                error,
                "OPERATION_FAILED",
                "No se pudo procesar la solicitud."
            );

            return errorResponse(
                publicError.code,
                publicError.message
            );
        }
    };
}

export function isSuccess(response) {
    if (!response) {
        return false;
    }

    if (response === true) {
        return true;
    }

    const rawStatus =
        response.status ??
        response.payload?.status ??
        response.data?.status;

    if (typeof rawStatus === "string") {
        const normalized = rawStatus
            .trim()
            .toUpperCase();

        if (
            normalized === "SUCCESS" ||
            normalized === "OK"
        ) {
            return true;
        }

        if (normalized === "ERROR" ||
            normalized === "FAILED") {
            return false;
        }
    }

    if (
        rawStatus === 200 ||
        response.success === true
    ) {
        return true;
    }

    return false;
}