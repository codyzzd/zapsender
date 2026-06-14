#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const scripts = [
  "service-worker.js",
  "panel.js",
  "content/whatsapp-content.js",
  "content/injected/whatsapp-main.js",
  "content/injected/wwebjs-utils.js",
  "src/attachments.js",
  "src/campaigns.js",
  "src/csv.js",
  "src/message.js",
  "src/phone.js",
  "src/queue.js",
  "src/storage.js"
];

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const manifestFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || [])
].filter(Boolean);
for (const file of manifestFiles) await access(file);

for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

console.log(`Manifest valido, ${manifestFiles.length} arquivos encontrados e ${scripts.length} scripts sem erros de sintaxe.`);
