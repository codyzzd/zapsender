import test from "node:test";
import assert from "node:assert/strict";

import { formatNameVariable, renderMessage } from "../src/message.js";

test("formatNameVariable keeps original CSV name by default", () => {
  assert.equal(formatNameVariable("Abreu, Edjane Alves da Silva"), "Abreu, Edjane Alves da Silva");
});

test("formatNameVariable moves comma surname after given names", () => {
  assert.equal(formatNameVariable("Abreu, Edjane Alves da Silva", "reorderComma"), "Edjane Alves da Silva Abreu");
});

test("formatNameVariable returns first name and last surname", () => {
  assert.equal(formatNameVariable("Abreu, Edjane Alves da Silva", "firstAndLast"), "Edjane Abreu");
});

test("formatNameVariable returns only first name", () => {
  assert.equal(formatNameVariable("Abreu, Edjane Alves da Silva", "firstOnly"), "Edjane");
});

test("renderMessage applies name format only to nome variable", () => {
  const contact = {
    name: "Abreu, Edjane Alves da Silva",
    phoneDisplay: "(85) 99999-9999",
    phoneNormalized: "5585999999999"
  };

  assert.equal(
    renderMessage("Ola {nome}, seu telefone e {telefone}", contact, { nameFormat: "firstAndLast" }),
    "Ola Edjane Abreu, seu telefone e (85) 99999-9999"
  );
});
