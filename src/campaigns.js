import { getStats, sanitizeSettings } from "./queue.js";
import { DEFAULT_NAME_FORMAT, normalizeMessageTemplates, normalizeNameFormat } from "./message.js";

export const STATUS_FILTERS = [
  { value: "all", label: "Todos" },
  { value: "pendente", label: "Pendentes" },
  { value: "aberto", label: "Abertos" },
  { value: "enviado", label: "Enviados" },
  { value: "erro", label: "Erros" },
  { value: "pulado", label: "Pulados" }
];

export const DERIVABLE_STATUSES = [
  { value: "pendente", label: "Pendentes" },
  { value: "aberto", label: "Abertos" },
  { value: "enviado automaticamente", label: "Sucesso auto" },
  { value: "enviado manualmente", label: "Sucesso manual" },
  { value: "erro", label: "Erros" },
  { value: "pulado", label: "Pulados" }
];

export const defaultCampaignSettings = {
  mode: "auto",
  minInterval: 20,
  maxInterval: 60,
  focusWhatsAppTab: false
};

export const ATTACHMENT_MODES = ["none", "campaign", "perVersion"];

export function createEmptyAppState() {
  const campaign = createCampaign({ name: "Disparo 1" }, []);
  return {
    version: 2,
    campaigns: [campaign],
    activeCampaignId: campaign.id,
    lastUpdated: null
  };
}

export function createCampaign(options = {}, contacts = []) {
  const timestamp = new Date().toISOString();
  const templates = Array.isArray(options.messageTemplates) && options.messageTemplates.length
    ? options.messageTemplates.map((template) => String(template || ""))
    : [String(options.messageTemplate || "Ola {nome}, tudo bem?")];
  const selectedMessageIndex = clampIndex(options.selectedMessageIndex, templates.length);

  return {
    id: options.id || createId("campaign"),
    name: normalizeCampaignName(options.name) || "Disparo",
    createdAt: options.createdAt || timestamp,
    updatedAt: options.updatedAt || timestamp,
    source: options.source || "manual",
    contacts: normalizeContacts(contacts),
    messageTemplate: templates[selectedMessageIndex] || templates[0] || "",
    messageTemplates: templates,
    selectedMessageIndex,
    nameFormat: normalizeNameFormat(options.nameFormat || DEFAULT_NAME_FORMAT),
    attachmentMode: normalizeAttachmentMode(options.attachmentMode),
    attachment: normalizeAttachmentReference(options.attachment),
    versionAttachments: normalizeVersionAttachments(options.versionAttachments, templates.length),
    settings: sanitizeSettings({
      ...defaultCampaignSettings,
      ...(options.settings || {})
    }),
    currentIndex: Number.isInteger(Number(options.currentIndex)) ? Number(options.currentIndex) : 0
  };
}

export function normalizeAppState(raw = {}) {
  if (Array.isArray(raw.campaigns)) return normalizeCampaignState(raw);
  if (Array.isArray(raw.contacts)) return migrateLegacyState(raw);
  return createEmptyAppState();
}

export function withCampaignStats(appState) {
  const campaigns = (appState.campaigns || []).map((campaign) => ({
    ...campaign,
    stats: getStats(campaign.contacts || [])
  }));
  const activeCampaignId = campaigns.some((campaign) => campaign.id === appState.activeCampaignId)
    ? appState.activeCampaignId
    : campaigns[0]?.id || null;

  return {
    ...appState,
    campaigns,
    activeCampaignId,
    activeStats: campaigns.find((campaign) => campaign.id === activeCampaignId)?.stats || getStats([])
  };
}

export function getActiveCampaign(appState) {
  return (appState.campaigns || []).find((campaign) => campaign.id === appState.activeCampaignId)
    || appState.campaigns?.[0]
    || null;
}

export function replaceActiveCampaign(appState, nextCampaign) {
  const campaigns = appState.campaigns.map((campaign) => {
    if (campaign.id !== nextCampaign.id) return campaign;
    return touchCampaign(nextCampaign);
  });
  return {
    ...appState,
    campaigns,
    activeCampaignId: nextCampaign.id
  };
}

export function addCampaign(appState, campaign) {
  const nextCampaign = touchCampaign(campaign);
  return {
    ...appState,
    campaigns: [...appState.campaigns, nextCampaign],
    activeCampaignId: nextCampaign.id
  };
}

export function deleteCampaign(appState, campaignId) {
  const currentCampaigns = appState.campaigns || [];
  const removedIndex = currentCampaigns.findIndex((campaign) => campaign.id === campaignId);
  if (removedIndex === -1) return ensureAtLeastOneCampaign(appState);

  const campaigns = currentCampaigns.filter((campaign) => campaign.id !== campaignId);
  if (!campaigns.length) {
    return ensureAtLeastOneCampaign({
      ...appState,
      campaigns: [],
      activeCampaignId: null
    });
  }

  const activeCampaignId = appState.activeCampaignId === campaignId
    ? campaigns[Math.min(removedIndex, campaigns.length - 1)].id
    : appState.activeCampaignId;

  return {
    ...appState,
    campaigns,
    activeCampaignId
  };
}

export function ensureAtLeastOneCampaign(appState) {
  if (Array.isArray(appState.campaigns) && appState.campaigns.length) {
    const activeCampaignId = appState.campaigns.some((campaign) => campaign.id === appState.activeCampaignId)
      ? appState.activeCampaignId
      : appState.campaigns[0].id;
    return {
      ...appState,
      activeCampaignId
    };
  }

  const campaign = createCampaign({
    name: getNextCampaignName(appState),
    source: "automatic-empty"
  }, []);
  return {
    ...appState,
    campaigns: [campaign],
    activeCampaignId: campaign.id
  };
}

export function renameCampaign(campaign, name, fallbackName) {
  return touchCampaign({
    ...campaign,
    name: normalizeCampaignName(name) || fallbackName || campaign.name
  });
}

export function removeContact(campaign, contactId) {
  const contacts = campaign.contacts.filter((contact) => contact.id !== contactId);
  const currentIndex = Math.min(campaign.currentIndex, Math.max(0, contacts.length - 1));
  return touchCampaign({ ...campaign, contacts, currentIndex });
}

export function duplicateCampaignByStatuses(appState, sourceCampaign, statuses, name) {
  const selectedStatuses = new Set(statuses);
  const contacts = (sourceCampaign.contacts || [])
    .filter((contact) => selectedStatuses.has(contact.status))
    .map((contact, index) => ({
      ...structuredClone(contact),
      id: `${Date.now()}-${index}-${contact.phoneNormalized || contact.phoneOriginal || index}`,
      status: "pendente",
      lastActionAt: null,
      openedAt: null,
      sentAt: null,
      skippedAt: null,
      error: contact.valid ? "" : contact.invalidReason || "Contato invalido"
    }));

  return createCampaign({
    name: normalizeCampaignName(name) || getNextCampaignName(appState),
    source: `derived:${sourceCampaign.id}`,
    messageTemplates: sourceCampaign.messageTemplates,
    selectedMessageIndex: sourceCampaign.selectedMessageIndex,
    nameFormat: sourceCampaign.nameFormat,
    attachmentMode: sourceCampaign.attachmentMode,
    attachment: sourceCampaign.attachment,
    versionAttachments: sourceCampaign.versionAttachments,
    settings: sourceCampaign.settings
  }, contacts);
}

export function filterContactsByStatus(contacts, filter) {
  if (!filter || filter === "all") return contacts;
  if (filter === "enviado") {
    return contacts.filter((contact) => contact.status === "enviado automaticamente" || contact.status === "enviado manualmente");
  }
  return contacts.filter((contact) => contact.status === filter);
}

export function getNextCampaignName(appState) {
  const existingNames = new Set((appState.campaigns || []).map((campaign) => campaign.name));
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `Disparo ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `Disparo ${Date.now()}`;
}

export function touchCampaign(campaign) {
  const templates = normalizeMessageTemplates(campaign);
  const selectedMessageIndex = clampIndex(campaign.selectedMessageIndex, templates.length);
  return {
    ...campaign,
    name: normalizeCampaignName(campaign.name) || "Disparo",
    contacts: normalizeContacts(campaign.contacts || []),
    messageTemplates: templates,
    selectedMessageIndex,
    messageTemplate: templates[selectedMessageIndex] || templates[0] || "",
    nameFormat: normalizeNameFormat(campaign.nameFormat),
    attachmentMode: normalizeAttachmentMode(campaign.attachmentMode),
    attachment: normalizeAttachmentReference(campaign.attachment),
    versionAttachments: normalizeVersionAttachments(campaign.versionAttachments, templates.length),
    settings: sanitizeSettings({
      ...defaultCampaignSettings,
      ...(campaign.settings || {})
    }),
    currentIndex: Math.min(Math.max(Number(campaign.currentIndex) || 0, 0), Math.max(0, (campaign.contacts || []).length - 1)),
    updatedAt: new Date().toISOString()
  };
}

function normalizeCampaignState(raw) {
  let campaigns = raw.campaigns
    .map((campaign, index) => normalizeCampaign(campaign, `Disparo ${index + 1}`))
    .filter(Boolean);

  if (!campaigns.length) campaigns = [createCampaign({ name: "Disparo 1" }, [])];
  const activeCampaignId = campaigns.some((campaign) => campaign.id === raw.activeCampaignId)
    ? raw.activeCampaignId
    : campaigns[0].id;

  return withCampaignStats({
    version: 2,
    campaigns,
    activeCampaignId,
    lastUpdated: raw.lastUpdated || null
  });
}

function migrateLegacyState(raw) {
  const campaign = createCampaign({
    id: raw.id || createId("campaign"),
    name: raw.name || "Disparo 1",
    source: "legacy-storage",
    createdAt: raw.createdAt,
    updatedAt: raw.lastUpdated,
    messageTemplate: raw.messageTemplate,
    messageTemplates: raw.messageTemplates,
    selectedMessageIndex: raw.selectedMessageIndex,
    nameFormat: raw.nameFormat,
    settings: raw.settings,
    currentIndex: raw.currentIndex
  }, raw.contacts || []);

  return withCampaignStats({
    version: 2,
    campaigns: [campaign],
    activeCampaignId: campaign.id,
    lastUpdated: raw.lastUpdated || null
  });
}

function normalizeCampaign(campaign, fallbackName) {
  if (!campaign || typeof campaign !== "object") return null;
  const createdAt = campaign.createdAt || campaign.updatedAt || new Date().toISOString();
  const contacts = normalizeContacts(campaign.contacts || []);
  const templates = normalizeMessageTemplates(campaign);
  const selectedMessageIndex = clampIndex(campaign.selectedMessageIndex, templates.length);

  return {
    id: campaign.id || createId("campaign"),
    name: normalizeCampaignName(campaign.name) || fallbackName,
    createdAt,
    updatedAt: campaign.updatedAt || createdAt,
    source: campaign.source || "manual",
    contacts,
    messageTemplate: templates[selectedMessageIndex] || templates[0] || "",
    messageTemplates: templates,
    selectedMessageIndex,
    nameFormat: normalizeNameFormat(campaign.nameFormat),
    attachmentMode: normalizeAttachmentMode(campaign.attachmentMode),
    attachment: normalizeAttachmentReference(campaign.attachment),
    versionAttachments: normalizeVersionAttachments(campaign.versionAttachments, templates.length),
    settings: sanitizeSettings({
      ...defaultCampaignSettings,
      ...(campaign.settings || {})
    }),
    currentIndex: Math.min(Math.max(Number(campaign.currentIndex) || 0, 0), Math.max(0, contacts.length - 1))
  };
}

function normalizeContacts(contacts) {
  return (Array.isArray(contacts) ? contacts : []).map((contact, index) => ({
    id: contact.id || `${Date.now()}-${index}-${contact.phoneNormalized || contact.phoneOriginal || index}`,
    name: contact.name || "",
    phoneOriginal: contact.phoneOriginal || contact.phoneDisplay || contact.phoneNormalized || "",
    phoneNormalized: contact.phoneNormalized || "",
    phoneDisplay: contact.phoneDisplay || contact.phoneNormalized || "",
    valid: Boolean(contact.valid),
    invalidReason: contact.invalidReason || "",
    status: contact.status || (contact.valid ? "pendente" : "erro"),
    lastActionAt: contact.lastActionAt || null,
    openedAt: contact.openedAt || null,
    sentAt: contact.sentAt || null,
    skippedAt: contact.skippedAt || null,
    error: contact.error || ""
  }));
}

function normalizeCampaignName(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

function normalizeAttachmentMode(mode) {
  return ATTACHMENT_MODES.includes(mode) ? mode : "none";
}

function normalizeAttachmentReference(reference) {
  if (!reference?.id) return null;
  return {
    id: String(reference.id),
    name: String(reference.name || "Anexo"),
    type: String(reference.type || ""),
    size: Math.max(0, Number(reference.size) || 0),
    audioMode: reference.audioMode === "voice" ? "voice" : "file",
    available: reference.available !== false
  };
}

function normalizeVersionAttachments(attachments, templateCount) {
  return Array.from({ length: templateCount }, (_, index) => {
    return normalizeAttachmentReference(Array.isArray(attachments) ? attachments[index] : null);
  });
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clampIndex(index, length) {
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0) return 0;
  return Math.min(numericIndex, Math.max(0, length - 1));
}
