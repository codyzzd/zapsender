import { normalizePhone } from "./phone.js";

function detectDelimiter(line) {
  const comma = countDelimiterOutsideQuotes(line, ",");
  const semicolon = countDelimiterOutsideQuotes(line, ";");
  const tab = countDelimiterOutsideQuotes(line, "\t");
  if (tab > comma && tab > semicolon) return "\t";
  return semicolon > comma ? ";" : ",";
}

function countDelimiterOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      i += 1;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) count += 1;
  }

  return count;
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function parseLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      i += 1;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

export function parseCsv(text) {
  const normalizedText = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalizedText) return { contacts: [], errors: ["CSV vazio"] };

  const lines = normalizedText.split("\n").filter((line) => line.trim());
  const delimiter = detectDelimiter(lines[0]);
  const firstRow = parseLine(lines[0], delimiter);
  const headers = firstRow.map(normalizeHeader);
  const phoneAliases = ["telefone", "phone", "celular", "whatsapp", "numero", "fone", "tel"];
  const nameAliases = ["nome", "name", "cliente", "contato"];
  const nameIndex = headers.findIndex((header) => nameAliases.includes(header));
  const phoneIndex = headers.findIndex((header) => phoneAliases.includes(header));
  const hasHeader = nameIndex !== -1 || phoneIndex !== -1;
  const errors = [];

  if (hasHeader && phoneIndex === -1) {
    return { contacts: [], errors: ["CSV precisa conter uma coluna de telefone"] };
  }

  const rows = hasHeader ? lines.slice(1) : lines;
  const resolvedPhoneIndex = hasHeader ? phoneIndex : 0;
  const resolvedNameIndex = hasHeader ? nameIndex : 1;
  const importId = Date.now();

  const contacts = rows.map((line, rowIndex) => {
    const cells = parseLine(line, delimiter);
    const name = resolvedNameIndex >= 0 ? cells[resolvedNameIndex] || "" : "";
    const phone = cells[resolvedPhoneIndex] || "";
    const phoneInfo = normalizePhone(phone);
    const lineNumber = hasHeader ? rowIndex + 2 : rowIndex + 1;

    if (!phoneInfo.valid) errors.push(`Linha ${lineNumber}: ${phoneInfo.reason}`);

    return {
      id: `${importId}-${rowIndex}-${phoneInfo.normalized || phone}`,
      name: name.trim(),
      phoneOriginal: phoneInfo.original,
      phoneNormalized: phoneInfo.normalized,
      phoneDisplay: phoneInfo.display,
      valid: phoneInfo.valid,
      invalidReason: phoneInfo.reason,
      status: phoneInfo.valid ? "pendente" : "erro",
      lastActionAt: null,
      openedAt: null,
      sentAt: null,
      skippedAt: null,
      error: phoneInfo.valid ? "" : phoneInfo.reason
    };
  });

  return { contacts, errors };
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n;]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

export function contactsToReportCsv(contacts) {
  const header = ["nome", "telefone", "status", "data_hora_ultima_acao"];
  const rows = contacts.map((contact) => [
    contact.name,
    contact.phoneDisplay || contact.phoneNormalized,
    contact.status,
    contact.lastActionAt || ""
  ]);

  return [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}
