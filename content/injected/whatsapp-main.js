/*
 * Zapsender bridge for WhatsApp Web's internal modules.
 * The WWebJS helper loaded before this file is derived from whatsapp-web.js
 * under Apache-2.0. See third_party/WHATSAPP_WEB_JS_LICENSE.txt.
 */
(() => {
  const ENGINE_VERSION = "1.3.0";
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

    if (payload.type === "ZAPSENDER_LIST_GROUPS") {
      return listGroups();
    }

    if (payload.type === "ZAPSENDER_EXPORT_GROUP_PARTICIPANTS") {
      return exportGroupParticipants(payload.groupId, payload.includeAdmins === true);
    }

    if (payload.type === "ZAPSENDER_EXPORT_OPEN_GROUP_PARTICIPANTS") {
      return exportOpenGroupParticipants();
    }

    if (payload.type === "ZAPSENDER_VALIDATE_PHONE") {
      return validatePhone(payload.phone);
    }

    if (payload.type === "ZAPSENDER_ADD_GROUP_PARTICIPANT") {
      return addGroupParticipant(payload.groupId, payload.phone);
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

  async function exportOpenGroupParticipants() {
    const visibleParticipants = collectParticipantPhonesFromDom();
    const chat = await resolveOpenChat();
    if (!chat) {
      if (visibleParticipants.length) {
        return {
          status: "ok",
          title: getVisibleChatTitle(),
          source: "dom",
          participants: visibleParticipants
        };
      }
      return {
        status: "error",
        message: "Abra o grupo no WhatsApp Web antes de buscar os numeros. Se ja estiver aberto, clique no cabecalho do grupo para mostrar os participantes e tente de novo.",
        code: "open_group_not_found"
      };
    }

    const model = await window.WWebJS.getChatModel(chat);
    if (!model?.isGroup || !model.groupMetadata) {
      if (visibleParticipants.length) {
        return {
          status: "ok",
          title: getVisibleChatTitle(),
          source: "dom",
          participants: visibleParticipants
        };
      }
      return {
        status: "error",
        message: "A conversa aberta nao parece ser um grupo.",
        code: "open_chat_not_group"
      };
    }

    const participants = (model.groupMetadata.participants || [])
      .map((participant) => {
        const id = participant?.id;
        const serialized = typeof id === "string"
          ? id
          : id?._serialized || id?.toString?.() || "";
        const phone = extractPhoneFromWid(serialized || participant?.phone || participant?.user);
        return phone ? { phone } : null;
      })
      .filter(Boolean);
    const participantMap = new Map();
    for (const participant of [...participants, ...visibleParticipants]) {
      participantMap.set(participant.phone, participant);
    }

    return {
      status: "ok",
      title: model.formattedTitle || model.name || "",
      source: visibleParticipants.length ? "mixed" : "internal",
      participants: [...participantMap.values()]
    };
  }

  async function listGroups() {
    const Chat = requireModule("WAWebCollections").Chat;
    const chats = typeof Chat.getModelsArray === "function" ? Chat.getModelsArray() : [];
    const groups = [];

    for (const chat of chats) {
      if (!chat?.groupMetadata) continue;
      try {
        const model = await window.WWebJS.getChatModel(chat);
        if (!model?.isGroup || !model.groupMetadata) continue;
        const participants = normalizeParticipants(model.groupMetadata.participants || [], true);
        groups.push({
          id: model.id?._serialized || chat.id?._serialized || chat.id?.toString?.() || "",
          title: model.formattedTitle || model.name || chat.formattedTitle || chat.name || "Grupo sem nome",
          participantCount: participants.length,
          adminCount: participants.filter((participant) => participant.isAdmin).length
        });
      } catch (_error) {
        // Um grupo com metadata quebrada nao deve impedir a lista inteira.
      }
    }

    groups.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    return {
      status: "ok",
      groups: groups.filter((group) => group.id)
    };
  }

  async function exportGroupParticipants(groupId, includeAdmins) {
    const chat = await findGroupChatById(groupId);
    if (!chat) {
      return {
        status: "error",
        message: "Grupo nao encontrado na aba atual do WhatsApp Web.",
        code: "group_not_found"
      };
    }

    const model = await window.WWebJS.getChatModel(chat);
    if (!model?.isGroup || !model.groupMetadata) {
      return {
        status: "error",
        message: "A conversa escolhida nao parece ser um grupo.",
        code: "selected_chat_not_group"
      };
    }

    const participants = normalizeParticipants(model.groupMetadata.participants || [], includeAdmins);
    return {
      status: "ok",
      title: model.formattedTitle || model.name || "",
      participants
    };
  }

  async function validatePhone(phone) {
    const target = await lookupPhone(phone);
    if (!target) {
      return {
        status: "ok",
        exists: false,
        message: "Numero nao encontrado no WhatsApp",
        phone: String(phone || "").replace(/\D/g, "")
      };
    }
    return {
      status: "ok",
      exists: true,
      phone: target.phone,
      wid: target.wid?._serialized || target.wid?.toString?.() || ""
    };
  }

  async function addGroupParticipant(groupId, phone) {
    const chat = await findGroupChatById(groupId);
    if (!chat) {
      return {
        status: "error",
        message: "Grupo nao encontrado na aba atual do WhatsApp Web.",
        code: "group_not_found"
      };
    }

    await refreshGroupMetadata(groupId);
    const model = await window.WWebJS.getChatModel(chat);
    if (!model?.isGroup || !model.groupMetadata) {
      return {
        status: "error",
        message: "A conversa escolhida nao parece ser um grupo.",
        code: "selected_chat_not_group"
      };
    }

    if (typeof chat.iAmAdmin === "function" && !chat.iAmAdmin()) {
      return {
        status: "not_authorized",
        message: "Sua conta nao tem permissao de admin para adicionar participantes neste grupo.",
        code: "i_am_not_admin"
      };
    }

    const target = await lookupPhone(phone);
    if (!target) {
      return {
        status: "not_found",
        message: "Numero nao encontrado no WhatsApp",
        code: "invalid_number"
      };
    }

    const participants = normalizeParticipants(model.groupMetadata.participants || [], true);
    if (participants.some((participant) => String(participant.phone || "") === String(target.phone || ""))) {
      return {
        status: "already_member",
        message: "Numero ja estava no grupo.",
        phone: target.phone
      };
    }

    if (typeof window.WWebJS?.getAddParticipantsRpcResult !== "function") {
      throw requestError("Funcao interna de adicionar participante nao esta disponivel.", "add_participant_unavailable");
    }

    const WidFactory = requireModule("WAWebWidFactory");
    const groupWid = WidFactory.createWid(groupId);
    const participantWid = await resolveParticipantWidForGroup(model, target);
    const result = await window.WWebJS.getAddParticipantsRpcResult(groupWid, participantWid);
    return mapAddParticipantResult(result, target.phone);
  }

  async function refreshGroupMetadata(groupId) {
    try {
      const query = safeRequire("WAWebGroupQueryJob");
      if (typeof query?.queryAndUpdateGroupMetadataById === "function") {
        await query.queryAndUpdateGroupMetadataById({ id: groupId });
      }
    } catch (_error) {
      // Metadata stale nao deve impedir a tentativa de adicionar.
    }
  }

  async function resolveParticipantWidForGroup(model, target) {
    const useLid = model?.groupMetadata?.isLidAddressingMode === true;
    if (!useLid || typeof window.WWebJS?.enforceLidAndPnRetrieval !== "function") return target.wid;

    try {
      const serialized = target.wid?._serialized || target.wid?.toString?.() || "";
      const resolved = await window.WWebJS.enforceLidAndPnRetrieval(serialized);
      return resolved?.lid || target.wid;
    } catch (_error) {
      return target.wid;
    }
  }

  function mapAddParticipantResult(result, phone) {
    const code = Number(result?.code);
    if (code === 200) {
      return {
        status: "added",
        message: "Participante adicionado ao grupo.",
        phone
      };
    }
    if (result?.inviteV4Code) {
      return {
        status: "needs_invite",
        message: "WhatsApp nao permitiu adicionar direto; precisa convite.",
        phone,
        inviteCode: result.inviteV4Code,
        inviteExpiresAt: result.inviteV4CodeExp || ""
      };
    }
    if (code === 401 || code === 403) {
      if (code === 403) {
        return {
          status: "needs_invite",
          message: "O WhatsApp so permite adicionar este participante enviando convite privado.",
          phone,
          code: "403"
        };
      }
      return {
        status: "not_authorized",
        message: "Sua conta nao esta autorizada a adicionar este participante.",
        phone,
        code: String(code)
      };
    }
    if (code === 404) {
      return {
        status: "not_found",
        message: "Participante nao encontrado pelo WhatsApp.",
        phone,
        code: "404"
      };
    }
    if (code === 409) {
      return {
        status: "already_member",
        message: "WhatsApp indicou conflito; o numero pode ja estar no grupo.",
        phone,
        code: "409"
      };
    }
    if (code === 408 || code === 429) {
      return {
        status: "error",
        message: "WhatsApp bloqueou temporariamente a adicao. Tente novamente mais tarde.",
        phone,
        code: String(code)
      };
    }
    if (code === 417) {
      return {
        status: "needs_invite",
        message: "Este participante nao pode ser adicionado diretamente a este grupo/comunidade. Use convite.",
        phone,
        code: "417"
      };
    }
    if (code === 419) {
      return {
        status: "error",
        message: "O grupo esta cheio e nao aceita novos participantes.",
        phone,
        code: "419"
      };
    }
    if (code === 400) {
      return {
        status: "error",
        message: result?.errorMessage
          ? `WhatsApp recusou a adicao: ${result.errorMessage}`
          : "WhatsApp recusou a adicao. Pode ser permissao do grupo, privacidade do contato ou identificador interno incompatível.",
        phone,
        code: "400"
      };
    }
    return {
      status: "error",
      message: `WhatsApp recusou a adicao${Number.isFinite(code) ? ` (codigo ${code})` : ""}.`,
      phone,
      code: Number.isFinite(code) ? String(code) : "unknown_add_result"
    };
  }

  async function findGroupChatById(groupId) {
    const id = String(groupId || "");
    if (!id) return null;

    if (typeof window.WWebJS?.getChat === "function") {
      try {
        const chat = await window.WWebJS.getChat(id, { getAsModel: false });
        if (chat?.groupMetadata) return chat;
      } catch (_error) {
        // Tenta colecao abaixo.
      }
    }

    const Chat = requireModule("WAWebCollections").Chat;
    const chats = typeof Chat.getModelsArray === "function" ? Chat.getModelsArray() : [];
    return chats.find((chat) => {
      const serialized = chat.id?._serialized || chat.id?.toString?.() || "";
      return serialized === id && chat.groupMetadata;
    }) || null;
  }

  function normalizeParticipants(rawParticipants, includeAdmins) {
    const byPhone = new Map();
    for (const participant of rawParticipants) {
      const phone = extractParticipantPhone(participant);
      if (!phone) continue;
      const isAdmin = isGroupAdmin(participant);
      if (isAdmin && !includeAdmins) continue;
      byPhone.set(phone, { phone, isAdmin });
    }
    return [...byPhone.values()];
  }

  function extractParticipantPhone(participant) {
    const id = participant?.id;
    const serialized = typeof id === "string"
      ? id
      : id?._serialized || id?.user || id?.toString?.() || "";
    return extractPhoneFromWid(
      serialized ||
      participant?.phoneNumber ||
      participant?.phone ||
      participant?.user ||
      participant?.jid
    );
  }

  function isGroupAdmin(participant) {
    return participant?.isAdmin === true ||
      participant?.isSuperAdmin === true ||
      participant?.admin === "admin" ||
      participant?.admin === "superadmin" ||
      participant?.rank === "admin" ||
      participant?.rank === "superadmin";
  }

  async function resolveOpenChat() {
    const Chat = requireModule("WAWebCollections").Chat;
    const directCandidates = [
      callMaybe(Chat, "getActive"),
      callMaybe(Chat, "getActiveChat"),
      Chat.active,
      Chat._active,
      Chat.activeChat,
      Chat.selected,
      Chat._selected
    ].filter(Boolean);

    let fallbackChat = null;
    for (const candidate of directCandidates) {
      try {
        const chat = await unwrapChat(candidate);
        if (chat?.groupMetadata) return chat;
        if (chat && !fallbackChat) fallbackChat = chat;
      } catch (_error) {
        // Continua tentando outras formas de descobrir a conversa visivel.
      }
    }

    const visibleTitle = getVisibleChatTitle();
    const chats = typeof Chat.getModelsArray === "function" ? Chat.getModelsArray() : [];
    if (visibleTitle && chats.length) {
      const normalizedVisible = normalizeTitle(visibleTitle);
      const matches = chats.filter((chat) => {
        if (!chat?.groupMetadata) return false;
        return chatTitleCandidates(chat).some((title) => normalizeTitle(title) === normalizedVisible);
      });
      if (matches.length === 1) return matches[0];
    }

    return fallbackChat;
  }

  function callMaybe(target, method) {
    try {
      return typeof target?.[method] === "function" ? target[method]() : null;
    } catch (_error) {
      return null;
    }
  }

  async function unwrapChat(candidate) {
    const value = typeof candidate?.then === "function" ? await candidate : candidate;
    return value?.chat || value?.model || value || null;
  }

  function getVisibleChatTitle() {
    const selectors = [
      "#main header span[title]",
      "#main header [title]",
      "#main header span[dir='auto']",
      "main header span[title]",
      "main header [title]",
      "main header span[dir='auto']",
      "header span[title]",
      "[data-testid='conversation-info-header'] span[title]",
      "[data-testid='conversation-header'] span[title]"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const title = element?.getAttribute("title") || element?.textContent || "";
      if (title.trim()) return title.trim();
    }
    return "";
  }

  function collectParticipantPhonesFromDom() {
    const values = new Set();
    const selectors = [
      "[data-testid='group-info-drawer']",
      "[data-testid='chat-info-drawer']",
      "[aria-label*='Group info']",
      "[aria-label*='Dados do grupo']",
      "[aria-label*='Informacoes do grupo']",
      "aside",
      "#main"
    ];
    const roots = selectors
      .map((selector) => document.querySelector(selector))
      .filter(Boolean);
    if (!roots.length && document.body) roots.push(document.body);

    for (const root of roots) {
      collectPhoneText(root.textContent, values);
      for (const element of root.querySelectorAll("[title], [aria-label]")) {
        collectPhoneText(element.getAttribute("title"), values);
        collectPhoneText(element.getAttribute("aria-label"), values);
      }
    }

    return [...values].map((phone) => ({ phone }));
  }

  function collectPhoneText(text, values) {
    const source = String(text || "");
    const matches = source.match(/(?:\+?\d[\s().-]*){10,16}/g) || [];
    for (const match of matches) {
      const phone = match.replace(/\D/g, "");
      if (phone.length >= 10 && phone.length <= 15) values.add(phone);
    }
  }

  function chatTitleCandidates(chat) {
    return [
      chat.formattedTitle,
      chat.name,
      chat.title,
      chat.contact?.formattedName,
      chat.contact?.name,
      chat.contact?.pushname
    ].filter(Boolean);
  }

  function normalizeTitle(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function extractPhoneFromWid(value) {
    const text = String(value || "");
    const user = text.includes("@") ? text.split("@")[0] : text;
    const digits = user.replace(/\D/g, "");
    return digits.length >= 10 ? digits : "";
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
      const target = await lookupPhone(rawPhone);
      if (!target) return null;
      const chat = await findOrCreateChat(target.wid);
      if (!chat) {
        throw requestError("O WhatsApp confirmou o numero, mas nao abriu o chat interno.", "chat_unavailable");
      }
      return {
        chat,
        phone: target.phone
      };
    } catch (error) {
      if (isEngineError(error)) {
        error.fatal = true;
        error.code = "engine_lookup_failed";
      }
      throw error;
    }
  }

  async function lookupPhone(rawPhone) {
    try {
      const digits = String(rawPhone || "").replace(/\D/g, "");
      if (!digits) return null;

      const WidFactory = requireModule("WAWebWidFactory");
      const queryWidExists = requireModule("WAWebQueryExistsJob").queryWidExists;
      const requestedWid = WidFactory.createWid(`${digits}@c.us`);
      const queryResult = await queryWidExists(requestedWid);
      if (!queryResult?.wid) return null;

      return {
        wid: queryResult.wid,
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
