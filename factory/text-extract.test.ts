import assert from "node:assert/strict";
import test from "node:test";

import { zipSync, strToU8 } from "fflate";

import { extractBinaryDocText, extractDocxText, extractOdtText, extractPdfText, extractRtfText } from "./text-extract.ts";

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  const document = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(document) });
}

function odt(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<text:p>${p}</text:p>`).join("");
  const content = `<?xml version="1.0"?><office:document-content xmlns:office="x" xmlns:text="y"><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  return zipSync({ "mimetype": strToU8("application/vnd.oasis.opendocument.text"), "content.xml": strToU8(content) });
}

function tinyPdf(text: string): Uint8Array {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    (() => {
      const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
      return `<</Length ${stream.length}>>stream\n${stream}\nendstream`;
    })(),
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, idx) => {
    offsets.push(body.length);
    body += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `${xref}trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return strToU8(body);
}

test("docx extraction pulls paragraph text with breaks and decodes entities", () => {
  const text = extractDocxText(docx(["Cahier des charges", "R&#232;gle &amp; contrainte"]));
  assert.match(text, /Cahier des charges/);
  assert.match(text, /Règle & contrainte/);
  assert.equal(text.split("\n").filter((l) => l.trim()).length, 2);
});

test("odt extraction pulls paragraph text", () => {
  const text = extractOdtText(odt(["Especificación", "Requisito uno"]));
  assert.match(text, /Especificación/);
  assert.match(text, /Requisito uno/);
});

test("rtf extraction keeps literal runs, drops control words and font tables, decodes escapes", () => {
  const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Caf\\'e9\\par Ligne deux\\par}";
  const text = extractRtfText(strToU8(rtf));
  assert.match(text, /Caf./);
  assert.match(text, /Ligne deux/);
  assert.doesNotMatch(text, /fonttbl|Arial/);
  assert.equal(text.split("\n").filter((l) => l.trim()).length, 2);
});

test("rtf extraction decodes \\uN unicode and skips its fallback char", () => {
  const text = extractRtfText(strToU8("{\\rtf1 pr\\u233?sent}"));
  assert.match(text, /présent/);
});

test("pdf extraction returns the page text via unpdf", async () => {
  const text = await extractPdfText(tinyPdf("Hello Vivicy prep"));
  assert.match(text, /Hello Vivicy prep/);
});

test("extractBinaryDocText dispatches by extension and rejects unknown types", async () => {
  assert.match(await extractBinaryDocText(".docx", docx(["one"])), /one/);
  await assert.rejects(() => extractBinaryDocText(".png", new Uint8Array()), /no binary text extractor/);
});
