import { getAttachment } from "./src/attachments.js";

const WHATSAPP_URL = "https://web.whatsapp.com/";
const TRANSFER_CHUNK_SIZE = 256 * 1024;

chrome.action.onClicked.addListener(async () => {
  const panelUrl = chrome.runtime.getURL("panel.html");
  const existing = await chrome.tabs.query({ url: panelUrl });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: panelUrl });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "zapsender-worker") return;

  port.onMessage.addListener((message) => {
    if (message?.type !== "WORKER_REQUEST" || !message.requestId) return;
    handleWorkerRequest(message.payload)
      .then((result) => postPortResponse(port, message.requestId, result))
      .catch((error) => postPortResponse(port, message.requestId, {
        status: "error",
        message: error.message
      }));
  });
});

async function handleWorkerRequest(message) {
  if (message?.type === "SEND_WHATSAPP_MESSAGE") {
    return sendToWhatsApp(message, message.focusTab === true);
  }
  if (message?.type === "OPEN_WHATSAPP_URL") {
    return openWhatsAppUrl(message.url, message.focusTab === true);
  }
  if (message?.type === "CHECK_WHATSAPP_TAB") {
    const tab = await findWhatsAppTab();
    return {
      ready: Boolean(tab?.id),
      tabId: tab?.id || null,
      title: tab?.title || "",
      url: tab?.url || ""
    };
  }
  throw new Error("Comando desconhecido do Zapsender.");
}

function postPortResponse(port, requestId, result) {
  try {
    port.postMessage({ type: "WORKER_RESPONSE", requestId, result });
  } catch (_error) {
    // O painel foi fechado antes do fim da operacao.
  }
}

async function sendToWhatsApp(message, focusTab = false) {
  let attachmentRecord = null;
  if (message.attachment?.id) {
    attachmentRecord = await getAttachment(message.attachment.id);
    if (!attachmentRecord?.blob) {
      return {
        status: "error",
        message: "Anexo nao encontrado neste Chrome. Selecione o arquivo novamente.",
        detail: message.attachment.name || "Anexo ausente"
      };
    }
  }

  const tab = await openWhatsAppUrl(message.url, focusTab);
  await ensureContentScript(tab.tabId);

  if (message.attachment?.id) {
    return sendAttachmentAndText(tab.tabId, message.attachment, message.text || "", attachmentRecord);
  }

  const response = await sendContentRequest(tab.tabId, {
    type: "ZAPSENDER_SEND_CURRENT",
    timeoutMs: 30000
  }, 45000);

  return {
    ...response,
    tabId: tab.tabId
  };
}

async function sendAttachmentAndText(tabId, reference, text, record) {
  const transferId = `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const buffer = await record.blob.arrayBuffer();
  const response = await withContentPort(tabId, async (request) => {
    await request({
      type: "ZAPSENDER_MEDIA_START",
      transferId,
      metadata: {
        name: record.name,
        type: record.type || reference.type || "application/octet-stream",
        size: record.size,
        audioMode: reference.audioMode === "voice" ? "voice" : "file"
      }
    }, 10000);

    for (let offset = 0, index = 0; offset < buffer.byteLength; offset += TRANSFER_CHUNK_SIZE, index += 1) {
      const chunk = buffer.slice(offset, Math.min(offset + TRANSFER_CHUNK_SIZE, buffer.byteLength));
      await request({
        type: "ZAPSENDER_MEDIA_CHUNK",
        transferId,
        index,
        data: arrayBufferToBase64(chunk)
      }, 10000);
    }

    return request({
      type: "ZAPSENDER_MEDIA_COMMIT",
      transferId,
      text,
      timeoutMs: 45000
    }, 60000);
  });
  return {
    ...response,
    tabId
  };
}

async function openWhatsAppUrl(url, focusTab = false) {
  const tab = await findWhatsAppTab();
  if (!tab?.id) {
    throw new Error("Abra o WhatsApp Web em uma aba desta janela antes de iniciar.");
  }

  await chrome.tabs.update(tab.id, focusTab ? { active: true, url } : { url });
  if (focusTab && tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await waitForTabLoaded(tab.id);
  if (focusTab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }
  return {
    status: "opened",
    message: "Conversa aberta no WhatsApp Web",
    url,
    tabId: tab.id
  };
}

async function findWhatsAppTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith(WHATSAPP_URL)) return active;

  const currentWindowTabs = await chrome.tabs.query({ currentWindow: true, url: "https://web.whatsapp.com/*" });
  if (currentWindowTabs[0]) return currentWindowTabs[0];

  const allTabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  return allTabs[0] || null;
}

function waitForTabLoaded(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timeout carregando a aba do WhatsApp Web"));
    }, 25000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === "complete") {
        clearTimeout(timeout);
        resolve();
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ZAPSENDER_PING" });
    if (response?.status !== "ready" || response.version !== "1.1.6") {
      throw new Error("Content script desatualizado.");
    }
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/whatsapp-content.js"]
    });
  }
}

function sendContentRequest(tabId, payload, timeoutMs) {
  return withContentPort(tabId, (request) => request(payload, timeoutMs));
}

function withContentPort(tabId, operation) {
  const port = chrome.tabs.connect(tabId, { name: "zapsender-content" });
  let sequence = 0;
  let disconnected = false;
  const pending = new Map();

  port.onMessage.addListener((message) => {
    if (message?.type !== "CONTENT_RESPONSE") return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    clearTimeout(request.timeout);
    request.resolve(message.result);
  });

  port.onDisconnect.addListener(() => {
    disconnected = true;
    const message = chrome.runtime.lastError?.message || "A conexao com a aba do WhatsApp foi interrompida.";
    for (const [requestId, request] of pending) {
      pending.delete(requestId);
      clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
  });

  const request = (payload, timeoutMs) => {
    if (disconnected) return Promise.reject(new Error("A conexao com a aba do WhatsApp foi encerrada."));
    const requestId = `content-${Date.now()}-${sequence += 1}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Timeout aguardando resposta da aba do WhatsApp."));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      port.postMessage({ type: "CONTENT_REQUEST", requestId, payload });
    });
  };

  return Promise.resolve()
    .then(() => operation(request))
    .finally(() => {
      if (!disconnected) port.disconnect();
    });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}
