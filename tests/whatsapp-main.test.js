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

  const widFactory = {
    createWid(value) {
      const user = String(value).split("@")[0];
      return { user, server: "c.us", _serialized: `${user}@c.us` };
    }
  };
  const modules = {
    WAWebCollections: {
      Chat: {
        get: () => chat
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

  vm.runInNewContext(bridgeSource, {
    window,
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
