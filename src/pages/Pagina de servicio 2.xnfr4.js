/**
 * MODULE: pages/servicio-2.js
 * VERSION: v5005-2
 * STANDARDS: G10 ASCII Strict, Velo Native Optimized.
 */

import wixLocation from "wix-location";
import {
    getServiceBySlugOrId
} from "backend/reservas.web";

import {
    MESSAGE_TYPES,
    URLS,
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid
} from "public/mmUtils";

import {
    createWidgetBridge
} from "public/widgetBridge";

let bridge = null;
let resolvedService = null;

function getSafeMessage(error, fallback) {
    const message = error && error.message ?
        error.message :
        fallback;

    return _safeTrim(message) || fallback;
}

function showError(message) {
    const safeMessage = _safeTrim(
        message || "No se pudo cargar el servicio."
    );

    console.error(
        "[servicio-2] Error:",
        safeMessage
    );

    try {
        const banner = $w("#errorBanner");

        if (!banner) {
            return;
        }

        banner.text = `Error: ${safeMessage}`;

        if (typeof banner.show === "function") {
            banner.show();
        }
    } catch (error) {
        console.warn(
            "[servicio-2] Could not display error:",
            error && error.message
        );
    }
}

function getMessageType(message) {
    if (
        !message ||
        typeof message !== "object"
    ) {
        return "";
    }

    return _safeTrim(
        message.type || message.action || ""
    ).toUpperCase();
}

function getPayload(message) {
    if (
        !message ||
        typeof message !== "object" ||
        !message.payload ||
        typeof message.payload !== "object" ||
        Array.isArray(message.payload)
    ) {
        return {};
    }

    return message.payload;
}

async function resolveServiceLookup() {
    const query = wixLocation.query || {};

    const candidates = [
        query.slugUrl,
        query.serviceKey,
        query.serviceId
    ];

    for (const candidate of candidates) {
        const value = _safeSlugOrId(candidate);

        if (value) {
            return value;
        }
    }

    const path = Array.isArray(wixLocation.path) ?
        wixLocation.path :
        [];

    const pathValue = _safeSlugOrId(
        path[path.length - 1] || ""
    );

    const excludedPaths = new Set([
        "servicios",
        "service",
        "servicio",
        "servicio-2"
    ]);

    if (
        !pathValue ||
        excludedPaths.has(pathValue)
    ) {
        return null;
    }

    return pathValue;
}

function getServiceId(service) {
    if (
        !service ||
        typeof service !== "object"
    ) {
        return "";
    }

    return _safeTrim(
        service.serviceId ||
        service._id ||
        ""
    );
}

function getServiceSlug(service) {
    if (
        !service ||
        typeof service !== "object"
    ) {
        return "";
    }

    return _safeSlugOrId(
        service.slugUrl || ""
    );
}

function getAddonIds(payload) {
    if (
        !payload ||
        !Array.isArray(payload.addons)
    ) {
        return [];
    }

    return Array.from(
        new Set(
            payload.addons
            .map((addon) => {
                if (
                    addon &&
                    typeof addon === "object"
                ) {
                    return (
                        addon.addonId ||
                        addon.id ||
                        ""
                    );
                }

                return addon || "";
            })
            .map((value) =>
                _safeTrim(value)
            )
            .filter(Boolean)
        )
    ).slice(0, 21);
}

function buildBookingUrl(service, payload) {
    const base = _safeTrim(
        URLS?.CALENDARIO_2 ||
        "/booking-calendar/calendario-2"
    );

    const serviceId = getServiceId(service);
    const slugUrl = getServiceSlug(service);
    const query = [];

    if (slugUrl) {
        query.push(
            `slugUrl=${encodeURIComponent(slugUrl)}`
        );
    }

    if (serviceId) {
        query.push(
            `serviceId=${encodeURIComponent(serviceId)}`
        );
    }

    query.push("referral=servicio-2");

    const addonIds = getAddonIds(payload);

    if (addonIds.length > 0) {
        query.push(
            `addonIds=${encodeURIComponent(
                addonIds.join(",")
            )}`
        );
    }

    return `${base}?${query.join("&")}`;
}

function getServicesUrl() {
    return _safeTrim(
        URLS?.SERVICIOS ||
        "/reserva-online"
    );
}

async function loadService(lookupValue) {
    const result = await getServiceBySlugOrId(
        lookupValue
    );

    if (
        !result ||
        result.status !== "SUCCESS" ||
        !result.data ||
        typeof result.data !== "object"
    ) {
        throw new Error(
            result?.error?.message ||
            "Servicio no encontrado."
        );
    }

    const serviceId = getServiceId(
        result.data
    );

    if (!_looksLikeGuid(serviceId)) {
        throw new Error(
            "El servicio no tiene un identificador valido."
        );
    }

    return {
        ...result.data,
        serviceId,
        slugUrl: getServiceSlug(result.data)
    };
}

$w.onReady(async () => {
    const traceId = makeTraceId("servicio");

    let widget;

    try {
        widget = $w("#htmlWidgetCustomService");
    } catch (error) {
        showError(
            "El widget del servicio no esta disponible."
        );
        return;
    }

    if (
        !widget ||
        typeof widget.postMessage !== "function" ||
        typeof widget.onMessage !== "function"
    ) {
        showError(
            "El widget del servicio no esta disponible."
        );
        return;
    }

    try {
        const lookupValue =
            await resolveServiceLookup();

        if (!lookupValue) {
            showError(
                "No se pudo localizar el servicio en la URL."
            );
            return;
        }

        bridge = createWidgetBridge(widget, {
            slugUrl: lookupValue,
            traceId,

            onContextReady: async () => {
                resolvedService =
                    await loadService(lookupValue);

                return resolvedService;
            },

            onWidgetMessage: async (message) => {
                const type = getMessageType(message);
                const payload = getPayload(message);

                if (!resolvedService) {
                    console.warn(
                        "[servicio-2] Service not ready", {
                            traceId,
                            type
                        }
                    );
                    return;
                }

                if (type === MESSAGE_TYPES.BOOK) {
                    wixLocation.to(
                        buildBookingUrl(
                            resolvedService,
                            payload
                        )
                    );
                    return;
                }

                if (type === MESSAGE_TYPES.NAV) {
                    const target = _safeTrim(
                        payload.target || ""
                    ).toUpperCase();

                    if (
                        !target ||
                        target === "SERVICIOS"
                    ) {
                        wixLocation.to(
                            getServicesUrl()
                        );
                    }

                    return;
                }

                if (
                    type === MESSAGE_TYPES.READY ||
                    type === MESSAGE_TYPES.CONTEXT
                ) {
                    return;
                }

                console.warn(
                    "[servicio-2] Unsupported widget message", {
                        traceId,
                        type
                    }
                );
            },

            onError: (error) => {
                showError(
                    getSafeMessage(
                        error,
                        "No se pudo cargar el servicio."
                    )
                );
            }
        });

        if (!bridge) {
            showError(
                "No se pudo inicializar el widget del servicio."
            );
        }
    } catch (error) {
        console.error(
            "[servicio-2] Initialization failed", {
                traceId,
                message: error && error.message
            }
        );

        showError(
            getSafeMessage(
                error,
                "No se pudo cargar el servicio."
            )
        );
    }
});