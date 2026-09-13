/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5007.0-FINAL
BASE: BIBLIA v5002.5 Bloque 13.2
RESPONSIBILITY: Puente de comunicacion bidireccional entre widgets embebidos
                y la pagina contenedora via postMessage.
STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
           Compatible con frontend y backend.
=============================================================================
*/

export function createWidgetBridge(widgetElement, options = {}) {
  const {
    allowedOrigin = "*",
    onMessage = null,
    onError = null,
    messageType = "MM_WIDGET",
  } = options;

  if (!widgetElement) {
    throw new Error("widgetBridge: widgetElement is required");
  }

  const messageHandler = (event) => {
    if (allowedOrigin !== "*" && event.origin !== allowedOrigin) return;

    const data = event.data;
    if (!data || data.type !== messageType) return;

    try {
      if (onMessage) onMessage(data.payload, event);
    } catch (err) {
      if (onError) onError(err, data);
    }
  };

  window.addEventListener("message", messageHandler);

  return {
    postMessage(payload) {
      try {
        const targetWindow = widgetElement.contentWindow || widgetElement;
        targetWindow.postMessage({ type: messageType, payload }, allowedOrigin);
      } catch (err) {
        if (onError) onError(err, payload);
      }
    },

    destroy() {
      window.removeEventListener("message", messageHandler);
    },

    get widget() {
      return widgetElement;
    },
  };
}