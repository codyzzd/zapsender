const VALID_STATUSES = new Set(["pendente", "aberto", "enviado manualmente", "enviado automaticamente", "pulado", "erro"]);

export function now() {
  return new Date().toISOString();
}

export function sanitizeSettings(settings = {}) {
  const minInterval = Math.max(3, Number(settings.minInterval) || 20);
  const maxInterval = Math.max(minInterval, Number(settings.maxInterval) || 60);
  const mode = ["manual", "assistido", "auto"].includes(settings.mode) ? settings.mode : "auto";
  const focusWhatsAppTab = settings.focusWhatsAppTab === true;
  return { mode, minInterval, maxInterval, focusWhatsAppTab };
}

export function getCurrentContact(state) {
  return state.contacts[state.currentIndex] || null;
}

export function getNextRunnableIndex(state, startIndex = state.currentIndex) {
  return state.contacts.findIndex((contact, index) => {
    return index >= startIndex && contact.valid && ["pendente", "aberto"].includes(contact.status);
  });
}

export function getNextPendingIndex(state) {
  return state.contacts.findIndex((contact) => contact.valid && contact.status === "pendente");
}

export function setCurrentIndex(state, index) {
  if (index >= 0 && index < state.contacts.length) state.currentIndex = index;
  return state;
}

export function updateContactStatus(state, contactId, status, error = "") {
  if (!VALID_STATUSES.has(status)) throw new Error(`Status invalido: ${status}`);
  const contact = state.contacts.find((item) => item.id === contactId);
  if (!contact) throw new Error("Contato nao encontrado");

  const timestamp = now();
  contact.status = status;
  contact.lastActionAt = timestamp;
  contact.error = error;

  if (status === "aberto") contact.openedAt = timestamp;
  if (status === "enviado manualmente" || status === "enviado automaticamente") contact.sentAt = timestamp;
  if (status === "pulado") contact.skippedAt = timestamp;

  return contact;
}

export function resetProgress(state) {
  state.contacts = state.contacts.map((contact) => ({
    ...contact,
    status: contact.valid ? "pendente" : "erro",
    lastActionAt: null,
    openedAt: null,
    sentAt: null,
    skippedAt: null,
    error: contact.valid ? "" : contact.invalidReason || "Contato invalido"
  }));
  state.currentIndex = 0;
  return state;
}

export function getStats(contacts) {
  const stats = {
    total: contacts.length,
    pendentes: 0,
    abertos: 0,
    enviados: 0,
    pulados: 0,
    erros: 0
  };

  for (const contact of contacts) {
    if (contact.status === "pendente") stats.pendentes += 1;
    if (contact.status === "aberto") stats.abertos += 1;
    if (contact.status === "enviado manualmente" || contact.status === "enviado automaticamente") stats.enviados += 1;
    if (contact.status === "pulado") stats.pulados += 1;
    if (contact.status === "erro" || !contact.valid) stats.erros += 1;
  }

  return stats;
}

export function randomDelaySeconds(minInterval, maxInterval) {
  const min = Math.max(3, Number(minInterval) || 20);
  const max = Math.max(min, Number(maxInterval) || 60);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
