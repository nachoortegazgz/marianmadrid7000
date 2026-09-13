/*
=============================================================================
MODULE: backend/securityEngine.js
VERSION: v5005-6
RESPONSIBILITY: Cryptographic engine for fiscal hash chains and JWT authentication.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
=============================================================================
*/

import {
    createHash,
    createHmac,
    timingSafeEqual as nodeTimingSafeEqual
} from "wix-crypto";

import { getSecret } from "wix-secrets-backend";
import { SECRETS } from "backend/mmSecrets";
import {
    makeTraceId,
    _safeTrim
} from "public/mmUtils";
import { logger } from "backend/booking/bookingCore";

const log = logger;

const JWT_ALGORITHM = "HS256";
const JWT_EXPIRATION_MS = 1800000;
const JWT_MAX_TOKEN_LENGTH = 8192;
const JWT_MAX_PAYLOAD_LENGTH = 4096;

function safeString(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value);
}

function getJwtSecret() {
    return getSecret(SECRETS.AUTH_JWT_KEY);
}

function logSecurityError(message, traceId) {
    try {
        if (log && typeof log.error === "function") {
            log.error(message, {
                traceId: _safeTrim(traceId)
            });
        }
    } catch (_) {
        return false;
    }

    return true;
}

export function hashSHA256(input) {
    const clean = safeString(input);

    return createHash("sha256")
        .update(clean)
        .digest("hex");
}

export function hmacSha256Hex(key, payload) {
    const cleanKey = safeString(key);
    const cleanPayload = safeString(payload);

    if (!cleanKey) {
        return "";
    }

    return createHmac("sha256", cleanKey)
        .update(cleanPayload)
        .digest("hex");
}

export function hashChain(prevHash, payload) {
    const cleanPrev = safeString(prevHash);
    const cleanPayload = safeString(payload);

    return hashSHA256(
        `${cleanPrev}|${cleanPayload}`
    );
}

export function timingSafeEqual(a, b) {
    try {
        const valueA = safeString(a);
        const valueB = safeString(b);

        const bufferA = Buffer.from(valueA, "utf8");
        const bufferB = Buffer.from(valueB, "utf8");

        if (bufferA.length !== bufferB.length) {
            return false;
        }

        if (bufferA.length === 0) {
            return true;
        }

        return nodeTimingSafeEqual(bufferA, bufferB);
    } catch (_) {
        return false;
    }
}

function base64UrlEncode(input) {
    const clean = safeString(input);

    return Buffer.from(clean, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
    const clean = safeString(input);

    if (
        !clean ||
        clean.length > JWT_MAX_PAYLOAD_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(clean)
    ) {
        return "";
    }

    const converted = clean
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    const remainder = converted.length % 4;

    if (remainder === 1) {
        return "";
    }

    const padding = remainder ?
        "=".repeat(4 - remainder) :
        "";

    try {
        return Buffer.from(
            converted + padding,
            "base64"
        ).toString("utf8");
    } catch (_) {
        return "";
    }
}

function parseJsonObject(value) {
    try {
        const parsed = JSON.parse(value);

        if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) {
            return null;
        }

        return parsed;
    } catch (_) {
        return null;
    }
}

function isValidJwtHeader(header) {
    return header &&
        header.typ === "JWT" &&
        header.alg === JWT_ALGORITHM;
}

function isValidNumericClaim(value) {
    return Number.isFinite(Number(value));
}

export async function generateJWT(payload = {}, traceId) {
    const activeTraceId =
        _safeTrim(traceId) ||
        makeTraceId("jwt-gen");

    try {
        if (
            !payload ||
            typeof payload !== "object" ||
            Array.isArray(payload)
        ) {
            return null;
        }

        const secretKey = _safeTrim(
            await getJwtSecret()
        );

        if (!secretKey) {
            logSecurityError(
                "AUTH_JWT_KEY missing in Secrets Manager",
                activeTraceId
            );
            return null;
        }

        const now = Math.floor(Date.now() / 1000);
        const expiration = now +
            Math.floor(JWT_EXPIRATION_MS / 1000);

        const header = {
            alg: JWT_ALGORITHM,
            typ: "JWT"
        };

        const tokenPayload = {
            ...payload,
            iat: now,
            exp: expiration
        };

        const encodedHeader = base64UrlEncode(
            JSON.stringify(header)
        );

        const encodedPayload = base64UrlEncode(
            JSON.stringify(tokenPayload)
        );

        const signingInput =
            `${encodedHeader}.${encodedPayload}`;

        /*
         * Hexadecimal signatures are preserved for compatibility
         * with existing tokens generated by previous versions.
         */
        const signature = hmacSha256Hex(
            secretKey,
            signingInput
        );

        if (!signature) {
            return null;
        }

        return `${signingInput}.${signature}`;
    } catch (_) {
        logSecurityError(
            "JWT generation failed",
            activeTraceId
        );
        return null;
    }
}

export async function verifyJWT(token, traceId) {
    const activeTraceId =
        _safeTrim(traceId) ||
        makeTraceId("jwt-verify");

    try {
        const cleanToken = _safeTrim(token);

        if (
            !cleanToken ||
            cleanToken.length > JWT_MAX_TOKEN_LENGTH
        ) {
            return null;
        }

        const parts = cleanToken.split(".");

        if (parts.length !== 3) {
            return null;
        }

        const encodedHeader = parts[0];
        const encodedPayload = parts[1];
        const receivedSignature = parts[2];

        if (
            !encodedHeader ||
            !encodedPayload ||
            !receivedSignature ||
            !/^[A-Za-z0-9_-]+$/.test(encodedHeader) ||
            !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
            !/^[A-Za-z0-9a-f]+$/i.test(receivedSignature)
        ) {
            return null;
        }

        const secretKey = _safeTrim(
            await getJwtSecret()
        );

        if (!secretKey) {
            logSecurityError(
                "AUTH_JWT_KEY missing in Secrets Manager",
                activeTraceId
            );
            return null;
        }

        const headerJson = base64UrlDecode(
            encodedHeader
        );

        const payloadJson = base64UrlDecode(
            encodedPayload
        );

        if (!headerJson || !payloadJson) {
            return null;
        }

        const header = parseJsonObject(headerJson);
        const payload = parseJsonObject(payloadJson);

        if (
            !isValidJwtHeader(header) ||
            !payload
        ) {
            return null;
        }

        const signingInput =
            `${encodedHeader}.${encodedPayload}`;

        const expectedSignature = hmacSha256Hex(
            secretKey,
            signingInput
        );

        if (
            !expectedSignature ||
            !timingSafeEqual(
                receivedSignature.toLowerCase(),
                expectedSignature.toLowerCase()
            )
        ) {
            return null;
        }

        if (!isValidNumericClaim(payload.exp)) {
            return null;
        }

        const now = Math.floor(Date.now() / 1000);
        const expiration = Number(payload.exp);

        if (expiration <= now) {
            return null;
        }

        if (
            payload.nbf !== undefined &&
            !isValidNumericClaim(payload.nbf)
        ) {
            return null;
        }

        if (
            payload.nbf !== undefined &&
            Number(payload.nbf) > now
        ) {
            return null;
        }

        return payload;
    } catch (_) {
        logSecurityError(
            "JWT verification failed",
            activeTraceId
        );
        return null;
    }
}