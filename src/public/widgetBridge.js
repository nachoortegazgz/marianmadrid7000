/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v5007.3-FINAL
=============================================================================
*/
export function createWidgetBridge(widgetElement, options = {}) {
  const { allowedOrigin = "*", onMessage = null, onError = null, messageType = "MM_WIDGET" } = options;
  if (!widgetElement) throw new Error("widgetBridge: widgetElement is required");
  const messageHandler = (event) => {
    if (allowedOrigin !== "*" && event.origin !== allowedOrigin) return;
    const data = event.data;
    if (!data || data.type !== messageType) return;
    try { if (onMessage) onMessage(data.payload, event); }
    catch (err) { if (onError) onError(err, data); }
  };
  window.addEventListener("message", messageHandler);
  return {
    postMessage(payload) {
      try { (widgetElement.contentWindow || widgetElement).postMessage({ type: messageType, payload }, allowedOrigin); }
      catch (err) { if (onError) onError(err, payload); }
    },
    destroy() { window.removeEventListener("message", messageHandler); },
    get widget() { return widgetElement; },
  };
}