export const VALID_DDDS = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99"
]);

export function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizePhone(rawPhone) {
  const original = String(rawPhone || "").trim();
  let digits = onlyDigits(original);

  if (!digits) {
    return {
      original,
      normalized: "",
      display: "",
      valid: false,
      reason: "Telefone vazio"
    };
  }

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("550")) digits = `55${digits.slice(3)}`;
  if (!digits.startsWith("55") && digits.startsWith("0") && digits.length >= 11) {
    digits = digits.slice(1);
  }
  if (!digits.startsWith("55")) digits = `55${digits}`;

  const national = digits.slice(2);
  const ddd = national.slice(0, 2);
  const validDdd = VALID_DDDS.has(ddd);
  const validLength = national.length === 10 || national.length === 11;

  if (!validDdd) {
    return {
      original,
      normalized: digits,
      display: `+${digits}`,
      valid: false,
      reason: "DDD brasileiro invalido"
    };
  }

  if (!validLength) {
    return {
      original,
      normalized: digits,
      display: `+${digits}`,
      valid: false,
      reason: "Telefone deve ter DDD e 8 ou 9 digitos"
    };
  }

  return {
    original,
    normalized: digits,
    display: `+${digits}`,
    valid: true,
    reason: ""
  };
}
