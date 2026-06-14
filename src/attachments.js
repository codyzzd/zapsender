const DB_NAME = "zapsenderAttachments";
const DB_VERSION = 1;
const STORE_NAME = "files";

export const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = [
  "image/*",
  "video/*",
  "audio/*",
  ".pdf",
  ".txt",
  ".csv",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip"
].join(",");

const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "txt", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip"
]);
const MEDIA_EXTENSIONS = new Set([
  "aac", "avi", "flac", "gif", "jpeg", "jpg", "m4a", "mkv", "mov", "mp3",
  "mp4", "oga", "ogg", "opus", "png", "wav", "webm", "webp"
]);

export async function saveAttachment(file, audioMode = "file") {
  validateAttachmentFile(file);
  const id = createAttachmentId();
  const record = {
    id,
    blob: file,
    name: file.name,
    type: file.type || inferMimeType(file.name),
    size: file.size,
    lastModified: file.lastModified || Date.now(),
    createdAt: new Date().toISOString()
  };

  const db = await openDatabase();
  await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record));
  db.close();
  return createAttachmentReference(record, audioMode);
}

export async function getAttachment(id) {
  if (!id) return null;
  const db = await openDatabase();
  const record = await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
  db.close();
  return record || null;
}

export async function hasAttachment(id) {
  if (!id) return false;
  const db = await openDatabase();
  const key = await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getKey(id));
  db.close();
  return key !== undefined;
}

export async function deleteAttachment(id) {
  if (!id) return;
  const db = await openDatabase();
  await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id));
  db.close();
}

export async function deleteUnreferencedAttachments(referencedIds) {
  const keep = referencedIds instanceof Set ? referencedIds : new Set(referencedIds || []);
  const db = await openDatabase();
  const existingIds = await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys());
  const orphanIds = existingIds.filter((id) => !keep.has(id));
  if (orphanIds.length) {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    orphanIds.forEach((id) => store.delete(id));
    await transactionToPromise(transaction);
  }
  db.close();
  return orphanIds;
}

export function collectAttachmentIds(appState) {
  const ids = new Set();
  for (const campaign of appState?.campaigns || []) {
    if (campaign.attachment?.id) ids.add(campaign.attachment.id);
    for (const attachment of campaign.versionAttachments || []) {
      if (attachment?.id) ids.add(attachment.id);
    }
  }
  return ids;
}

export async function refreshAttachmentAvailability(appState) {
  const ids = [...collectAttachmentIds(appState)];
  const availability = new Map(await Promise.all(ids.map(async (id) => [id, await hasAttachment(id)])));
  return {
    ...appState,
    campaigns: (appState.campaigns || []).map((campaign) => ({
      ...campaign,
      attachment: setReferenceAvailability(campaign.attachment, availability),
      versionAttachments: (campaign.versionAttachments || []).map((attachment) => {
        return setReferenceAvailability(attachment, availability);
      })
    }))
  };
}

export function createAttachmentReference(record, audioMode = "file") {
  return {
    id: record.id,
    name: record.name,
    type: record.type || "",
    size: Number(record.size) || 0,
    audioMode: audioMode === "voice" ? "voice" : "file",
    available: true
  };
}

export function validateAttachmentFile(file) {
  if (!(file instanceof Blob) || !file.name) {
    throw new Error("Selecione um arquivo valido.");
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error("O arquivo excede o limite de 50 MB.");
  }
  if (!isSupportedAttachment(file)) {
    throw new Error("Tipo de arquivo nao suportado.");
  }
}

export function isAudioAttachment(reference) {
  return String(reference?.type || "").startsWith("audio/")
    || /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i.test(reference?.name || "");
}

export function formatAttachmentSize(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setReferenceAvailability(reference, availability) {
  if (!reference?.id) return null;
  return {
    ...reference,
    available: availability.get(reference.id) === true
  };
}

function isSupportedAttachment(file) {
  const type = String(file.type || "").toLowerCase();
  if (/^(image|video|audio)\//.test(type)) return true;
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  return DOCUMENT_EXTENSIONS.has(extension) || MEDIA_EXTENSIONS.has(extension);
}

function inferMimeType(name) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  const known = {
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/ogg"
  };
  return known[extension] || "application/octet-stream";
}

function createAttachmentId() {
  if (globalThis.crypto?.randomUUID) return `attachment-${crypto.randomUUID()}`;
  return `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Falha ao abrir armazenamento de anexos."));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Falha no armazenamento de anexos."));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Falha no armazenamento de anexos."));
    transaction.onabort = () => reject(transaction.error || new Error("Operacao de anexo cancelada."));
  });
}
