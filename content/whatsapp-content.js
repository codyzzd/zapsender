(() => {
  const CONTENT_VERSION = "1.3.0";
  const REQUEST_SOURCE = "zapsender-content";
  const RESPONSE_SOURCE = "zapsender-main";

  if (globalThis.__zapsenderContentVersion === CONTENT_VERSION) return;
  globalThis.__zapsenderContentVersion = CONTENT_VERSION;

  const pendingMainRequests = new Map();
  let mainRequestSequence = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== RESPONSE_SOURCE) return;
    const pending = pendingMainRequests.get(event.data.requestId);
    if (!pending) return;
    pendingMainRequests.delete(event.data.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(event.data.result);
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "zapsender-content") return;

    port.onMessage.addListener((message) => {
      if (message?.type !== "CONTENT_REQUEST" || !message.requestId) return;
      forwardToMain(message.payload)
        .then((result) => postContentResponse(port, message.requestId, result))
        .catch((error) => postContentResponse(port, message.requestId, {
          status: "error",
          message: error.message,
          fatal: error.fatal === true,
          code: error.code || "bridge_error"
        }));
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "ZAPSENDER_PING") return false;
    sendResponse({ status: "ready", version: CONTENT_VERSION });
    return false;
  });

  function forwardToMain(payload) {
    const requestId = `main-${Date.now()}-${mainRequestSequence += 1}`;
    const timeoutMs = Number(payload?.bridgeTimeoutMs) || 90000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingMainRequests.delete(requestId);
        const error = new Error("Timeout aguardando o motor interno do WhatsApp.");
        error.fatal = true;
        error.code = "engine_timeout";
        reject(error);
      }, timeoutMs);

      pendingMainRequests.set(requestId, { resolve, reject, timeout });
      window.postMessage({
        source: REQUEST_SOURCE,
        requestId,
        payload
      }, "*");
    });
  }

  function postContentResponse(port, requestId, result) {
    try {
      port.postMessage({ type: "CONTENT_RESPONSE", requestId, result });
    } catch (_error) {
      // A aba ou o painel foi fechado antes da resposta.
    }
  }
})();
