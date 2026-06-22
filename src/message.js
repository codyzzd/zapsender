export const NAME_FORMATS = {
  ORIGINAL: "original",
  REORDER_COMMA: "reorderComma",
  FIRST_AND_LAST: "firstAndLast",
  FIRST_ONLY: "firstOnly"
};

export const DEFAULT_NAME_FORMAT = NAME_FORMATS.ORIGINAL;

export function normalizeNameFormat(format) {
  return Object.values(NAME_FORMATS).includes(format) ? format : DEFAULT_NAME_FORMAT;
}

export function formatNameVariable(name, format = DEFAULT_NAME_FORMAT) {
  const normalizedName = String(name || "").replace(/\s+/g, " ").trim();
  const normalizedFormat = normalizeNameFormat(format);
  if (!normalizedName || normalizedFormat === NAME_FORMATS.ORIGINAL) return normalizedName;

  const reorderedName = reorderCommaName(normalizedName);
  if (normalizedFormat === NAME_FORMATS.REORDER_COMMA) return reorderedName;

  const parts = reorderedName.split(" ").filter(Boolean);
  if (!parts.length) return "";
  if (normalizedFormat === NAME_FORMATS.FIRST_ONLY) return parts[0];
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function reorderCommaName(name) {
  const commaIndex = name.indexOf(",");
  if (commaIndex === -1) return name;

  const beforeComma = name.slice(0, commaIndex).trim();
  const afterComma = name.slice(commaIndex + 1).trim();
  return [afterComma, beforeComma].filter(Boolean).join(" ");
}

export function renderMessage(template, contact, options = {}) {
  const values = {
    nome: formatNameVariable(contact?.name, options.nameFormat),
    telefone: contact?.phoneDisplay || contact?.phoneNormalized || ""
  };

  return String(template || "")
    .replace(/\{nome\}/g, values.nome)
    .replace(/\{telefone\}/g, values.telefone);
}

export function normalizeMessageTemplates(state) {
  const templates = Array.isArray(state?.messageTemplates) && state.messageTemplates.length
    ? state.messageTemplates
    : [state?.messageTemplate || ""];
  return templates.map((template) => String(template || ""));
}

export function getSelectedMessageTemplate(state) {
  const templates = normalizeMessageTemplates(state);
  const selectedIndex = Number.isInteger(Number(state?.selectedMessageIndex))
    ? Math.min(Math.max(Number(state.selectedMessageIndex), 0), templates.length - 1)
    : 0;
  return templates[selectedIndex] || templates[0] || "";
}

export function getRandomMessageTemplate(state) {
  const templates = normalizeMessageTemplates(state).filter((template) => template.trim());
  if (!templates.length) return "";
  return templates[Math.floor(Math.random() * templates.length)];
}

export function getRandomMessageSelection(state) {
  const templates = normalizeMessageTemplates(state);
  const candidateIndexes = templates
    .map((template, index) => ({ template, index }))
    .filter(({ template }) => template.trim());
  if (!candidateIndexes.length) return { index: 0, template: "" };
  return candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)];
}

export function buildWaLink(contact, template, options = {}) {
  const message = renderMessage(template, contact, options);
  const params = new URLSearchParams({
    phone: contact.phoneNormalized,
    type: "phone_number",
    app_absent: "0"
  });
  if (options.includeText !== false) params.set("text", message);
  return `https://web.whatsapp.com/send?${params.toString()}`;
}
