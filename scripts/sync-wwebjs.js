#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PINNED_REVISION = "2dc9466facb027caee19dbf285e0a2763f5373bb";
const revision = process.argv.includes("--latest") ? "main" : PINNED_REVISION;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceUrl = `https://raw.githubusercontent.com/wwebjs/whatsapp-web.js/${revision}/src/util/Injected/Utils.js`;
const licenseUrl = `https://raw.githubusercontent.com/wwebjs/whatsapp-web.js/${revision}/LICENSE`;

const [sourceResponse, licenseResponse] = await Promise.all([fetch(sourceUrl), fetch(licenseUrl)]);
if (!sourceResponse.ok) throw new Error(`Falha baixando Utils.js: HTTP ${sourceResponse.status}`);
if (!licenseResponse.ok) throw new Error(`Falha baixando LICENSE: HTTP ${licenseResponse.status}`);

const source = await sourceResponse.text();
const license = await licenseResponse.text();
const marker = "'use strict';\n\nexports.LoadUtils = () => {";
const replacement = `/*
 * Portions derived from whatsapp-web.js
 * Copyright 2019 Pedro S Lopez
 * Licensed under Apache-2.0. See third_party/WHATSAPP_WEB_JS_LICENSE.txt.
 * Source revision: ${revision}
 */
'use strict';

window.ZapsenderLoadWWebUtils = () => {`;
const converted = source.replace(marker, replacement);
if (converted === source) throw new Error("Assinatura exports.LoadUtils nao encontrada.");

await mkdir(path.join(root, "content", "injected"), { recursive: true });
await mkdir(path.join(root, "third_party"), { recursive: true });
await writeFile(path.join(root, "content", "injected", "wwebjs-utils.js"), converted);
await writeFile(path.join(root, "third_party", "WHATSAPP_WEB_JS_LICENSE.txt"), license);

const written = await readFile(path.join(root, "content", "injected", "wwebjs-utils.js"), "utf8");
console.log(`Utils.js sincronizado de ${revision}: ${written.split("\n").length} linhas.`);
console.log("Revise o diff e teste texto, imagem, video, documento e audio no WhatsApp Web.");
