import { parseCsv, contactsToReportCsv } from "./src/csv.js";
import { addCampaign, createCampaign, deleteCampaign, duplicateCampaignByStatuses, filterContactsByStatus, getActiveCampaign, getNextCampaignName, removeContact, renameCampaign, replaceActiveCampaign, withCampaignStats } from "./src/campaigns.js";
import { ATTACHMENT_ACCEPT, collectAttachmentIds, deleteUnreferencedAttachments, formatAttachmentSize, isAudioAttachment, refreshAttachmentAvailability, saveAttachment } from "./src/attachments.js";
import { buildWaLink, getRandomMessageSelection, getSelectedMessageTemplate, normalizeMessageTemplates, renderMessage } from "./src/message.js";
import { getCurrentContact, getNextPendingIndex, getNextRunnableIndex, randomDelaySeconds, resetProgress, sanitizeSettings, setCurrentIndex, updateContactStatus } from "./src/queue.js";
import { loadState, normalizeStoredState, saveState } from "./src/storage.js";

const els = {
  newCampaignBtn: document.querySelector("#new-campaign-btn"),
  exportBackupBtn: document.querySelector("#export-backup-btn"),
  importBackupFile: document.querySelector("#import-backup-file"),
  campaignList: document.querySelector("#campaign-list"),
  campaignCount: document.querySelector("#campaign-count"),
  activeCampaignTitle: document.querySelector("#active-campaign-title"),
  campaignName: document.querySelector("#campaign-name"),
  saveCampaignNameBtn: document.querySelector("#save-campaign-name-btn"),
  mode: document.querySelector("#mode"),
  csvFile: document.querySelector("#csv-file"),
  csvText: document.querySelector("#csv-text"),
  previewImportBtn: document.querySelector("#preview-import-btn"),
  importBtn: document.querySelector("#import-btn"),
  importErrors: document.querySelector("#import-errors"),
  normalizationPanel: document.querySelector("#normalization-panel"),
  normalizationSummary: document.querySelector("#normalization-summary"),
  normalizationTable: document.querySelector("#normalization-table"),
  messageVersions: document.querySelector("#message-versions"),
  attachmentMode: document.querySelector("#attachment-mode"),
  campaignAttachmentEditor: document.querySelector("#campaign-attachment-editor"),
  addMessageBtn: document.querySelector("#add-message-btn"),
  charCount: document.querySelector("#char-count"),
  messagePreview: document.querySelector("#message-preview"),
  currentContactLabel: document.querySelector("#current-contact-label"),
  currentPhone: document.querySelector("#current-phone"),
  currentMessage: document.querySelector("#current-message"),
  copyPhone: document.querySelector("#copy-phone"),
  copyMessage: document.querySelector("#copy-message"),
  minInterval: document.querySelector("#min-interval"),
  maxInterval: document.querySelector("#max-interval"),
  focusWhatsappTab: document.querySelector("#focus-whatsapp-tab"),
  autoStatus: document.querySelector("#auto-status"),
  checkWhatsappBtn: document.querySelector("#check-whatsapp-btn"),
  sendProgress: document.querySelector("#send-progress"),
  sendProgressStatus: document.querySelector("#send-progress-status"),
  sendProgressPercent: document.querySelector("#send-progress-percent"),
  sendProgressCount: document.querySelector("#send-progress-count"),
  sendProgressTrack: document.querySelector("#send-progress-track"),
  sendProgressBar: document.querySelector("#send-progress-bar"),
  sendProgressEstimate: document.querySelector("#send-progress-estimate"),
  sendProgressFinish: document.querySelector("#send-progress-finish"),
  playBtn: document.querySelector("#play-btn"),
  pauseBtn: document.querySelector("#pause-btn"),
  openNextBtn: document.querySelector("#open-next-btn"),
  skipBtn: document.querySelector("#skip-btn"),
  sentBtn: document.querySelector("#sent-btn"),
  resetBtn: document.querySelector("#reset-btn"),
  confirmReset: document.querySelector("#confirm-reset"),
  resetModal: document.querySelector("#reset-modal"),
  contactsTable: document.querySelector("#contacts-table"),
  contactStatusFilter: document.querySelector("#contact-status-filter"),
  countdown: document.querySelector("#countdown"),
  readyAlert: document.querySelector("#ready-alert"),
  exportReportBtn: document.querySelector("#export-report-btn"),
  exportSuccessBtn: document.querySelector("#export-success-btn"),
  campaignModal: document.querySelector("#campaign-modal"),
  newCampaignName: document.querySelector("#new-campaign-name"),
  copyCampaignOptions: document.querySelector("#copy-campaign-options"),
  sourceCampaignSelect: document.querySelector("#source-campaign-select"),
  confirmCreateCampaign: document.querySelector("#confirm-create-campaign")
};

let state = null;
let playing = false;
let busy = false;
let countdownTimer = null;
let countdownRemaining = 0;
let pendingImportContacts = [];
let previewTimer = null;
let sendSession = null;
let workerPort = null;
let workerRequestSequence = 0;
const pendingWorkerRequests = new Map();

const ESTIMATED_SEND_MIN_SECONDS = 8;
const ESTIMATED_SEND_MAX_SECONDS = 20;

function activeCampaign() {
  return getActiveCampaign(state);
}

function setActiveCampaign(campaign) {
  state = replaceActiveCampaign(state, campaign);
}

function statusClass(status) {
  if (status === "enviado automaticamente") return "badge-enviado";
  if (status === "enviado manualmente") return "badge-enviado";
  if (status === "aberto") return "badge-aberto";
  if (status === "pulado") return "badge-pulado";
  if (status === "erro") return "badge-erro";
  return "badge-pendente";
}

function currentContact() {
  const campaign = activeCampaign();
  return campaign ? getCurrentContact(campaign) : null;
}

function messageTemplates() {
  return normalizeMessageTemplates(activeCampaign());
}

function selectedMessageIndex() {
  const campaign = activeCampaign();
  const templates = messageTemplates();
  const index = Number(campaign?.selectedMessageIndex) || 0;
  return Math.min(Math.max(index, 0), templates.length - 1);
}

function selectedMessageTemplate() {
  return getSelectedMessageTemplate(activeCampaign());
}

function setReadyAlert(visible, message = "Conversa pronta no WhatsApp Web.", type = "success") {
  els.readyAlert.hidden = !visible;
  els.readyAlert.textContent = message;
  els.readyAlert.classList.toggle("ready-alert-error", type === "error");
  if (visible && type !== "error") playTone();
}

function playTone() {
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.26);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.28);
  } catch (_error) {
    // Audio pode ser bloqueado antes de uma interacao do usuario.
  }
}

async function persist(nextState = state) {
  state = await saveState(nextState);
  deleteUnreferencedAttachments(collectAttachmentIds(state)).catch((error) => {
    console.warn("Falha ao limpar anexos sem referencia", error);
  });
  render();
}

function render() {
  if (!state) return;
  state = withCampaignStats(state);
  const campaign = activeCampaign();
  if (!campaign) return;

  els.activeCampaignTitle.textContent = campaign.name;
  els.campaignName.value = campaign.name;
  els.mode.value = campaign.settings.mode;
  els.minInterval.value = campaign.settings.minInterval;
  els.maxInterval.value = campaign.settings.maxInterval;
  els.focusWhatsappTab.checked = campaign.settings.focusWhatsAppTab;
  els.attachmentMode.value = campaign.attachmentMode || "none";
  els.playBtn.textContent = campaign.settings.mode === "auto" ? "Iniciar envio automatico" : "Play";
  renderCampaignList();
  renderCampaignAttachment();
  renderMessageCards();
  updateStats();
  updateSendProgress();
  updateCurrentPanel();
  updateTable();
  updateBusyState();
}

function renderCampaignList() {
  els.campaignCount.textContent = String(state.campaigns?.length || 0);
  const cards = (state.campaigns || []).map((campaign) => {
    const stats = campaign.stats || {};
    const article = document.createElement("article");
    article.className = `campaign-card${campaign.id === state.activeCampaignId ? " selected" : ""}`;
    article.innerHTML = `
      <div class="campaign-card-main">
        <strong class="campaign-card-title">${escapeHtml(campaign.name)}</strong>
        <small>${formatDate(campaign.updatedAt || campaign.createdAt)}</small>
      </div>
      <div class="campaign-stats">
        <span>${stats.total || 0} total</span>
        <span>${stats.enviados || 0} enviados</span>
        <span>${stats.erros || 0} erros</span>
        <span>${stats.pendentes || 0} pendentes</span>
      </div>
      <div class="campaign-actions">
        <button type="button" data-rename>Renomear</button>
        <button type="button" class="danger" data-delete>Excluir</button>
      </div>
    `;
    article.querySelector(".campaign-card-main").addEventListener("click", async () => {
      if (campaign.id === state.activeCampaignId) return;
      playing = false;
      clearCountdown();
      state.activeCampaignId = campaign.id;
      await persist(state);
      setReadyAlert(false);
    });
    article.querySelector("[data-rename]").addEventListener("click", async () => {
      const name = prompt("Novo nome da campanha", campaign.name);
      if (name === null) return;
      const renamed = renameCampaign(campaign, name, campaign.name);
      state = {
        ...state,
        campaigns: state.campaigns.map((item) => item.id === campaign.id ? renamed : item)
      };
      await persist(state);
    });
    article.querySelector("[data-delete]").addEventListener("click", async () => {
      const confirmed = confirm(`Excluir a campanha "${campaign.name}"? Esta acao remove a lista e o historico deste disparo.`);
      if (!confirmed) return;
      playing = false;
      clearCountdown();
      state = deleteCampaign(state, campaign.id);
      await persist(state);
      setReadyAlert(true, "Campanha excluida.");
    });
    return article;
  });

  els.campaignList.replaceChildren(...cards);
}

function updateBusyState() {
  els.playBtn.disabled = busy || playing;
  els.openNextBtn.disabled = busy;
  els.pauseBtn.disabled = !playing;
  els.checkWhatsappBtn.disabled = busy;
  els.newCampaignBtn.disabled = busy;
}

function updateStats() {
  const stats = activeCampaign()?.stats || {};
  document.querySelector("#stat-total").textContent = stats.total || 0;
  document.querySelector("#stat-pending").textContent = stats.pendentes || 0;
  document.querySelector("#stat-open").textContent = stats.abertos || 0;
  document.querySelector("#stat-sent").textContent = stats.enviados || 0;
  document.querySelector("#stat-skipped").textContent = stats.pulados || 0;
  document.querySelector("#stat-errors").textContent = stats.erros || 0;
}

function runnableContacts(campaign = activeCampaign()) {
  return (campaign?.contacts || []).filter((contact) => {
    return contact.valid && ["pendente", "aberto"].includes(contact.status);
  });
}

function createSendSession() {
  const remaining = runnableContacts().length;
  sendSession = {
    campaignId: activeCampaign()?.id,
    initialRemaining: remaining,
    completed: 0,
    activeStartedAt: Date.now(),
    activeElapsedMs: 0
  };
}

function activeSessionElapsedMs() {
  if (!sendSession) return 0;
  return sendSession.activeElapsedMs + (sendSession.activeStartedAt ? Date.now() - sendSession.activeStartedAt : 0);
}

function pauseSendSession() {
  if (!sendSession?.activeStartedAt) return;
  sendSession.activeElapsedMs += Date.now() - sendSession.activeStartedAt;
  sendSession.activeStartedAt = null;
}

function recordSendAttempt() {
  if (!sendSession || sendSession.campaignId !== activeCampaign()?.id) return;
  sendSession.completed += 1;
}

function estimateRemainingSeconds(remaining, settings) {
  if (remaining <= 0) return { min: 0, max: 0 };

  const waits = Math.max(0, remaining - 1);
  if (sendSession?.completed > 0 && sendSession.campaignId === activeCampaign()?.id) {
    const observedPerContact = activeSessionElapsedMs() / 1000 / sendSession.completed;
    const adjustedPerContact = Math.max(ESTIMATED_SEND_MIN_SECONDS, observedPerContact);
    return {
      min: Math.round(remaining * adjustedPerContact * 0.85),
      max: Math.round(remaining * adjustedPerContact * 1.2)
    };
  }

  return {
    min: remaining * ESTIMATED_SEND_MIN_SECONDS + waits * settings.minInterval,
    max: remaining * ESTIMATED_SEND_MAX_SECONDS + waits * settings.maxInterval
  };
}

function updateSendProgress() {
  const campaign = activeCampaign();
  if (!campaign) return;

  const settings = sanitizeSettings(campaign.settings);
  const remaining = runnableContacts(campaign).length;
  const sessionMatches = sendSession?.campaignId === campaign.id;
  const total = sessionMatches ? sendSession.initialRemaining : remaining;
  const completed = sessionMatches ? Math.min(sendSession.completed, total) : 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const estimate = estimateRemainingSeconds(remaining, settings);
  const complete = sessionMatches && total > 0 && remaining === 0;

  els.sendProgress.classList.toggle("is-running", playing && remaining > 0);
  els.sendProgress.classList.toggle("is-complete", complete);
  els.sendProgressStatus.textContent = complete
    ? "Envio concluido"
    : playing
      ? "Enviando agora"
      : sessionMatches && completed > 0
        ? "Envio pausado"
        : "Estimativa antes do envio";
  els.sendProgressPercent.textContent = `${complete ? 100 : percent}%`;
  els.sendProgressCount.textContent = sessionMatches
    ? `${completed} de ${total} concluidos`
    : `${remaining} contato${remaining === 1 ? "" : "s"} para enviar`;
  els.sendProgressBar.style.width = `${complete ? 100 : percent}%`;
  els.sendProgressTrack.setAttribute("aria-valuenow", String(complete ? 100 : percent));

  if (remaining === 0) {
    els.sendProgressEstimate.textContent = campaign.contacts.length
      ? "Nenhum contato pendente ou aberto."
      : "Adicione contatos para calcular o tempo.";
    els.sendProgressFinish.textContent = complete ? `Finalizado as ${formatTime(new Date())}` : "";
    return;
  }

  els.sendProgressEstimate.textContent = sessionMatches && completed > 0
    ? `Tempo restante estimado: ${formatDurationRange(estimate.min, estimate.max)}`
    : `Previsao total: ${formatDurationRange(estimate.min, estimate.max)}`;
  els.sendProgressFinish.textContent = `Termino provavel: ${formatFinishRange(estimate.min, estimate.max)}`;
}

function formatDuration(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.ceil((rounded % 3600) / 60);
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}min`;
}

function formatDurationRange(minSeconds, maxSeconds) {
  const min = formatDuration(minSeconds);
  const max = formatDuration(maxSeconds);
  return min === max ? min : `${min} a ${max}`;
}

function formatTime(date) {
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatFinishRange(minSeconds, maxSeconds) {
  const now = Date.now();
  const min = formatTime(new Date(now + minSeconds * 1000));
  const max = formatTime(new Date(now + maxSeconds * 1000));
  return min === max ? min : `${min} a ${max}`;
}

function updateCurrentPanel() {
  const contact = currentContact();
  const messageTemplate = selectedMessageTemplate();
  const message = renderMessage(messageTemplate, contact);
  els.charCount.textContent = String(messageTemplate || "").length;
  els.messagePreview.textContent = message || "-";
  els.currentMessage.textContent = message || "-";
  els.currentPhone.textContent = contact?.phoneDisplay || contact?.phoneNormalized || "-";
  els.currentContactLabel.textContent = contact
    ? `${contact.name || "Sem nome"} - ${contact.status}`
    : "Nenhum contato selecionado.";
}

function updateTable() {
  const campaign = activeCampaign();
  const filter = els.contactStatusFilter.value || "all";
  const rows = filterContactsByStatus(campaign?.contacts || [], filter).map((contact) => {
    const index = campaign.contacts.findIndex((item) => item.id === contact.id);
    const tr = document.createElement("tr");
    if (index === campaign.currentIndex) tr.classList.add("selected");
    tr.dataset.index = String(index);
    tr.innerHTML = `
      <td>${escapeHtml(contact.name || "-")}</td>
      <td>${escapeHtml(contact.phoneOriginal || "-")}</td>
      <td>${escapeHtml(contact.phoneDisplay || contact.phoneNormalized || "-")}</td>
      <td><span class="badge ${statusClass(contact.status)}">${escapeHtml(contact.status)}</span>${contact.error ? `<br><small>${escapeHtml(contact.error)}</small>` : ""}</td>
      <td>${contact.lastActionAt ? new Date(contact.lastActionAt).toLocaleString("pt-BR") : "-"}</td>
      <td><button type="button" class="danger compact-action" data-remove="${escapeHtml(contact.id)}">Remover</button></td>
    `;
    tr.addEventListener("click", async (event) => {
      if (event.target.closest("button")) return;
      const nextCampaign = { ...activeCampaign() };
      setCurrentIndex(nextCampaign, index);
      setActiveCampaign(nextCampaign);
      await persist(state);
    });
    tr.querySelector("[data-remove]").addEventListener("click", async () => {
      const confirmed = confirm(`Remover ${contact.name || contact.phoneDisplay || "contato"} desta campanha?`);
      if (!confirmed) return;
      setActiveCampaign(removeContact(activeCampaign(), contact.id));
      await persist(state);
    });
    return tr;
  });

  els.contactsTable.replaceChildren(...rows);
}

function renderMessageCards() {
  const campaign = activeCampaign();
  const templates = messageTemplates();
  const selectedIndex = selectedMessageIndex();
  const cards = templates.map((template, index) => {
    const card = document.createElement("article");
    card.className = `message-card${index === selectedIndex ? " selected" : ""}`;
    card.innerHTML = `
      <div class="message-card-header">
        <label class="message-card-title">
          <input type="radio" name="selected-message" ${index === selectedIndex ? "checked" : ""}>
          Versao ${index + 1}
        </label>
        <button type="button" class="danger" ${templates.length === 1 ? "disabled" : ""}>Remover</button>
      </div>
      <textarea placeholder="Digite a mensagem desta versao"></textarea>
      <div class="version-attachment"></div>
    `;

    const radio = card.querySelector('input[type="radio"]');
    const textarea = card.querySelector("textarea");
    const removeButton = card.querySelector("button");
    const attachmentContainer = card.querySelector(".version-attachment");

    textarea.value = template;
    textarea.addEventListener("input", () => {
      const nextCampaign = { ...activeCampaign(), messageTemplates: [...messageTemplates()] };
      nextCampaign.messageTemplates[index] = textarea.value;
      if (index === selectedMessageIndex()) nextCampaign.messageTemplate = textarea.value;
      setActiveCampaign(nextCampaign);
      updateCurrentPanel();
    });
    textarea.addEventListener("blur", saveMessages);

    radio.addEventListener("change", async () => {
      setActiveCampaign({
        ...activeCampaign(),
        selectedMessageIndex: index,
        messageTemplate: campaign.messageTemplates[index] || ""
      });
      await persist(state);
    });

    removeButton.addEventListener("click", async () => {
      const nextTemplates = messageTemplates();
      const nextAttachments = [...(activeCampaign().versionAttachments || [])];
      nextTemplates.splice(index, 1);
      nextAttachments.splice(index, 1);
      const nextIndex = Math.min(selectedMessageIndex(), nextTemplates.length - 1);
      setActiveCampaign({
        ...activeCampaign(),
        messageTemplates: nextTemplates,
        versionAttachments: nextAttachments,
        selectedMessageIndex: nextIndex,
        messageTemplate: nextTemplates[nextIndex] || ""
      });
      await persist(state);
    });

    if (campaign.attachmentMode === "perVersion") {
      attachmentContainer.append(createAttachmentEditor({
        reference: campaign.versionAttachments?.[index] || null,
        label: `Anexo da versao ${index + 1}`,
        onChange: async (reference) => {
          const versionAttachments = [...(activeCampaign().versionAttachments || [])];
          while (versionAttachments.length < messageTemplates().length) versionAttachments.push(null);
          versionAttachments[index] = reference;
          setActiveCampaign({ ...activeCampaign(), versionAttachments });
          await persist(state);
        }
      }));
    } else {
      attachmentContainer.hidden = true;
    }

    return card;
  });

  els.messageVersions.replaceChildren(...cards);
}

function renderCampaignAttachment() {
  const campaign = activeCampaign();
  els.campaignAttachmentEditor.replaceChildren();
  els.campaignAttachmentEditor.hidden = campaign.attachmentMode !== "campaign";
  if (campaign.attachmentMode !== "campaign") return;

  els.campaignAttachmentEditor.append(createAttachmentEditor({
    reference: campaign.attachment,
    label: "Anexo usado com qualquer versao sorteada",
    onChange: async (reference) => {
      setActiveCampaign({ ...activeCampaign(), attachment: reference });
      await persist(state);
    }
  }));
}

function createAttachmentEditor({ reference, label, onChange }) {
  const wrapper = document.createElement("div");
  wrapper.className = `attachment-editor${reference?.available === false ? " is-missing" : ""}`;

  const info = document.createElement("div");
  info.className = "attachment-info";
  if (reference) {
    info.innerHTML = `
      <strong>${escapeHtml(reference.name)}</strong>
      <small>${escapeHtml(reference.type || "tipo desconhecido")} - ${formatAttachmentSize(reference.size)}</small>
      ${reference.available === false ? "<span>Arquivo ausente. Selecione novamente apos restaurar o backup.</span>" : ""}
    `;
  } else {
    info.innerHTML = `<strong>${escapeHtml(label)}</strong><small>Nenhum arquivo selecionado.</small>`;
  }

  const controls = document.createElement("div");
  controls.className = "attachment-actions";
  const fileLabel = document.createElement("label");
  fileLabel.className = "button-file";
  fileLabel.textContent = reference ? "Substituir" : "Selecionar arquivo";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ATTACHMENT_ACCEPT;
  fileLabel.append(fileInput);
  controls.append(fileLabel);

  if (reference && isAudioAttachment(reference)) {
    const audioMode = document.createElement("select");
    audioMode.className = "audio-mode";
    audioMode.setAttribute("aria-label", "Tipo de envio do audio");
    audioMode.innerHTML = `
      <option value="file">Arquivo de audio</option>
      <option value="voice">Voz experimental (fallback para arquivo)</option>
    `;
    audioMode.value = reference.audioMode === "voice" ? "voice" : "file";
    audioMode.addEventListener("change", () => onChange({ ...reference, audioMode: audioMode.value }));
    controls.prepend(audioMode);
  }

  if (reference) {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger";
    removeButton.textContent = "Remover";
    removeButton.addEventListener("click", () => onChange(null));
    controls.append(removeButton);
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.disabled = true;
    try {
      const nextReference = await saveAttachment(file, reference?.audioMode || "file");
      await onChange(nextReference);
      setReadyAlert(true, `Anexo "${file.name}" salvo nesta campanha.`);
    } catch (error) {
      setReadyAlert(true, error.message, "error");
      fileInput.disabled = false;
      fileInput.value = "";
    }
  });

  wrapper.append(info, controls);
  return wrapper;
}

function renderNormalizationPreview(contacts = []) {
  pendingImportContacts = contacts;
  els.importBtn.disabled = contacts.filter((contact) => contact.valid).length === 0;
  els.normalizationPanel.hidden = contacts.length === 0;

  const validCount = contacts.filter((contact) => contact.valid).length;
  const invalidCount = contacts.length - validCount;
  els.normalizationSummary.textContent = `${validCount} validos - ${invalidCount} invalidos`;

  const rows = contacts.map((contact) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(contact.name || "-")}</td>
      <td>${escapeHtml(contact.phoneOriginal || "-")}</td>
      <td>${escapeHtml(contact.phoneDisplay || contact.phoneNormalized || "-")}</td>
      <td><span class="badge ${contact.valid ? "badge-pendente" : "badge-erro"}">${contact.valid ? "valido" : "erro"}</span>${contact.invalidReason ? `<br><small>${escapeHtml(contact.invalidReason)}</small>` : ""}</td>
    `;
    return tr;
  });

  els.normalizationTable.replaceChildren(...rows);
}

function previewCsv() {
  const csvText = els.csvText.value.trim();
  if (!csvText) {
    renderImportErrors([]);
    renderNormalizationPreview([]);
    return;
  }

  const preview = parseCsv(csvText);
  renderImportErrors(preview.errors || []);
  renderNormalizationPreview(preview.contacts || []);
}

function schedulePreviewCsv() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => previewCsv(), 350);
}

function renderImportErrors(errors = []) {
  if (!errors.length) {
    els.importErrors.hidden = true;
    els.importErrors.textContent = "";
    return;
  }
  els.importErrors.hidden = false;
  els.importErrors.textContent = errors.join("\n");
}

async function saveSettings() {
  setActiveCampaign({
    ...activeCampaign(),
    settings: sanitizeSettings({
      mode: els.mode.value,
      minInterval: els.minInterval.value,
      maxInterval: els.maxInterval.value,
      focusWhatsAppTab: els.focusWhatsappTab.checked
    })
  });
  await persist(state);
}

async function saveMessages() {
  const templates = messageTemplates();
  const selectedIndex = selectedMessageIndex();
  setActiveCampaign({
    ...activeCampaign(),
    messageTemplates: templates,
    selectedMessageIndex: selectedIndex,
    messageTemplate: templates[selectedIndex] || templates[0] || ""
  });
  await persist(state);
}

async function openNext() {
  if (busy) return;
  busy = true;
  let proceedImmediately = false;
  updateBusyState();
  setReadyAlert(false);

  try {
    let campaign = activeCampaign();
    campaign.settings = sanitizeSettings(campaign.settings);
    const autoMode = campaign.settings.mode === "auto";
    const index = autoMode ? getNextPendingIndex(campaign) : getNextRunnableIndex(campaign);

    if (index === -1) {
      playing = false;
      pauseSendSession();
      clearCountdown();
      setReadyAlert(true, "Nenhum contato pendente ou aberto valido na campanha.", "error");
      return;
    }

    campaign = { ...campaign, currentIndex: index };
    const contact = campaign.contacts[index];
    const selection = autoMode
      ? getRandomMessageSelection(campaign)
      : { index: selectedMessageIndex(), template: getSelectedMessageTemplate(campaign) };
    const renderedText = renderMessage(selection.template, contact);
    const attachment = resolveAttachmentForSelection(campaign, selection.index);
    const waLink = buildWaLink(contact, selection.template, { includeText: !autoMode || !attachment });

    if (campaign.settings.mode === "manual") {
      setActiveCampaign(campaign);
      await persist(state);
      return;
    }

    const focusTab = campaign.settings.focusWhatsAppTab;
    const openResult = autoMode
      ? await sendWhatsAppMessage(waLink, focusTab, renderedText, attachment)
      : await openWhatsAppUrl(waLink, focusTab);
    if (autoMode && openResult.status === "sent") {
      updateContactStatus(campaign, contact.id, "enviado automaticamente");
    } else if (autoMode) {
      const errorDetail = openResult.status === "partial"
        ? `${openResult.message}: ${openResult.detail || "falha ao enviar o texto"}`
        : openResult.detail || openResult.message || "Falha no envio automatico";
      updateContactStatus(campaign, contact.id, "erro", errorDetail);
    } else {
      updateContactStatus(campaign, contact.id, "aberto");
    }
    if (autoMode) recordSendAttempt();

    if (autoMode) campaign.currentIndex = Math.min(index + 1, Math.max(0, campaign.contacts.length - 1));
    setActiveCampaign(campaign);
    await persist(state);

    if (autoMode) {
      const hasNextContact = runnableContacts(campaign).length > 0;
      if (openResult.status === "sent") {
        setReadyAlert(true, openResult.message || "Mensagem enviada automaticamente.");
        if (playing && hasNextContact) await startCountdownThenOpen();
      } else {
        setReadyAlert(true, openResult.message || "Falha no envio automatico.", "error");
        proceedImmediately = playing && hasNextContact;
      }

      if (playing && !hasNextContact) {
        playing = false;
        pauseSendSession();
        updateSendProgress();
      }
      return;
    }

    setReadyAlert(true, "Conversa aberta no WhatsApp Web. Envie manualmente e marque como enviado.");
  } catch (error) {
    playing = false;
    pauseSendSession();
    clearCountdown();
    setReadyAlert(true, error.message, "error");
  } finally {
    busy = false;
    updateBusyState();
    if (proceedImmediately && playing) {
      setTimeout(() => {
        if (playing) openNext();
      }, 0);
    }
  }
}

function sendWhatsAppMessage(url, focusTab, text = "", attachment = null) {
  return sendWorkerRequest({ type: "SEND_WHATSAPP_MESSAGE", url, focusTab, text, attachment }, 120000);
}

function resolveAttachmentForSelection(campaign, messageIndex) {
  if (campaign.attachmentMode === "campaign") return campaign.attachment || null;
  if (campaign.attachmentMode === "perVersion") return campaign.versionAttachments?.[messageIndex] || null;
  return null;
}

function openWhatsAppUrl(url, focusTab) {
  return sendWorkerRequest({ type: "OPEN_WHATSAPP_URL", url, focusTab }, 45000);
}

function checkWhatsAppTab() {
  return sendWorkerRequest({ type: "CHECK_WHATSAPP_TAB" }, 10000);
}

function sendWorkerRequest(payload, timeoutMs) {
  const port = getWorkerPort();
  const requestId = `request-${Date.now()}-${workerRequestSequence += 1}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingWorkerRequests.delete(requestId);
      reject(new Error("A extensao demorou demais para responder. Recarregue a extensao e tente novamente."));
    }, timeoutMs);

    pendingWorkerRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    try {
      port.postMessage({ type: "WORKER_REQUEST", requestId, payload });
    } catch (error) {
      clearTimeout(timeout);
      pendingWorkerRequests.delete(requestId);
      reject(error);
    }
  });
}

function getWorkerPort() {
  if (workerPort) return workerPort;
  workerPort = chrome.runtime.connect({ name: "zapsender-worker" });
  workerPort.onMessage.addListener((message) => {
    if (message?.type !== "WORKER_RESPONSE") return;
    const pending = pendingWorkerRequests.get(message.requestId);
    if (!pending) return;
    pendingWorkerRequests.delete(message.requestId);
    pending.resolve(message.result);
  });
  workerPort.onDisconnect.addListener(() => {
    const runtimeMessage = chrome.runtime.lastError?.message || "A conexao com a extensao foi interrompida.";
    workerPort = null;
    for (const [requestId, pending] of pendingWorkerRequests) {
      pendingWorkerRequests.delete(requestId);
      pending.reject(new Error(runtimeMessage));
    }
  });
  return workerPort;
}

function clearCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownRemaining = 0;
  els.countdown.hidden = true;
  els.countdown.textContent = "";
  updateSendProgress();
}

async function startCountdownThenOpen() {
  clearCountdown();
  const settings = sanitizeSettings(activeCampaign().settings);
  countdownRemaining = randomDelaySeconds(settings.minInterval, settings.maxInterval);
  els.countdown.hidden = false;
  els.countdown.textContent = `Proximo envio em ${countdownRemaining}s`;

  countdownTimer = setInterval(async () => {
    countdownRemaining -= 1;
    els.countdown.textContent = `Proximo envio em ${countdownRemaining}s`;
    updateSendProgress();
    if (countdownRemaining <= 0) {
      clearCountdown();
      if (playing) await openNext();
    }
  }, 1000);
}

async function markSent() {
  const campaign = { ...activeCampaign() };
  const contact = getCurrentContact(campaign);
  if (!contact) return;
  updateContactStatus(campaign, contact.id, "enviado manualmente");
  const contactIndex = campaign.contacts.findIndex((item) => item.id === contact.id);
  if (contactIndex >= 0) campaign.currentIndex = Math.min(contactIndex + 1, campaign.contacts.length - 1);
  setActiveCampaign(campaign);
  await persist(state);
  setReadyAlert(false);
}

function exportCsv(filename, contacts) {
  const csv = contactsToReportCsv(contacts);
  downloadText(filename, csv, "text/csv;charset=utf-8");
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "zapsender",
    state
  };
  downloadText("zapsender-backup.json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const importedState = await refreshAttachmentAvailability(normalizeStoredState(parsed.state || parsed));
  const mode = confirm("OK substitui todas as campanhas. Cancelar mescla o backup com as campanhas atuais.")
    ? "replace"
    : "merge";

  if (mode === "replace") {
    await persist(importedState);
    return;
  }

  const campaignsById = new Map((state.campaigns || []).map((campaign) => [campaign.id, campaign]));
  for (const campaign of importedState.campaigns || []) {
    const id = campaignsById.has(campaign.id) ? `${campaign.id}-imported-${Date.now()}` : campaign.id;
    campaignsById.set(id, { ...campaign, id });
  }
  await persist({
    ...state,
    campaigns: [...campaignsById.values()],
    activeCampaignId: importedState.activeCampaignId || state.activeCampaignId
  });
}

function openCampaignModal() {
  const defaultName = getNextCampaignName(state);
  els.newCampaignName.value = defaultName;
  els.campaignModal.querySelector('input[name="campaign-source-mode"][value="blank"]').checked = true;
  els.copyCampaignOptions.hidden = true;
  els.sourceCampaignSelect.replaceChildren(...state.campaigns.map((campaign) => {
    const option = document.createElement("option");
    option.value = campaign.id;
    option.textContent = campaign.name;
    option.selected = campaign.id === state.activeCampaignId;
    return option;
  }));
  els.campaignModal.querySelectorAll('input[name="copy-status"]').forEach((input) => {
    input.checked = input.value === "erro" || input.value === "pulado";
  });
  els.campaignModal.showModal();
  els.newCampaignName.focus();
}

function updateCampaignCreationMode() {
  const mode = els.campaignModal.querySelector('input[name="campaign-source-mode"]:checked')?.value || "blank";
  els.copyCampaignOptions.hidden = mode !== "copy";
}

async function confirmCreateCampaign(event) {
  event.preventDefault();
  const mode = els.campaignModal.querySelector('input[name="campaign-source-mode"]:checked')?.value || "blank";
  const name = els.newCampaignName.value.trim() || getNextCampaignName(state);
  let campaign;

  if (mode === "blank") {
    campaign = createCampaign({ name, source: "manual" }, []);
  } else {
    const sourceCampaign = state.campaigns.find((item) => item.id === els.sourceCampaignSelect.value);
    const statuses = [...els.campaignModal.querySelectorAll('input[name="copy-status"]:checked')].map((input) => input.value);
    if (!sourceCampaign) {
      setReadyAlert(true, "Escolha uma campanha de origem.", "error");
      return;
    }
    if (!statuses.length) {
      setReadyAlert(true, "Escolha ao menos um status para copiar.", "error");
      return;
    }
    campaign = duplicateCampaignByStatuses(state, sourceCampaign, statuses, name);
  }

  state = addCampaign(state, campaign);
  els.campaignModal.close();
  await persist(state);
  setReadyAlert(true, `Campanha criada com ${campaign.contacts.length} contatos.`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
}

els.newCampaignBtn.addEventListener("click", () => {
  openCampaignModal();
});

els.exportBackupBtn.addEventListener("click", exportBackup);

els.importBackupFile.addEventListener("change", async () => {
  const file = els.importBackupFile.files?.[0];
  if (!file) return;
  try {
    await importBackup(file);
    setReadyAlert(true, "Backup importado.");
  } catch (error) {
    setReadyAlert(true, `Falha ao importar backup: ${error.message}`, "error");
  } finally {
    els.importBackupFile.value = "";
  }
});

els.campaignModal.querySelectorAll('input[name="campaign-source-mode"]').forEach((input) => {
  input.addEventListener("change", updateCampaignCreationMode);
});
els.confirmCreateCampaign.addEventListener("click", confirmCreateCampaign);

els.saveCampaignNameBtn.addEventListener("click", async () => {
  setActiveCampaign(renameCampaign(activeCampaign(), els.campaignName.value, getNextCampaignName(state)));
  await persist(state);
});

els.campaignName.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  setActiveCampaign(renameCampaign(activeCampaign(), els.campaignName.value, getNextCampaignName(state)));
  await persist(state);
});

els.csvFile.addEventListener("change", async () => {
  const file = els.csvFile.files?.[0];
  if (!file) return;
  els.csvText.value = await file.text();
  previewCsv();
});

els.csvText.addEventListener("input", schedulePreviewCsv);
els.previewImportBtn.addEventListener("click", previewCsv);

els.importBtn.addEventListener("click", async () => {
  sendSession = null;
  setActiveCampaign({
    ...activeCampaign(),
    source: "csv-import",
    contacts: pendingImportContacts.filter((contact) => contact.valid).map((contact) => ({
      ...contact,
      status: "pendente",
      error: ""
    })),
    currentIndex: 0
  });
  await persist(state);
  renderImportErrors([]);
  renderNormalizationPreview([]);
});

els.addMessageBtn.addEventListener("click", async () => {
  const templates = messageTemplates();
  const nextTemplates = [...templates, templates[selectedMessageIndex()] || ""];
  setActiveCampaign({
    ...activeCampaign(),
    messageTemplates: nextTemplates,
    versionAttachments: [...(activeCampaign().versionAttachments || []), null],
    selectedMessageIndex: nextTemplates.length - 1,
    messageTemplate: nextTemplates[nextTemplates.length - 1] || ""
  });
  await persist(state);
});

els.attachmentMode.addEventListener("change", async () => {
  setActiveCampaign({
    ...activeCampaign(),
    attachmentMode: els.attachmentMode.value
  });
  await persist(state);
});

els.mode.addEventListener("change", saveSettings);
els.minInterval.addEventListener("input", updateSendProgress);
els.maxInterval.addEventListener("input", updateSendProgress);
els.minInterval.addEventListener("change", saveSettings);
els.maxInterval.addEventListener("change", saveSettings);
els.focusWhatsappTab.addEventListener("change", saveSettings);
els.contactStatusFilter.addEventListener("change", updateTable);

els.checkWhatsappBtn.addEventListener("click", async () => {
  const result = await checkWhatsAppTab();
  if (result.ready) {
    els.autoStatus.textContent = "Aba encontrada";
    setReadyAlert(true, "Aba do WhatsApp Web encontrada.");
  } else {
    els.autoStatus.textContent = "Aba nao encontrada";
    setReadyAlert(true, result.error || "Abra web.whatsapp.com em uma aba antes de iniciar.", "error");
  }
});

els.copyPhone.addEventListener("click", async () => {
  const contact = currentContact();
  await navigator.clipboard.writeText(contact?.phoneDisplay || contact?.phoneNormalized || "");
});

els.copyMessage.addEventListener("click", async () => {
  await navigator.clipboard.writeText(renderMessage(selectedMessageTemplate(), currentContact()));
});

els.playBtn.addEventListener("click", async () => {
  playing = true;
  await saveSettings();
  if (!sendSession || sendSession.campaignId !== activeCampaign()?.id || runnableContacts().length > sendSession.initialRemaining - sendSession.completed) {
    createSendSession();
  } else if (!sendSession.activeStartedAt) {
    sendSession.activeStartedAt = Date.now();
  }
  updateSendProgress();
  const tabStatus = await checkWhatsAppTab();
  if (!tabStatus.ready) {
    playing = false;
    pauseSendSession();
    updateBusyState();
    updateSendProgress();
    setReadyAlert(true, tabStatus.error || "Abra web.whatsapp.com em uma aba antes de iniciar.", "error");
    return;
  }
  els.autoStatus.textContent = "Aba encontrada";
  await openNext();
});

els.pauseBtn.addEventListener("click", () => {
  playing = false;
  pauseSendSession();
  clearCountdown();
  updateBusyState();
});

els.openNextBtn.addEventListener("click", async () => {
  await saveSettings();
  await openNext();
});

els.skipBtn.addEventListener("click", async () => {
  const campaign = { ...activeCampaign() };
  const contact = getCurrentContact(campaign);
  if (!contact) return;
  updateContactStatus(campaign, contact.id, "pulado");
  if (playing && campaign.settings.mode === "auto") recordSendAttempt();
  campaign.currentIndex = Math.min(campaign.currentIndex + 1, Math.max(0, campaign.contacts.length - 1));
  setActiveCampaign(campaign);
  await persist(state);
  setReadyAlert(false);
  if (playing && activeCampaign().settings.mode === "auto" && runnableContacts().length) {
    await startCountdownThenOpen();
  } else if (playing && activeCampaign().settings.mode === "auto") {
    playing = false;
    pauseSendSession();
    updateSendProgress();
    updateBusyState();
  }
});

els.sentBtn.addEventListener("click", markSent);

els.resetBtn.addEventListener("click", () => {
  els.resetModal.showModal();
});

els.confirmReset.addEventListener("click", async (event) => {
  event.preventDefault();
  playing = false;
  pauseSendSession();
  clearCountdown();
  sendSession = null;
  const campaign = { ...activeCampaign() };
  resetProgress(campaign);
  setActiveCampaign(campaign);
  await persist(state);
  els.resetModal.close();
});

els.exportReportBtn.addEventListener("click", () => {
  exportCsv(`${activeCampaign().name}-relatorio.csv`, activeCampaign().contacts || []);
});

els.exportSuccessBtn.addEventListener("click", () => {
  const successfulContacts = (activeCampaign().contacts || []).filter((contact) => {
    return contact.status === "enviado automaticamente" || contact.status === "enviado manualmente";
  });
  exportCsv(`${activeCampaign().name}-sucessos.csv`, successfulContacts);
});

loadState()
  .then(refreshAttachmentAvailability)
  .then((nextState) => {
    state = nextState;
    render();
  })
  .catch((error) => {
    setReadyAlert(true, error.message, "error");
  });
