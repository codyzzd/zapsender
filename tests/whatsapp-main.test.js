import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = await readFile(new URL("../content/injected/whatsapp-main.js", import.meta.url), "utf8");

function createHarness(options = {}) {
  let messageListener = null;
  let requestSequence = 0;
  const responseWaiters = new Map();
  const sendCalls = [];
  const chat = { id: "chat-1" };
  const activeChat = options.activeChat || null;
  const chats = options.chats || (activeChat ? [activeChat] : []);

  const widFactory = {
    createWid(value) {
      const user = String(value).split("@")[0];
      return { user, server: "c.us", _serialized: `${user}@c.us` };
    }
  };
  const modules = {
    WAWebCollections: {
      Chat: {
        get: () => chat,
        getActive: () => activeChat,
        getModelsArray: () => chats
      }
    },
    WAWebWidFactory: widFactory,
    WAWebQueryExistsJob: {
      queryWidExists: Object.hasOwn(options, "queryWidExists")
        ? options.queryWidExists
        : async (wid) => (options.validNumber === false ? null : { wid })
    },
    WAWebSendMsgChatAction: {}
  };

  const window = {
    WWebJS: {
      mediaInfoToFile: () => null,
      async getChat(chatId) {
        return chats.find((item) => item.id?._serialized === chatId) || null;
      },
      async getChatModel(modelChat) {
        return modelChat.serialize ? modelChat.serialize() : modelChat;
      },
      async sendMessage(targetChat, content, sendOptions) {
        sendCalls.push({ chat: targetChat, content, options: sendOptions });
        if (options.failText && !sendOptions.media) throw new Error("text send failed");
        return { id: { _serialized: `message-${sendCalls.length}` } };
      }
    },
    ZapsenderLoadWWebUtils() {},
    addEventListener(type, listener) {
      if (type === "message") messageListener = listener;
    },
    postMessage(message) {
      if (message?.source !== "zapsender-main") return;
      const resolve = responseWaiters.get(message.requestId);
      if (!resolve) return;
      responseWaiters.delete(message.requestId);
      resolve(message.result);
    },
    require(name) {
      if (!(name in modules)) throw new Error(`module ${name} missing`);
      return modules[name];
    }
  };
  const document = {
    querySelector() {
      return null;
    }
  };

  vm.runInNewContext(bridgeSource, {
    window,
    document,
    File,
    Blob,
    Uint8Array,
    atob,
    setTimeout,
    clearTimeout,
    console
  });

  return {
    sendCalls,
    request(payload) {
      const requestId = `test-${requestSequence += 1}`;
      return new Promise((resolve) => {
        responseWaiters.set(requestId, resolve);
        messageListener({
          source: window,
          data: {
            source: "zapsender-content",
            requestId,
            payload
          }
        });
      });
    }
  };
}

test("envia texto diretamente para numero registrado", async () => {
  const harness = createHarness();
  const result = await harness.request({
    type: "ZAPSENDER_SEND_DIRECT",
    phone: "55 (11) 99999-0000",
    text: "Ola"
  });

  assert.equal(result.status, "sent");
  assert.equal(harness.sendCalls.length, 1);
  assert.equal(harness.sendCalls[0].content, "Ola");
  assert.equal(harness.sendCalls[0].options.waitUntilMsgSent, true);
});

test("numero inexistente nao tenta enviar", async () => {
  const harness = createHarness({ validNumber: false });
  const result = await harness.request({
    type: "ZAPSENDER_SEND_DIRECT",
    phone: "5511999990000",
    text: "Ola"
  });

  assert.equal(result.status, "error");
  assert.equal(result.code, "invalid_number");
  assert.equal(harness.sendCalls.length, 0);
});

test("imagem e enviada como midia normal antes do texto separado", async () => {
  const harness = createHarness();
  const bytes = Buffer.from("image-bytes");
  const transferId = "image-transfer";

  await harness.request({
    type: "ZAPSENDER_MEDIA_START",
    transferId,
    metadata: {
      name: "foto.png",
      type: "image/png",
      size: bytes.length,
      audioMode: "file"
    }
  });
  await harness.request({
    type: "ZAPSENDER_MEDIA_CHUNK",
    transferId,
    index: 0,
    data: bytes.subarray(0, 5).toString("base64")
  });
  await harness.request({
    type: "ZAPSENDER_MEDIA_CHUNK",
    transferId,
    index: 1,
    data: bytes.subarray(5).toString("base64")
  });
  const result = await harness.request({
    type: "ZAPSENDER_MEDIA_COMMIT",
    transferId,
    phone: "5511999990000",
    text: "Legenda separada"
  });

  assert.equal(result.status, "sent");
  assert.equal(harness.sendCalls.length, 2);
  assert.equal(harness.sendCalls[0].content, "");
  assert.equal(harness.sendCalls[0].options.sendMediaAsSticker, false);
  assert.equal(harness.sendCalls[0].options.sendMediaAsDocument, false);
  assert.equal(harness.sendCalls[0].options.media.__zapsenderFile.name, "foto.png");
  assert.equal(harness.sendCalls[0].options.media.__zapsenderFile.size, bytes.length);
  assert.equal(harness.sendCalls[1].content, "Legenda separada");
});

test("documento usa modo de documento", async () => {
  const harness = createHarness();
  const bytes = Buffer.from("pdf");
  const transferId = "document-transfer";

  await harness.request({
    type: "ZAPSENDER_MEDIA_START",
    transferId,
    metadata: {
      name: "arquivo.pdf",
      type: "application/pdf",
      size: bytes.length
    }
  });
  await harness.request({
    type: "ZAPSENDER_MEDIA_CHUNK",
    transferId,
    index: 0,
    data: bytes.toString("base64")
  });
  const result = await harness.request({
    type: "ZAPSENDER_MEDIA_COMMIT",
    transferId,
    phone: "5511999990000",
    text: ""
  });

  assert.equal(result.status, "sent");
  assert.equal(harness.sendCalls[0].options.sendMediaAsDocument, true);
});

test("falha no texto depois da midia retorna erro parcial", async () => {
  const harness = createHarness({ failText: true });
  const bytes = Buffer.from("video");
  const transferId = "partial-transfer";

  await harness.request({
    type: "ZAPSENDER_MEDIA_START",
    transferId,
    metadata: {
      name: "video.mp4",
      type: "video/mp4",
      size: bytes.length
    }
  });
  await harness.request({
    type: "ZAPSENDER_MEDIA_CHUNK",
    transferId,
    index: 0,
    data: bytes.toString("base64")
  });
  const result = await harness.request({
    type: "ZAPSENDER_MEDIA_COMMIT",
    transferId,
    phone: "5511999990000",
    text: "Texto"
  });

  assert.equal(result.status, "partial");
  assert.equal(result.attachmentSent, true);
  assert.equal(result.code, "text_after_media_failed");
});

test("quebra da consulta interna e classificada como fatal", async () => {
  const harness = createHarness({ queryWidExists: null });
  const result = await harness.request({
    type: "ZAPSENDER_SEND_DIRECT",
    phone: "5511999990000",
    text: "Ola"
  });

  assert.equal(result.status, "error");
  assert.equal(result.fatal, true);
  assert.equal(result.code, "engine_lookup_failed");
});

test("exporta numeros do grupo aberto", async () => {
  const harness = createHarness({
    activeChat: {
      serialize() {
        return {
          isGroup: true,
          formattedTitle: "Grupo teste",
          groupMetadata: {
            participants: [
              { id: { _serialized: "5511999990000@c.us" } },
              { id: "5585999998888@c.us" },
              { id: "12345@lid" }
            ]
          }
        };
      }
    }
  });
  const result = await harness.request({
    type: "ZAPSENDER_EXPORT_OPEN_GROUP_PARTICIPANTS"
  });

  assert.equal(result.status, "ok");
  assert.equal(
    result.participants.map((participant) => participant.phone).join(","),
    "5511999990000,5585999998888"
  );
});

test("lista grupos disponiveis no WhatsApp Web", async () => {
  const harness = createHarness({
    chats: [
      {
        id: { _serialized: "grupo-b@g.us" },
        groupMetadata: {},
        serialize() {
          return {
            id: { _serialized: "grupo-b@g.us" },
            isGroup: true,
            formattedTitle: "B Grupo",
            groupMetadata: {
              participants: [
                { id: "5511999990000@c.us", isAdmin: true },
                { id: "5585999998888@c.us" }
              ]
            }
          };
        }
      },
      {
        id: { _serialized: "grupo-a@g.us" },
        groupMetadata: {},
        serialize() {
          return {
            id: { _serialized: "grupo-a@g.us" },
            isGroup: true,
            formattedTitle: "A Grupo",
            groupMetadata: {
              participants: [
                { id: "5585888887777@c.us" }
              ]
            }
          };
        }
      }
    ]
  });
  const result = await harness.request({ type: "ZAPSENDER_LIST_GROUPS" });

  assert.equal(result.status, "ok");
  assert.equal(result.groups.map((group) => group.title).join(","), "A Grupo,B Grupo");
  assert.equal(result.groups.find((group) => group.title === "B Grupo").adminCount, 1);
});

test("exporta grupo escolhido sem admins quando solicitado", async () => {
  const harness = createHarness({
    chats: [
      {
        id: { _serialized: "grupo@g.us" },
        groupMetadata: {},
        serialize() {
          return {
            id: { _serialized: "grupo@g.us" },
            isGroup: true,
            formattedTitle: "Grupo escolhido",
            groupMetadata: {
              participants: [
                { id: "5511999990000@c.us", isAdmin: true },
                { id: "5585999998888@c.us" },
                { id: "5585888887777@c.us", admin: "superadmin" }
              ]
            }
          };
        }
      }
    ]
  });
  const result = await harness.request({
    type: "ZAPSENDER_EXPORT_GROUP_PARTICIPANTS",
    groupId: "grupo@g.us",
    includeAdmins: false
  });

  assert.equal(result.status, "ok");
  assert.equal(result.participants.map((participant) => participant.phone).join(","), "5585999998888");
});
