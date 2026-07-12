import { describe, expect, it } from "vitest"

import { zipSync, strToU8 } from "fflate"

import {
  BINARY_DOC_EXTENSIONS,
  TEXT_LANGUAGE_EXTENSIONS,
  extractBinaryDocText,
  extractDocxText,
  extractOdtText,
  extractPdfText,
  extractRtfText,
  extractScannableText,
} from "@/lib/text-extract"

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("")
  const document = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`
  return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(document) })
}

function odt(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<text:p>${p}</text:p>`).join("")
  const content = `<?xml version="1.0"?><office:document-content xmlns:office="x" xmlns:text="y"><office:body><office:text>${body}</office:text></office:body></office:document-content>`
  return zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.text"), "content.xml": strToU8(content) })
}

function tinyPdf(text: string): Uint8Array {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    (() => {
      const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
      return `<</Length ${stream.length}>>stream\n${stream}\nendstream`
    })(),
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((obj, idx) => {
    offsets.push(body.length)
    body += `${idx + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefStart = body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`
  body += `${xref}trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`
  return strToU8(body)
}

describe("binary document text extraction", () => {
  it("pulls docx paragraph text with breaks and decodes entities", () => {
    const text = extractDocxText(docx(["Cahier des charges", "R&#232;gle &amp; contrainte"]))
    expect(text).toMatch(/Cahier des charges/)
    expect(text).toMatch(/Règle & contrainte/)
    expect(text.split("\n").filter((l) => l.trim()).length).toBe(2)
  })

  it("pulls odt paragraph text", () => {
    const text = extractOdtText(odt(["Especificación", "Requisito uno"]))
    expect(text).toMatch(/Especificación/)
    expect(text).toMatch(/Requisito uno/)
  })

  it("keeps rtf literal runs, drops control words and font tables, decodes escapes", () => {
    const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Caf\\'e9\\par Ligne deux\\par}"
    const text = extractRtfText(strToU8(rtf))
    expect(text).toMatch(/Caf./)
    expect(text).toMatch(/Ligne deux/)
    expect(text).not.toMatch(/fonttbl|Arial/)
    expect(text.split("\n").filter((l) => l.trim()).length).toBe(2)
  })

  it("decodes rtf \\uN unicode and skips its fallback char", () => {
    const text = extractRtfText(strToU8("{\\rtf1 pr\\u233?sent}"))
    expect(text).toMatch(/présent/)
  })

  it("returns pdf page text via unpdf", async () => {
    const text = await extractPdfText(tinyPdf("Hello Vivicy prep"))
    expect(text).toMatch(/Hello Vivicy prep/)
  })

  it("dispatches by extension and rejects unknown types", async () => {
    expect(await extractBinaryDocText(".docx", docx(["one"]))).toMatch(/one/)
    await expect(extractBinaryDocText(".png", new Uint8Array())).rejects.toThrow(/no binary text extractor/)
  })
})

describe("extractScannableText", () => {
  it("decodes text formats as utf8", async () => {
    expect(await extractScannableText(".md", strToU8("# Titre\n"))).toBe("# Titre\n")
    expect(await extractScannableText(".TXT", strToU8("bonjour"))).toBe("bonjour")
  })

  it("extracts natural-language text from binary documents", async () => {
    expect(await extractScannableText(".docx", docx(["Contenu du document"]))).toMatch(/Contenu du document/)
  })

  it("returns empty string for unscannable extensions", async () => {
    expect(await extractScannableText(".png", strToU8("not text"))).toBe("")
    expect(await extractScannableText(".exe", new Uint8Array([0, 1, 2]))).toBe("")
  })

  it("returns empty string when binary extraction fails instead of throwing", async () => {
    expect(await extractScannableText(".pdf", strToU8("%PDF-1.4 not a real pdf"))).toBe("")
    expect(await extractScannableText(".docx", strToU8("not a zip"))).toBe("")
  })

  it("keeps the text and binary extension sets disjoint", () => {
    for (const ext of BINARY_DOC_EXTENSIONS) expect(TEXT_LANGUAGE_EXTENSIONS.has(ext)).toBe(false)
  })
})
