(() => {
  const CONTENT_VERSION = "1.1.6";
  if (globalThis.__zapsenderContentVersion === CONTENT_VERSION) return;
  globalThis.__zapsenderContentVersion = CONTENT_VERSION;

  const AUTO_TIMEOUT_MS = 30000;
  const transfers = new Map();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "zapsender-content") return;
    port.onMessage.addListener((message) => {
      if (message?.type !== "CONTENT_REQUEST" || !message.requestId) return;
      handleContentRequest(message.payload)
        .then((result) => postContentResponse(port, message.requestId, result))
        .catch((error) => postContentResponse(port, message.requestId, errorResponse(error)));
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ZAPSENDER_PING") {
      sendResponse({ status: "ready", version: CONTENT_VERSION });
      return false;
    }

    return false;
  });

  async function handleContentRequest(message) {
    if (message?.type === "ZAPSENDER_SEND_CURRENT") {
      return waitAndClickSend(Number(message.timeoutMs) || AUTO_TIMEOUT_MS);
    }
    if (message?.type === "ZAPSENDER_MEDIA_START") {
      transfers.set(message.transferId, {
        metadata: message.metadata || {},
        chunks: []
      });
      return { status: "ready" };
    }
    if (message?.type === "ZAPSENDER_MEDIA_CHUNK") {
      const transfer = transfers.get(message.transferId);
      if (!transfer) throw new Error("Transferencia de anexo nao encontrada.");
      transfer.chunks[Number(message.index) || 0] = base64ToBytes(message.data);
      return { status: "received" };
    }
    if (message?.type === "ZAPSENDER_MEDIA_COMMIT") {
      try {
        return await commitMediaTransfer(
          message.transferId,
          message.text || "",
          Number(message.timeoutMs) || 45000
        );
      } finally {
        transfers.delete(message.transferId);
      }
    }
    throw new Error("Comando desconhecido na aba do WhatsApp.");
  }

  function postContentResponse(port, requestId, result) {
    try {
      port.postMessage({ type: "CONTENT_RESPONSE", requestId, result });
    } catch (_error) {
      // A aba mudou antes da resposta.
    }
  }

  async function commitMediaTransfer(transferId, text, timeoutMs) {
    const transfer = transfers.get(transferId);
    if (!transfer) throw new Error("Transferencia de anexo expirada.");

    const invalidBeforeUpload = await waitForConversationOrInvalid(Math.min(timeoutMs, 30000));
    if (invalidBeforeUpload) {
      return {
        status: "error",
        message: "Numero nao encontrado no WhatsApp",
        detail: invalidBeforeUpload,
        url: location.href
      };
    }

    const blob = new Blob(transfer.chunks, {
      type: transfer.metadata.type || "application/octet-stream"
    });
    const file = new File([blob], transfer.metadata.name || "anexo", {
      type: transfer.metadata.type || blob.type,
      lastModified: Date.now()
    });

    const voiceRequested = transfer.metadata.audioMode === "voice";
    const voiceFallback = voiceRequested;
    await uploadAndSendFile(file, timeoutMs);

    if (text.trim()) {
      try {
        await typeAndSendText(text, timeoutMs);
      } catch (error) {
        return {
          status: "partial",
          message: "Anexo enviado, mas o texto falhou",
          detail: error.message,
          attachmentSent: true,
          voiceFallback,
          url: location.href
        };
      }
    }

    return {
      status: "sent",
      message: voiceFallback
        ? "Anexo e texto enviados. A mensagem de voz experimental usou o fallback de arquivo de audio."
        : "Anexo e texto enviados automaticamente",
      attachmentSent: true,
      voiceFallback,
      url: location.href
    };
  }

  async function uploadAndSendFile(file, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const existingInputs = new Set(document.querySelectorAll('input[type="file"]'));
    const attachmentButton = await waitFor(() => findAttachmentButton(), deadline, "Timeout aguardando botao de anexo");
    attachmentButton.click();
    const fileInput = await waitForAttachmentInput(file, existingInputs, deadline);
    assignFileToInput(fileInput, file);

    const previewSend = await waitFor(
      () => findPreviewSendButton(),
      deadline,
      "Timeout aguardando previa do anexo"
    );
    const previewRoot = previewSend.closest('[role="dialog"], [data-animate-modal-popup]');
    previewSend.click();
    await waitFor(
      () => !previewSend.isConnected
        || !isUsable(previewSend)
        || !findMediaPreviewSendButton()
        || (previewRoot && !isVisible(previewRoot)),
      Math.max(deadline, Date.now() + 5000),
      "O WhatsApp nao confirmou o envio do anexo"
    );
    await sleep(500);
  }

  async function waitForAttachmentInput(file, existingInputs, deadline) {
    while (Date.now() < deadline) {
      const invalidText = getVisibleInvalidNumberText();
      if (invalidText) throw new Error("Numero nao encontrado no WhatsApp");
      const input = findMenuFileInput(file, existingInputs) || findCompatibleFileInput(file, existingInputs);
      if (input) return input;
      await sleep(250);
    }

    const diagnostics = [...document.querySelectorAll('input[type="file"]')]
      .map((input, index) => {
        const accept = input.getAttribute("accept") || "(sem accept)";
        const context = getInputContext(input).replace(/\s+/g, " ").trim().slice(0, 80) || "(sem contexto)";
        return `${index + 1}: accept="${accept}" contexto="${context}"`;
      });
    throw new Error(
      diagnostics.length
        ? `Nenhum campo compativel encontrado. Inputs vistos: ${diagnostics.join(" | ")}`
        : "Nenhum input de arquivo foi criado pelo menu do WhatsApp."
    );
  }

  function assignFileToInput(input, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function typeAndSendText(text, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const composer = await waitFor(() => findComposer(), deadline, "Timeout aguardando campo de mensagem");
    composer.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);

    const sendButton = await waitFor(() => findSendButton(), deadline, "Timeout aguardando botao Enviar do texto");
    sendButton.click();
    await sleep(300);
  }

  async function waitAndClickSend(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const invalidText = getVisibleInvalidNumberText();
      if (invalidText) {
        return {
          status: "error",
          message: "Numero nao encontrado no WhatsApp",
          detail: invalidText,
          url: location.href
        };
      }

      const sendButton = findSendButton();
      if (sendButton) {
        sendButton.click();
        await sleep(250);
        return {
          status: "sent",
          message: "Mensagem enviada automaticamente",
          url: location.href
        };
      }
      await sleep(500);
    }
    return {
      status: "error",
      message: "Timeout aguardando botao Enviar",
      url: location.href
    };
  }

  async function waitForConversationOrInvalid(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const invalidText = getVisibleInvalidNumberText();
      if (invalidText) return invalidText;
      if (findComposer()) return "";
      await sleep(400);
    }
    throw new Error("Timeout aguardando a conversa do WhatsApp");
  }

  async function waitFor(getValue, deadline, timeoutMessage) {
    while (Date.now() < deadline) {
      const invalidText = getVisibleInvalidNumberText();
      if (invalidText) throw new Error("Numero nao encontrado no WhatsApp");
      const value = getValue();
      if (value) return value;
      await sleep(350);
    }
    throw new Error(timeoutMessage);
  }

  function findAttachmentButton() {
    return findUsable([
      'button[aria-label="Anexar"]',
      'button[aria-label="Attach"]',
      'button[title="Anexar"]',
      'button[title="Attach"]',
      'div[role="button"][aria-label="Anexar"]',
      'div[role="button"][aria-label="Attach"]',
      'div[role="button"][title="Anexar"]',
      'div[role="button"][title="Attach"]',
      'span[data-icon="plus-rounded"]',
      'span[data-icon="clip"]',
      'span[data-icon="attach-menu-plus"]'
    ]);
  }

  function findCompatibleFileInput(file, existingInputs = new Set()) {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter((input) => !input.disabled);
    if (!inputs.length) return null;
    const ranked = inputs
      .map((input) => ({
        input,
        score: scoreFileInput(input, file) + (existingInputs.has(input) ? 0 : 300)
      }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => right.score - left.score);
    return ranked[0]?.input || null;
  }

  function findMenuFileInput(file, existingInputs = new Set()) {
    const typePrefix = String(file.type || "").split("/")[0];
    const expectedPattern = typePrefix === "image" || typePrefix === "video"
      ? /^(fotos?\s+e\s+v[ií]deos?|photos?\s*(and|&)\s*videos?)$/i
      : typePrefix === "audio"
        ? /^([aá]udio|audio)$/i
        : /^(documento|document)$/i;
    const menuLabels = [...document.querySelectorAll("span, div, label")]
      .filter((element) => expectedPattern.test(normalizeText(element.textContent)));

    for (const label of menuLabels) {
      const localInputs = collectRelatedFileInputs(label);
      const ranked = localInputs
        .map((input) => ({
          input,
          score: scoreFileInput(input, file) + 700 + (existingInputs.has(input) ? 0 : 300)
        }))
        .filter(({ score }) => Number.isFinite(score))
        .sort((left, right) => right.score - left.score);
      if (ranked[0]?.input) return ranked[0].input;
    }
    return null;
  }

  function scoreFileInput(input, file) {
    const accept = String(input.accept || "").toLowerCase();
    const context = getInputContext(input).toLowerCase();
    const directContext = getDirectInputContext(input).toLowerCase();
    const type = String(file.type || "").toLowerCase();
    const typePrefix = type.split("/")[0];
    const extension = String(file.name || "").split(".").pop().toLowerCase();
    const looksLikeSticker = /sticker|figurinha/.test(directContext)
      || (accept.includes("image/webp") && !accept.includes("video/"))
      || accept.trim() === ".webp";

    if (looksLikeSticker) return Number.NEGATIVE_INFINITY;

    if (typePrefix === "image" || typePrefix === "video") {
      let score = 0;
      if (!accept) return Number.NEGATIVE_INFINITY;
      if (accept.includes("image/")) score += typePrefix === "image" ? 80 : 20;
      if (accept.includes("video/")) score += typePrefix === "video" ? 80 : 55;
      if (accept.includes("image/") && accept.includes("video/")) score += 120;
      if (accept.includes(type)) score += 50;
      if (accept.includes(`.${extension}`)) score += 35;
      if (/photo|video|media|foto|midia/.test(context)) score += 50;
      return score > 0 ? score : Number.NEGATIVE_INFINITY;
    }

    if (typePrefix === "audio") {
      let score = 0;
      if (accept.includes("audio/")) score += 100;
      if (accept.includes(type)) score += 50;
      if (/audio|document|arquivo/.test(context)) score += 25;
      if (!accept || accept.includes("*")) score += 10;
      return score > 0 ? score : Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    if (accept.includes(type) || accept.includes(`.${extension}`)) score += 100;
    if (accept.includes("application/")) score += 60;
    if (/document|arquivo|file/.test(context)) score += 40;
    if (!accept || accept.includes("*")) score += 20;
    if (accept.includes("image/") || accept.includes("video/")) score -= 100;
    return score > 0 ? score : Number.NEGATIVE_INFINITY;
  }

  function collectRelatedFileInputs(label) {
    const inputs = new Set();
    let node = label;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      node.querySelectorAll?.('input[type="file"]').forEach((input) => inputs.add(input));
      node.parentElement?.querySelectorAll?.(':scope > input[type="file"], :scope > label input[type="file"]')
        .forEach((input) => inputs.add(input));
      const forId = node.getAttribute?.("for");
      if (forId) {
        const associated = document.getElementById(forId);
        if (associated?.matches?.('input[type="file"]')) inputs.add(associated);
      }
      if (node.matches?.('[role="menu"], [role="dialog"], [data-animate-modal-popup]')) break;
    }

    const menu = label.closest('[role="menu"], [role="dialog"], [data-animate-modal-popup]')
      || findSmallestInputContainer(label);
    menu?.querySelectorAll?.('input[type="file"]').forEach((input) => inputs.add(input));
    return [...inputs].filter((input) => !input.disabled);
  }

  function findSmallestInputContainer(element) {
    let node = element.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (node.querySelector('input[type="file"]')) return node;
    }
    return null;
  }

  function getInputContext(input) {
    const values = [
      input.name,
      input.id,
      input.getAttribute("accept"),
      input.getAttribute("data-testid"),
      input.getAttribute("aria-label")
    ];
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      values.push(node.getAttribute?.("aria-label"), node.textContent);
    }
    return values.filter(Boolean).join(" ");
  }

  function getDirectInputContext(input) {
    const values = [
      input.name,
      input.id,
      input.getAttribute("accept"),
      input.getAttribute("data-testid"),
      input.getAttribute("aria-label")
    ];
    let node = input.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const text = normalizeText(node.textContent);
      values.push(node.getAttribute?.("aria-label"));
      if (text.length <= 120) values.push(text);
    }
    return values.filter(Boolean).join(" ");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function findPreviewSendButton() {
    const mediaSendButton = findMediaPreviewSendButton();
    if (mediaSendButton) return mediaSendButton;

    const dialogs = [...document.querySelectorAll('[role="dialog"], [data-animate-modal-popup]')].filter(isVisible);
    for (const dialog of dialogs) {
      const button = findSendButton(dialog);
      if (button) return button;
    }
    return findSendButton();
  }

  function findMediaPreviewSendButton() {
    return findUsable([
      '[role="button"][aria-label^="Enviar "][aria-label*="item selecionado"]',
      '[role="button"][aria-label^="Send "][aria-label*="selected item"]',
      '[role="button"] span[data-testid="wds-ic-send-filled"]',
      '[role="button"] span[data-icon="wds-ic-send-filled"]'
    ]);
  }

  function findComposer() {
    return findUsable([
      'footer [contenteditable="true"][role="textbox"]',
      'footer [contenteditable="true"][data-tab]',
      '[contenteditable="true"][aria-label="Digite uma mensagem"]',
      '[contenteditable="true"][aria-label="Type a message"]'
    ]);
  }

  function findSendButton(root = document) {
    const candidates = [
      'button[aria-label="Enviar"]',
      'button[aria-label="Send"]',
      'div[role="button"][aria-label="Enviar"]',
      'div[role="button"][aria-label="Send"]',
      'button span[data-icon="send"]',
      'span[data-icon="send"]',
      '[role="button"] span[data-testid="wds-ic-send-filled"]',
      '[role="button"] span[data-icon="wds-ic-send-filled"]'
    ];
    for (const selector of candidates) {
      const element = root.querySelector(selector);
      const button = element?.closest?.("button, div[role='button']") || element;
      if (isUsable(button)) return button;
    }
    return [...root.querySelectorAll('div[role="button"], button')].find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
      return /^(Enviar|Send)(\s+\d+.*)?$/i.test(label) && isUsable(button);
    }) || null;
  }

  function findUsable(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const control = element?.closest?.("button, div[role='button']") || element;
      if (isUsable(control)) return control;
    }
    return null;
  }

  function getVisibleInvalidNumberText() {
    const patterns = [
      /n[u\u00fa]mero.*inv[a\u00e1]lido/i,
      /n[u\u00fa]mero.*n[a\u00e3]o.*whatsapp/i,
      /n[u\u00fa]mero.*compartilhado.*inv[a\u00e1]lido/i,
      /phone number.*invalid/i,
      /number.*not.*whatsapp/i,
      /invalid.*phone/i
    ];
    const candidates = [...document.querySelectorAll('[role="dialog"], [data-animate-modal-popup], div, span')];
    for (const element of candidates) {
      if (!isVisible(element)) continue;
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 300) continue;
      if (patterns.some((pattern) => pattern.test(text))) return text;
    }
    return "";
  }

  function isUsable(element) {
    return Boolean(element && isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function base64ToBytes(value) {
    const binary = atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function errorResponse(error) {
    return {
      status: "error",
      message: error.message,
      url: location.href
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
