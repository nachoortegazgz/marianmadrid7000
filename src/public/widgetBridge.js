/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5005-1
RESPONSIBILITY: Centralized postMessage transport between Velo pages and
HTML widgets or Custom Elements.
STANDARDS: G10 ASCII Strict, Velo Native Optimized, Reactive Flow.
=============================================================================
*/

import {
    MESSAGE_TYPES,
    makeTraceId,
    _safeSlugOrId,
    _safeTrim,
    withTimeout
} from "public/mmUtils";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_MESSAGE_TYPE_LENGTH = 80;
const MAX_MESSAGE_ID_LENGTH = 120;

function normalizeType(value) {
    return _safeTrim(value)
        .toUpperCase()
        .slice(0, MAX_MESSAGE_TYPE_LENGTH);
}

function normalizeMessageId(value) {
    return _safeTrim(value)
        .replace(/[^A-Za-z0-9_.:-]/g, "")
        .slice(0, MAX_MESSAGE_ID_LENGTH);
}

function normalizeTimeout(
    value,
    fallback = DEFAULT_TIMEOUT_MS
) {
    const timeout = Number(value);

    return Number.isFinite(timeout) && timeout > 0 ?
        timeout :
        fallback;
}

function isObject(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}

function safeError(error, fallback = "Widget operation failed") {
    return {
        code: _safeTrim(error?.code) ||
            "WIDGET_MESSAGE_FAILED",
        message: _safeTrim(error?.message) ||
            fallback
    };
}

export function createWidgetBridge(
    widgetElement,
    options = {}
) {
    const traceId = _safeTrim(options.traceId) ||
        makeTraceId("bridge");

    const slugUrl =
        _safeSlugOrId(
            options.slugUrl ||
            options.slug ||
            ""
        ) || "unknown";

    const widgetIsValid =
        widgetElement &&
        typeof widgetElement.postMessage === "function" &&
        typeof widgetElement.onMessage === "function";

    if (!widgetIsValid) {
        const error = new Error(
            "Widget not found or incompatible"
        );

        console.error(
            "[widgetBridge] HTML widget is not available."
        );

        if (typeof options.onError === "function") {
            try {
                options.onError(error);
            } catch (callbackError) {
                console.error(
                    "[widgetBridge] onError callback failed:",
                    callbackError?.message
                );
            }
        }

        return null;
    }

    const handshakeTimeoutMs = normalizeTimeout(
        options.handshakeTimeoutMs
    );

    const contextTimeoutMs = normalizeTimeout(
        options.contextTimeoutMs
    );

    const messageTimeoutMs = normalizeTimeout(
        options.messageTimeoutMs
    );

    let contextSent = false;
    let contextPromise = null;
    let handshakeTimer = null;
    let destroyed = false;

    function reportError(error) {
        if (typeof options.onError !== "function") {
            return;
        }

        try {
            options.onError(error);
        } catch (callbackError) {
            console.error(
                "[widgetBridge] onError callback failed:",
                callbackError?.message
            );
        }
    }

    function post(
        type,
        payload = {},
        messageId = null
    ) {
        if (destroyed) {
            return false;
        }

        const normalizedType = normalizeType(type);

        if (!normalizedType) {
            return false;
        }

        const safePayload = isObject(payload) ?
            payload :
            {};

        const message = {
            type: normalizedType,
            payload: {
                ...safePayload,
                traceId
            }
        };

        const normalizedMessageId =
            normalizeMessageId(messageId);

        if (normalizedMessageId) {
            message.messageId = normalizedMessageId;
        }

        try {
            widgetElement.postMessage(message);
            return true;
        } catch (error) {
            console.warn(
                "[widgetBridge] postMessage failed:",
                error?.message
            );

            reportError(error);
            return false;
        }
    }

    async function postContext() {
        if (destroyed) {
            return false;
        }

        if (contextSent) {
            return true;
        }

        if (contextPromise) {
            return contextPromise;
        }

        contextPromise = (async () => {
            try {
                const contextData =
                    typeof options.onContextReady === "function" ?
                    await withTimeout(
                        Promise.resolve(
                            options.onContextReady()
                        ),
                        contextTimeoutMs,
                        "widget context"
                    ) :
                    {};

                const safeContext = isObject(
                        contextData
                    ) ?
                    contextData :
                    {};

                const sent = post(
                    MESSAGE_TYPES.CONTEXT, {
                        ...safeContext,
                        slugUrl,
                        slug: slugUrl
                    }
                );

                if (!sent) {
                    throw new Error(
                        "Widget context could not be sent"
                    );
                }

                contextSent = true;

                if (handshakeTimer) {
                    clearTimeout(handshakeTimer);
                    handshakeTimer = null;
                }

                return true;
            } catch (error) {
                console.error(
                    "[widgetBridge] Failed to prepare context:",
                    error?.message
                );

                reportError(error);
                throw error;
            } finally {
                contextPromise = null;
            }
        })();

        return contextPromise;
    }

    function sendErrorResponse(
        requestType,
        messageId,
        error
    ) {
        const responseType =
            `${normalizeType(requestType)}_RES`;

        const publicError = safeError(error);

        post(
            responseType, {
                status: "ERROR",
                data: null,
                error: publicError
            },
            messageId
        );
    }

    async function handleMessage(event) {
        if (destroyed) {
            return;
        }

        const message =
            event && event.data ?
            event.data :
            event;

        if (!isObject(message)) {
            return;
        }

        const type = normalizeType(
            message.type ||
            message.action
        );

        const messageId = normalizeMessageId(
            message.messageId
        );

        if (!type) {
            return;
        }

        if (
            type === normalizeType(
                MESSAGE_TYPES.READY
            )
        ) {
            post(
                MESSAGE_TYPES.READY, {
                    status: "ACK"
                },
                messageId
            );

            try {
                await postContext();
            } catch (_) {
                return;
            }

            return;
        }

        if (
            typeof options.onWidgetMessage !==
            "function"
        ) {
            return;
        }

        let responseSent = false;

        function reply(
            responseType,
            responsePayload = {},
            replyMessageId = messageId
        ) {
            if (
                destroyed ||
                responseSent
            ) {
                return false;
            }

            const sent = post(
                responseType,
                responsePayload,
                replyMessageId
            );

            if (sent) {
                responseSent = true;
            }

            return sent;
        }

        try {
            await withTimeout(
                Promise.resolve(
                    options.onWidgetMessage(
                        message,
                        reply
                    )
                ),
                messageTimeoutMs,
                `widget message ${type}`
            );
        } catch (error) {
            console.error(
                "[widgetBridge] onWidgetMessage failed:",
                error?.message
            );

            if (!responseSent) {
                sendErrorResponse(
                    type,
                    messageId,
                    error
                );
            }

            reportError(error);
        }
    }

    handshakeTimer = setTimeout(() => {
        if (
            !destroyed &&
            !contextSent
        ) {
            reportError(
                new Error(
                    "Widget handshake timeout"
                )
            );
        }
    }, handshakeTimeoutMs);

    try {
        widgetElement.onMessage(handleMessage);
    } catch (error) {
        if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
        }

        reportError(error);
        return null;
    }

    return {
        post,
        postContext,

        getTraceId() {
            return traceId;
        },

        getSlugUrl() {
            return slugUrl;
        },

        isReady() {
            return contextSent;
        },

        isDestroyed() {
            return destroyed;
        },

        destroy() {
            destroyed = true;

            if (handshakeTimer) {
                clearTimeout(handshakeTimer);
                handshakeTimer = null;
            }

            contextPromise = null;
        }
    };
}