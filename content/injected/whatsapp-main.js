/*
 * Zapsender bridge for WhatsApp Web's internal modules.
 * The WWebJS helper loaded before this file is derived from whatsapp-web.js
 * under Apache-2.0. See third_party/WHATSAPP_WEB_JS_LICENSE.txt.
 */
(() => {
  const ENGINE_VERSION = "1.2.0";
  const REQUEST_SOURCE = "zapsender-content";
  const RESPONSE_SOURCE = "zapsender-main";
  const transfers = new Map();

  if (window.__zapsenderMainVersion === ENGINE_VERSION) return;
  window.__zapsenderMainVersion = ENGINE_VERSION;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== REQUEST_SOURCE) return;
    const { requestId, payload } = event.data;
    if (!requestId || !payload) return;

    handleRequest(payload)
      .then((result) => respond(requestId, result))
      .catch((error) => respond(requestId, {
        status: "error",
        message: error?.message || "Falha no motor interno do WhatsApp.",
        detail: error?.stack || "",
        code: error?.code || "internal_error",
        fatal: error?.fatal === true
      }));
  });

  async function handleRequest(payload) {
    clearExpiredTransfers();

    if (payload.type === "ZAPSENDER_ENGINE_PING") {
      try {
        await ensureEngine(15000);
        return { status: "ready", version: ENGINE_VERSION };
      } catch (error) {
        return {
          status: "error",
          message: error.message,
          code: error.code || "engine_unavailable",
          fatal: true
        };
      }
    }

    await ensureEngine(30000);

    if (payload.type === "ZAPSENDER_MEDIA_START") {
      transfers.set(payload.transferId, {
        metadata: payload.metadata || {},
        chunks: [],
        updatedAt: Date.now()
      });
      return { status: "ready" };
    }

    if (payload.type === "ZAPSENDER_MEDIA_CHUNK") {
      const transfer = transfers.get(payload.transferId);
      if (!transfer) throw requestError("Transferencia de anexo nao encontrada.", "transfer_missing");
      transfer.chunks[Number(payload.index) || 0] = String(payload.data || "");
      transfer.updatedAt = Date.now();
      return { status: "received" };
    }

    if (payload.type === "ZAPSENDER_SEND_DIRECT") {
      return sendDirect(payload.phone, payload.text || "");
    }

    if (payload.type === "ZAPSENDER_MEDIA_COMMIT") {
      try {
        return await sendMediaAndText(
          payload.transferId,
          payload.phone,
          payload.text || ""
        );
      } finally {
        transfers.delete(payload.transferId);
      }
    }

    throw requestError("Comando desconhecido no motor do WhatsApp.", "unknown_command");
  }

  async function ensureEngine(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        if (typeof window.require !== "function") {
          throw new Error("Carregador de modulos do WhatsApp ainda nao esta disponivel.");
        }
        if (typeof window.ZapsenderLoadWWebUtils !== "function") {
          throw new Error("Biblioteca interna de envio nao foi carregada.");
        }
        if (typeof window.WWebJS?.sendMessage !== "function") {
          window.ZapsenderLoadWWebUtils();
          installFileBridge();
        }

        requireModule("WAWebCollections");
        requireModule("WAWebWidFactory");
        requireModule("WAWebQueryExistsJob");
        requireModule("WAWebSendMsgChatAction");
        return;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }

    const error = requestError(
      `Motor interno do WhatsApp indisponivel: ${lastError?.message || "timeout"}`,
      "engine_unavailable"
    );
    error.fatal = true;
    throw error;
  }

  function installFileBridge() {
    if (window.WWebJS.__zapsenderFileBridgeInstalled) return;
    const originalMediaInfoToFile = window.WWebJS.mediaInfoToFile;
    window.WWebJS.mediaInfoToFile = (mediaInfo) => {
      if (mediaInfo?.__zapsenderFile instanceof File) return mediaInfo.__zapsenderFile;
      return originalMediaInfoToFile(mediaInfo);
    };
    window.WWebJS.__zapsenderFileBridgeInstalled = true;
  }

  async function sendDirect(phone, text) {
    const target = await resolveTarget(phone);
    if (!target) return invalidNumberResult(phone);
    if (!String(text).trim()) {
      return {
        status: "error",
        message: "A mensagem esta vazia.",
        code: "empty_message"
      };
    }

    const message = await sendMessage(target.chat, String(text), {
      waitUntilMsgSent: true
    });
    return {
      status: "sent",
      message: "Mensagem enviada automaticamente",
      messageId: getMessageId(message),
      phone: target.phone
    };
  }

  async function sendMediaAndText(transferId, phone, text) {
    const transfer = transfers.get(transferId);
    if (!transfer) throw requestError("Transferencia de anexo expirada.", "transfer_missing");

    const target = await resolveTarget(phone);
    if (!target) return invalidNumberResult(phone);

    const file = chunksToFile(transfer.chunks, transfer.metadata);
    const media = {
      __zapsenderFile: file,
      data: "",
      mimetype: file.type || transfer.metadata.type || "application/octet-stream",
      filename: file.name,
      filesize: file.size
    };
    const voiceRequested = transfer.metadata.audioMode === "voice";
    let voiceFallback = false;
    let mediaMessage;

    try {
      mediaMessage = await sendMessage(target.chat, "", mediaOptions(media, voiceRequested));
    } catch (error) {
      if (!voiceRequested) throw error;
      voiceFallback = true;
      mediaMessage = await sendMessage(target.chat, "", mediaOptions(media, false));
    }

    if (String(text).trim()) {
      try {
        const textMessage = await sendMessage(target.chat, String(text), {
          waitUntilMsgSent: true
        });
        return {
          status: "sent",
          message: voiceFallback
            ? "Anexo e texto enviados. O audio usou o fallback de arquivo."
            : "Anexo e texto enviados automaticamente",
          attachmentSent: true,
          voiceFallback,
          mediaMessageId: getMessageId(mediaMessage),
          messageId: getMessageId(textMessage),
          phone: target.phone
        };
      } catch (error) {
        return {
          status: "partial",
          message: "Anexo enviado, mas o texto falhou",
          detail: error?.message || "Falha desconhecida",
          code: "text_after_media_failed",
          attachmentSent: true,
          voiceFallback,
          mediaMessageId: getMessageId(mediaMessage),
          phone: target.phone
        };
      }
    }

    return {
      status: "sent",
      message: voiceFallback
        ? "Anexo enviado. O audio usou o fallback de arquivo."
        : "Anexo enviado automaticamente",
      attachmentSent: true,
      voiceFallback,
      mediaMessageId: getMessageId(mediaMessage),
      phone: target.phone
    };
  }

  function mediaOptions(media, sendAsVoice) {
    const type = String(media.mimetype || "").toLowerCase();
    return {
      media,
      caption: undefined,
      sendMediaAsSticker: false,
      sendAudioAsVoice: sendAsVoice,
      sendMediaAsDocument: !/^(image|video|audio)\//.test(type),
      waitUntilMsgSent: true
    };
  }

  async function resolveTarget(rawPhone) {
    try {
      const digits = String(rawPhone || "").replace(/\D/g, "");
      if (!digits) return null;

      const WidFactory = requireModule("WAWebWidFactory");
      const queryWidExists = requireModule("WAWebQueryExistsJob").queryWidExists;
      const requestedWid = WidFactory.createWid(`${digits}@c.us`);
      const queryResult = await queryWidExists(requestedWid);
      if (!queryResult?.wid) return null;

      const chat = await findOrCreateChat(queryResult.wid);
      if (!chat) {
        throw requestError("O WhatsApp confirmou o numero, mas nao abriu o chat interno.", "chat_unavailable");
      }
      return {
        chat,
        phone: queryResult.wid.user || digits
      };
    } catch (error) {
      if (isEngineError(error)) {
        error.fatal = true;
        error.code = "engine_lookup_failed";
      }
      throw error;
    }
  }

  async function findOrCreateChat(wid) {
    const Chat = requireModule("WAWebCollections").Chat;
    let chat = Chat.get(wid);
    if (chat) return chat;

    const findChatModule = safeRequire("WAWebFindChatAction");
    if (typeof findChatModule?.findOrCreateLatestChat === "function") {
      const result = await findChatModule.findOrCreateLatestChat(wid);
      chat = result?.chat || result;
    }
    if (!chat && typeof Chat.find === "function") {
      chat = await Chat.find(wid);
    }
    return chat || null;
  }

  async function sendMessage(chat, content, options) {
    try {
      return await window.WWebJS.sendMessage(chat, content, options);
    } catch (error) {
      if (isEngineError(error)) {
        error.fatal = true;
        error.code = "engine_send_failed";
      }
      throw error;
    }
  }

  function chunksToFile(chunks, metadata) {
    if (!chunks.length || chunks.some((chunk) => !chunk)) {
      throw requestError("A transferencia do anexo ficou incompleta.", "transfer_incomplete");
    }
    const parts = chunks.map((chunk) => base64ToBytes(chunk));
    const type = metadata.type || "application/octet-stream";
    const file = new File(parts, metadata.name || "anexo", {
      type,
      lastModified: Date.now()
    });
    const expectedSize = Number(metadata.size) || 0;
    if (expectedSize && file.size !== expectedSize) {
      throw requestError("O tamanho recebido do anexo nao confere.", "transfer_size_mismatch");
    }
    if (file.size > 50 * 1024 * 1024) {
      throw requestError("O arquivo excede o limite de 50 MB.", "attachment_too_large");
    }
    return file;
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function invalidNumberResult(phone) {
    return {
      status: "error",
      message: "Numero nao encontrado no WhatsApp",
      detail: String(phone || ""),
      code: "invalid_number"
    };
  }

  function getMessageId(message) {
    const id = message?.id;
    if (!id) return "";
    if (typeof id === "string") return id;
    return id._serialized || id.toString?.() || "";
  }

  function requireModule(name) {
    const module = window.require(name);
    if (!module) throw new Error(`Modulo ${name} nao encontrado.`);
    return module;
  }

  function safeRequire(name) {
    try {
      return window.require(name);
    } catch (_error) {
      return null;
    }
  }

  function isEngineError(error) {
    const message = String(error?.message || error || "");
    return /module|window\.require|is not a function|undefined|null|webpack/i.test(message);
  }

  function requestError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function clearExpiredTransfers() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [transferId, transfer] of transfers) {
      if ((transfer.updatedAt || 0) < cutoff) transfers.delete(transferId);
    }
  }

  function respond(requestId, result) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      requestId,
      result
    }, "*");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
