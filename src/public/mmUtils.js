/**
 * MODULE: public/mmUtils.js
 * VERSION: v5005-6
 * ASCII ONLY
 */

export const VERSION = Object.freeze({
    CORE: "v5005-6",
    BOOKINGS_API: "v2",
    STORES_CATALOG: "v1",
    COMPLIANCE_ES: "2026"
});

export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
    CURRENCY: "EUR"
});

export const TIMEOUTS = Object.freeze({
    API_MS: 15000,
    FRONTEND_MS: 30000,
    WATCHDOG_MS: 30000
});

export const MONEY = Object.freeze({
    DISPLAY_CURRENCY: "EUR",
    DECIMAL_PLACES: 2
});

export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_PER_BOOKING: 21
});

export const MESSAGE_TYPES = Object.freeze({
    READY: "MM_READY",
    CONTEXT: "MM_CONTEXT",
    AVAIL: "MM_AVAIL",
    SELECT: "MM_SELECT",
    BOOK: "MM_BOOK",
    NAV: "MM_NAV"
});

export const URLS = Object.freeze({
    SERVICIOS: "/reserva-online",
    CALENDARIO_2: "/booking-calendar/calendario-2",
    DETALLE_SERVICIO: "/servicio-2",
    PRIVACY_POLICY: "/politica-de-privacidad",
    TPV_PANEL: "/onlystaff"
});

export const UI = Object.freeze({
    HANDSHAKE_MAX_ATTEMPTS: 7,
    HANDSHAKE_BASE_BACKOFF_MS: 750,
    HANDSHAKE_TIMEOUT_MS: 120000,
    CONTEXT_TIMEOUT_MS: 120000,
    FRONTEND_API_TIMEOUT_MS: 30000,
    FRONTEND_RETRY_ATTEMPTS: 3,
    FRONTEND_RETRY_BASE_BACKOFF_MS: 500,
    TPV_POLLING_MS: 60000,
    MAX_VISIBLE_SLOTS: 100,
    SLOT_BUTTON_CLASS: "slot-btn",
    DEFAULT_SERVICE_IMAGE_URL: "https://static.wixstatic.com/media/ab7708_374e5f7adb2f47f3944f3355da129b80~mv2.jpg",
    SALON_LOCATION_LABEL: "C/ Maurice Ravel 35, Zaragoza"
});

export const STAFF_DEFAULT_NAME = "PROFESIONAL SEGUN HORARIO";

export const ARIA = Object.freeze({
    ROLE: Object.freeze({
        BUTTON: "button",
        DIALOG: "dialog",
        ALERT: "alert",
        STATUS: "status",
        NAVIGATION: "navigation",
        MAIN: "main",
        FORM: "form",
        LIST: "list",
        LISTITEM: "listitem"
    }),
    LIVE: Object.freeze({
        POLITE: "polite",
        ASSERTIVE: "assertive"
    })
});

export const LOADING_STATES = Object.freeze({
    IDLE: "idle",
    LOADING: "loading",
    SUCCESS: "success",
    ERROR: "error"
});

export const VALIDATION_RULES = Object.freeze({
    REQUIRED: "required",
    EMAIL: "email",
    PHONE: "phone",
    MIN_LENGTH: "minLength",
    MAX_LENGTH: "maxLength",
    PATTERN: "pattern"
});

export function normalizeIdPart(value, maxLength = 80) {
    const text = value === null || value === undefined ?
        "" :
        String(value).trim();

    const safe = text.replace(/[^A-Za-z0-9_-]/g, "");
    return safe.slice(0, Math.max(0, Number(maxLength) || 80));
}

export function _normalizeIdPart(value, maxLength = 80) {
    return normalizeIdPart(value, maxLength);
}

export function makeTraceId(prefix = "mm") {
    const safePrefix = normalizeIdPart(prefix, 20) || "mm";
    const timestamp = Date.now().toString(36);
    const random = _generateUUID()
        .replace(/-/g, "")
        .slice(0, 12);

    return `${safePrefix}_${timestamp}_${random}`;
}

export function _safeTrim(value) {
    return value === null || value === undefined ?
        "" :
        String(value).trim();
}

export function _cloneDeep(value, seen = new WeakMap()) {
    if (value === null || typeof value !== "object") {
        return value;
    }

    if (value instanceof Date) {
        return new Date(value.getTime());
    }

    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags);
    }

    if (seen.has(value)) {
        return seen.get(value);
    }

    if (Array.isArray(value)) {
        const output = [];
        seen.set(value, output);

        value.forEach((item) => {
            output.push(_cloneDeep(item, seen));
        });

        return output;
    }

    const output = {};
    seen.set(value, output);

    Object.keys(value).forEach((key) => {
        output[key] = _cloneDeep(value[key], seen);
    });

    return output;
}

export function _safeEmail(value) {
    return value === null || value === undefined ?
        "" :
        String(value).trim().toLowerCase();
}

export function _isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        _safeEmail(value)
    );
}

export function _safePhone(value) {
    const raw = value === null || value === undefined ?
        "" :
        String(value).trim();

    if (!raw) {
        return "";
    }

    const prefix = raw.startsWith("+") ? "+" : "";
    const digits = raw.replace(/\D/g, "");

    return digits ? `${prefix}${digits}` : "";
}

export function _looksLikeGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(_safeTrim(value));
}

export function _safeSlugOrId(value) {
    let text = _safeTrim(value);

    if (!text) {
        return "";
    }

    text = text.split("?")[0].split("#")[0];
    text = text.replace(/^\/+|\/+$/g, "");

    const parts = text.split("/").filter(Boolean);
    text = parts.length ? parts[parts.length - 1] : text;

    if (_looksLikeGuid(text)) {
        return text;
    }

    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

export function _normalizeLocalIsoStr(value) {
    if (!value || value instanceof Date) {
        return "";
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/
        .exec(String(value).trim());

    if (!match) {
        return "";
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] === undefined ? 0 : Number(match[4]);
    const minute = match[5] === undefined ? 0 : Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);

    const check = new Date(
        Date.UTC(year, month - 1, day, hour, minute, second)
    );

    const valid =
        check.getUTCFullYear() === year &&
        check.getUTCMonth() === month - 1 &&
        check.getUTCDate() === day &&
        hour >= 0 &&
        hour <= 23 &&
        minute >= 0 &&
        minute <= 59 &&
        second >= 0 &&
        second <= 59;

    if (!valid) {
        return "";
    }

    return [
        `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`
    ].join("T");
}

export function _toDateSafe(value) {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "object" && value.$date) {
        return _toDateSafe(value.$date);
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function _getMadridParts(date) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: SDK_CONFIG.TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });

    const parts = formatter.formatToParts(date);
    const result = {};

    parts.forEach((part) => {
        if (part.type !== "literal") {
            result[part.type] = Number(part.value);
        }
    });

    return result;
}

export function getUtcDateFromMadridLocal(localValue) {
    if (localValue instanceof Date) {
        return _toDateSafe(localValue);
    }

    const normalized = _normalizeLocalIsoStr(localValue);

    if (!normalized) {
        return null;
    }

    const [dateText, timeText] = normalized.split("T");
    const [year, month, day] = dateText.split("-").map(Number);
    const [hour, minute, second] = timeText.split(":").map(Number);

    const localAsUtcMs = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second
    );

    let result = new Date(localAsUtcMs);

    for (let index = 0; index < 3; index += 1) {
        const parts = _getMadridParts(result);

        const displayedAsUtcMs = Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second
        );

        const difference = displayedAsUtcMs - localAsUtcMs;
        result = new Date(result.getTime() - difference);
    }

    if (Number.isNaN(result.getTime())) {
        return null;
    }

    const check = _getMadridParts(result);

    const matches =
        check.year === year &&
        check.month === month &&
        check.day === day &&
        check.hour === hour &&
        check.minute === minute &&
        check.second === second;

    return matches ? result : null;
}

export function getMadridLocalStringNoZ(value) {
    const date = _toDateSafe(value);

    if (!date) {
        return "";
    }

    const parts = _getMadridParts(date);

    return [
        `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
        `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`
    ].join("T");
}

export function withTimeout(
    promise,
    timeoutMs = TIMEOUTS.API_MS,
    label = "operation"
) {
    const parsedMs = Number(timeoutMs);
    const ms = Number.isFinite(parsedMs) && parsedMs > 0 ?
        parsedMs :
        TIMEOUTS.API_MS;

    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(
                `TIMEOUT: ${label} exceeded ${ms}ms`
            );
            error.code = "TIMEOUT";
            reject(error);
        }, ms);
    });

    return Promise.race([
        Promise.resolve(promise),
        timeoutPromise
    ]).finally(() => {
        if (timer !== null) {
            clearTimeout(timer);
        }
    });
}

function extractStatusCode(error) {
    if (!error) {
        return null;
    }

    if (Number.isInteger(error.statusCode)) {
        return error.statusCode;
    }

    if (Number.isInteger(error.status)) {
        return error.status;
    }

    if (
        error.details &&
        Number.isInteger(error.details.statusCode)
    ) {
        return error.details.statusCode;
    }

    return null;
}

function isRetryableError(error) {
    return [
        408,
        425,
        429,
        500,
        502,
        503,
        504
    ].includes(extractStatusCode(error));
}

export async function executeWithRetry(fn, options = {}) {
    if (typeof fn !== "function") {
        throw new TypeError("RETRY_FUNCTION_REQUIRED");
    }

    const attempts = Number.isInteger(options.attempts) ?
        Math.max(1, Math.min(options.attempts, 5)) :
        3;

    const baseDelay = Number.isFinite(Number(options.baseDelay)) ?
        Math.max(100, Number(options.baseDelay)) :
        500;

    const retrySafe = options.retrySafe === true;
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;

            if (!retrySafe || !isRetryableError(error)) {
                throw error;
            }

            if (attempt >= attempts - 1) {
                break;
            }

            const delay =
                baseDelay * (2 ** attempt) +
                Math.floor(Math.random() * baseDelay);

            await new Promise((resolve) => {
                setTimeout(resolve, delay);
            });
        }
    }

    throw lastError || new Error("RETRY_FAILED");
}

export const _executeWithRetry = executeWithRetry;

export function _roundMoney(value) {
    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return 0;
    }

    return Math.round(
        (amount + Number.EPSILON) * 100
    ) / 100;
}

export function _readPositiveAmount(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    return _roundMoney(amount);
}

export function _readNonNegativeAmount(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const amount = Number(value);

    if (!Number.isFinite(amount) || amount < 0) {
        return null;
    }

    return _roundMoney(amount);
}

export function _maskEmail(value) {
    const email = _safeEmail(value);
    const parts = email.split("@");

    if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1]
    ) {
        return "***@***";
    }

    return `${parts[0].slice(0, 2)}***@${parts[1]}`;
}

export function _maskPhone(value) {
    const phone = _safePhone(value);

    if (phone.length <= 4) {
        return "***";
    }

    return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

export function _maskName(value) {
    const name = _safeTrim(value);

    if (!name) {
        return "";
    }

    if (name.length <= 2) {
        return `${name[0]}*`;
    }

    return `${name[0]}*${name[name.length - 1]}`;
}

export function _cleanText(value, maxLength = 5000) {
    const text = value === null || value === undefined ?
        "" :
        String(value).trim();

    const limit = Number.isFinite(Number(maxLength)) ?
        Math.max(0, Number(maxLength)) :
        5000;

    if (text.length > limit) {
        throw new Error("TEXT_TOO_LONG");
    }

    return text;
}

export function _extractRelationalId(value) {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "string") {
        return value.trim();
    }

    if (typeof value === "object") {
        return String(
            value._id ||
            value.id ||
            value.serviceId ||
            ""
        ).trim();
    }

    return String(value).trim();
}

export function _normType(value) {
    return value === null || value === undefined ?
        "" :
        String(value).trim().toUpperCase();
}

export function _readDate(value) {
    const text = value === null || value === undefined ?
        "" :
        String(value);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return null;
    }

    const date = new Date(`${text}T00:00:00Z`);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const normalized = [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-");

    return normalized === text ? text : null;
}

export function _stableSerialize(value, seen = new WeakSet()) {
    if (value === null) {
        return "null";
    }

    if (value === undefined) {
        return "undefined";
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ?
            JSON.stringify(value) :
            "null";
    }

    if (
        typeof value === "string" ||
        typeof value === "boolean"
    ) {
        return JSON.stringify(value);
    }

    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }

    if (typeof value !== "object") {
        return JSON.stringify(String(value));
    }

    if (seen.has(value)) {
        throw new TypeError("CIRCULAR_STRUCTURE");
    }

    seen.add(value);

    let output;

    if (Array.isArray(value)) {
        output = `[${value.map((item) =>
            _stableSerialize(item, seen)
        ).join(",")}]`;
    } else {
        output = `{${Object.keys(value)
            .sort()
            .map((key) =>
                `${JSON.stringify(key)}:` +
                _stableSerialize(value[key], seen)
            )
            .join(",")}}`;
    }

    seen.delete(value);
    return output;
}

export function _hashKey(value) {
    const text = value === null || value === undefined ?
        "" :
        String(value);

    let hash = 5381;

    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }

    return Math.abs(hash)
        .toString(16)
        .padStart(8, "0");
}

export function _generateUUID() {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }

    const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";

    return template.replace(/[xy]/g, (char) => {
        const random = Math.floor(Math.random() * 16);
        const value = char === "x" ?
            random :
            (random & 3) | 8;

        return value.toString(16);
    });
}

export function _sanitizeForLog(
    value,
    sensitiveKeys = [
        "email",
        "phone",
        "telefono",
        "nombre",
        "apellidos",
        "address",
        "direccion",
        "cliente",
        "contact",
        "token",
        "password",
        "secret",
        "authorization",
        "cookie"
    ]
) {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) =>
            _sanitizeForLog(item, sensitiveKeys)
        );
    }

    if (typeof value !== "object") {
        return value;
    }

    const result = {};

    Object.entries(value).forEach(([key, item]) => {
        const lowerKey = key.toLowerCase();

        const sensitive = sensitiveKeys.some((entry) =>
            lowerKey.includes(String(entry).toLowerCase())
        );

        result[key] = sensitive ?
            "***REDACTED***" :
            _sanitizeForLog(item, sensitiveKeys);
    });

    return result;
}

export function _createAriaLabel(text, context = "") {
    const clean = _safeTrim(text);

    if (!clean) {
        return "";
    }

    const cleanContext = _safeTrim(context);

    return cleanContext ?
        `${clean}, ${cleanContext}` :
        clean;
}

export function _announceToScreenReader(
    message,
    priority = ARIA.LIVE.POLITE
) {
    if (
        typeof document === "undefined" ||
        !document.body
    ) {
        return;
    }

    let announcer = document.getElementById("sr-announcer");

    if (!announcer) {
        announcer = document.createElement("div");
        announcer.id = "sr-announcer";
        announcer.style.cssText =
            "position:absolute;left:-10000px;" +
            "width:1px;height:1px;overflow:hidden;";

        document.body.appendChild(announcer);
    }

    announcer.setAttribute("aria-live", priority);
    announcer.setAttribute("aria-atomic", "true");
    announcer.textContent = "";

    setTimeout(() => {
        if (
            announcer &&
            announcer.isConnected
        ) {
            announcer.textContent = _safeTrim(message);
        }
    }, 100);
}

export function _createLoadingState(container) {
    if (
        !container ||
        typeof container !== "object"
    ) {
        throw new Error("LOADING_CONTAINER_REQUIRED");
    }

    const setMessage = (message, role, priority) => {
        container.textContent = _safeTrim(message);
        container.setAttribute("role", role);
        _announceToScreenReader(message, priority);
    };

    const state = {
        current: LOADING_STATES.IDLE,

        showLoading(message = "Cargando...") {
            state.current = LOADING_STATES.LOADING;
            setMessage(
                message,
                ARIA.ROLE.STATUS,
                ARIA.LIVE.POLITE
            );
        },

        showSuccess(message = "Completado") {
            state.current = LOADING_STATES.SUCCESS;
            setMessage(
                message,
                ARIA.ROLE.STATUS,
                ARIA.LIVE.POLITE
            );
        },

        showError(message = "Error") {
            state.current = LOADING_STATES.ERROR;
            setMessage(
                message,
                ARIA.ROLE.ALERT,
                ARIA.LIVE.ASSERTIVE
            );
        },

        reset() {
            state.current = LOADING_STATES.IDLE;
            container.textContent = "";
        }
    };

    return state;
}

export function _validateField(value, rules = []) {
    const errors = [];

    const text = value === null || value === undefined ?
        "" :
        String(value).trim();

    if (!Array.isArray(rules)) {
        return {
            isValid: true,
            errors: []
        };
    }

    rules.forEach((rule) => {
        if (!rule || typeof rule !== "object") {
            return;
        }

        switch (rule.type) {
        case VALIDATION_RULES.REQUIRED:
            if (!text) {
                errors.push(
                    rule.message ||
                    "Este campo es obligatorio"
                );
            }
            break;

        case VALIDATION_RULES.EMAIL:
            if (text && !_isValidEmail(text)) {
                errors.push(
                    rule.message ||
                    "Email invalido"
                );
            }
            break;

        case VALIDATION_RULES.PHONE:
            if (
                text &&
                !/^[+]?[0-9\s()\-]{9,20}$/.test(text)
            ) {
                errors.push(
                    rule.message ||
                    "Telefono invalido"
                );
            }
            break;

        case VALIDATION_RULES.MIN_LENGTH:
            if (
                text &&
                text.length < Number(rule.value)
            ) {
                errors.push(
                    rule.message ||
                    `Minimo ${rule.value} caracteres`
                );
            }
            break;

        case VALIDATION_RULES.MAX_LENGTH:
            if (
                text &&
                text.length > Number(rule.value)
            ) {
                errors.push(
                    rule.message ||
                    `Maximo ${rule.value} caracteres`
                );
            }
            break;

        case VALIDATION_RULES.PATTERN:
            if (
                text &&
                rule.value instanceof RegExp
            ) {
                rule.value.lastIndex = 0;

                if (!rule.value.test(text)) {
                    errors.push(
                        rule.message ||
                        "Formato invalido"
                    );
                }

                rule.value.lastIndex = 0;
            }
            break;

        default:
            break;
        }
    });

    return {
        isValid: errors.length === 0,
        errors
    };
}

export function _serializeForm(formElement) {
    if (
        !formElement ||
        !formElement.elements
    ) {
        return {};
    }

    const data = {};

    Array.from(formElement.elements).forEach((element) => {
        if (
            !element ||
            !element.name ||
            element.disabled
        ) {
            return;
        }

        if (
            [
                "submit",
                "button",
                "reset",
                "file"
            ].includes(element.type)
        ) {
            return;
        }

        if (element.type === "checkbox") {
            data[element.name] = element.checked;
            return;
        }

        if (element.type === "radio") {
            if (element.checked) {
                data[element.name] = element.value;
            }
            return;
        }

        data[element.name] = element.value;
    });

    return data;
}