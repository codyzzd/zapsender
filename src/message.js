export function renderMessage(template, contact) {
  const values = {
    nome: contact?.name || "",
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
  const message = renderMessage(template, contact);
  const params = new URLSearchParams({
    phone: contact.phoneNormalized,
    type: "phone_number",
    app_absent: "0"
  });
  if (options.includeText !== false) params.set("text", message);
  return `https://web.whatsapp.com/send?${params.toString()}`;
}
