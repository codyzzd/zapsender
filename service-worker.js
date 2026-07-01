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
        message: error.message,
        code: error.code || "worker_error",
        fatal: error.fatal === true
      }));
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "WORKER_REQUEST" || !message.requestId) return false;
  handleWorkerRequest(message.payload)
    .then((result) => sendResponse({
      type: "WORKER_RESPONSE",
      requestId: message.requestId,
      result
    }))
    .catch((error) => sendResponse({
      type: "WORKER_RESPONSE",
      requestId: message.requestId,
      result: {
        status: "error",
        message: error.message,
        code: error.code || "worker_error",
        fatal: error.fatal === true
      }
    }));
  return true;
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
    if (!tab?.id) {
      return { ready: false, engineReady: false, tabId: null, title: "", url: "" };
    }
    await ensureWhatsAppRuntime(tab.id);
    const engine = await getEngineStatus(tab.id);
    return {
      ready: engine.status === "ready",
      engineReady: engine.status === "ready",
      message: engine.message || "",
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || ""
    };
  }
  if (message?.type === "LIST_WHATSAPP_GROUPS") {
    const tab = await prepareWhatsAppTab(false);
    if (tab.status === "error") return tab;
    const response = await sendContentRequest(tab.tabId, {
      type: "ZAPSENDER_LIST_GROUPS",
      bridgeTimeoutMs: 80000
    }, 90000);
    return {
      ...response,
      tabId: tab.tabId
    };
  }
  if (message?.type === "EXPORT_GROUP_PARTICIPANTS") {
    const tab = await prepareWhatsAppTab(false);
    if (tab.status === "error") return tab;
    const response = await sendContentRequest(tab.tabId, {
      type: "ZAPSENDER_EXPORT_GROUP_PARTICIPANTS",
      groupId: message.groupId,
      includeAdmins: message.includeAdmins === true,
      bridgeTimeoutMs: 100000
    }, 120000);
    return {
      ...response,
      tabId: tab.tabId
    };
  }
  if (message?.type === "EXPORT_OPEN_GROUP_PARTICIPANTS") {
    const tab = await prepareWhatsAppTab(false);
    if (tab.status === "error") return tab;
    const response = await sendContentRequest(tab.tabId, {
      type: "ZAPSENDER_EXPORT_OPEN_GROUP_PARTICIPANTS",
      bridgeTimeoutMs: 80000
    }, 90000);
    return {
      ...response,
      tabId: tab.tabId
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

  const tab = await prepareWhatsAppTab(focusTab);
  if (tab.status === "error") return tab;

  if (message.attachment?.id) {
    return sendAttachmentAndText(
      tab.tabId,
      message.phone,
      message.attachment,
      message.text || "",
      attachmentRecord
    );
  }

  const response = await sendContentRequest(tab.tabId, {
    type: "ZAPSENDER_SEND_DIRECT",
    phone: message.phone,
    text: message.text || "",
    bridgeTimeoutMs: 90000
  }, 100000);

  return {
    ...response,
    tabId: tab.tabId
  };
}

async function sendAttachmentAndText(tabId, phone, reference, text, record) {
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
      }, 15000);
    }

    return request({
      type: "ZAPSENDER_MEDIA_COMMIT",
      transferId,
      phone,
      text,
      bridgeTimeoutMs: 240000
    }, 250000);
  });
  return {
    ...response,
    tabId
  };
}

async function prepareWhatsAppTab(focusTab = false) {
  const tab = await findWhatsAppTab();
  if (!tab?.id) {
    throw new Error("Abra o WhatsApp Web em uma aba antes de iniciar.");
  }

  if (tab.status !== "complete") await waitForTabLoaded(tab.id);
  if (focusTab) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }

  await ensureWhatsAppRuntime(tab.id);
  const engine = await getEngineStatus(tab.id);
  if (engine.status !== "ready") {
    return {
      status: "error",
      message: engine.message || "Motor interno do WhatsApp indisponivel.",
      fatal: true,
      code: engine.code || "engine_unavailable",
      tabId: tab.id
    };
  }

  return { status: "ready", tabId: tab.id };
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

async function ensureWhatsAppRuntime(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "ZAPSENDER_PING" });
    if (response?.status !== "ready" || response.version !== "1.3.0") {
      throw new Error("Content script desatualizado.");
    }
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "content/injected/wwebjs-utils.js",
        "content/injected/whatsapp-main.js"
      ],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/whatsapp-content.js"]
    });
  }
}

async function getEngineStatus(tabId) {
  const ping = () => sendContentRequest(tabId, {
    type: "ZAPSENDER_ENGINE_PING",
    bridgeTimeoutMs: 20000
  }, 25000);

  try {
    const result = await ping();
    if (result.status === "ready") return result;
  } catch (_error) {
    // Tenta reinjetar o motor abaixo.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "content/injected/wwebjs-utils.js",
      "content/injected/whatsapp-main.js"
    ],
    world: "MAIN"
  });
  return ping();
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
