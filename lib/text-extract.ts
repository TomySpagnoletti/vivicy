import { unzipSync } from "fflate"

export const BINARY_DOC_EXTENSIONS = new Set([".docx", ".odt", ".rtf", ".pdf"])

export const TEXT_LANGUAGE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".adoc",
  ".asciidoc",
  ".rst",
  ".tex",
  ".eml",
])

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[body] ?? whole
  })
}

function collapseBlankLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// OOXML/ODF text lives inside element runs; closing a paragraph/heading is the only structural break we preserve.
function markupToText(xml: string, paragraphCloseTags: string[]): string {
  let text = xml
  for (const tag of paragraphCloseTags) text = text.split(tag).join("\n")
  text = text.replace(/<[^>]*\btext:tab\b[^>]*\/?>/g, "\t").replace(/<[^>]*\bw:tab\b[^>]*\/?>/g, "\t")
  text = text.replace(/<[^>]+>/g, "")
  return collapseBlankLines(decodeXmlEntities(text))
}

function readZipEntry(bytes: Uint8Array, entry: string): string | null {
  const files = unzipSync(bytes)
  const found = files[entry]
  return found ? new TextDecoder("utf-8").decode(found) : null
}

export function extractDocxText(bytes: Uint8Array): string {
  const xml = readZipEntry(bytes, "word/document.xml")
  if (xml === null) throw new Error("docx has no word/document.xml (not an Office Open XML document)")
  return markupToText(xml, ["</w:p>"])
}

export function extractOdtText(bytes: Uint8Array): string {
  const xml = readZipEntry(bytes, "content.xml")
  if (xml === null) throw new Error("odt has no content.xml (not an OpenDocument text file)")
  return markupToText(xml, ["</text:p>", "</text:h>"])
}

const RTF_NON_TEXT_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata", "colorschememapping",
  "latentstyles", "datastore", "generator", "listtable", "listoverridetable", "rsidtbl", "mmathPr",
])

// RTF is 7-bit-ASCII markup: control words steer, groups nest, and only literal runs are text.
export function extractRtfText(bytes: Uint8Array): string {
  const src = new TextDecoder("latin1").decode(bytes)
  let out = ""
  let i = 0
  const skipStack: boolean[] = []
  let skipping = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === "{") {
      skipStack.push(skipping)
      i += 1
      continue
    }
    if (ch === "}") {
      skipping = skipStack.pop() ?? false
      i += 1
      continue
    }
    if (ch === "\\") {
      const next = src[i + 1]
      if (next === "\\" || next === "{" || next === "}") {
        if (!skipping) out += next
        i += 2
        continue
      }
      if (next === "*") {
        skipping = true
        i += 2
        continue
      }
      if (next === "'") {
        const hex = src.slice(i + 2, i + 4)
        if (!skipping) out += String.fromCharCode(Number.parseInt(hex, 16) || 0)
        i += 4
        continue
      }
      const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i))
      if (word) {
        const control = word[1]
        if (control === "u") {
          const code = Number.parseInt(word[2] ?? "0", 10)
          if (!skipping && Number.isFinite(code)) out += String.fromCodePoint(code < 0 ? code + 65536 : code)
          i += word[0].length
          if (src[i] === "?") i += 1
          continue
        }
        if (control === "par" || control === "line" || control === "sect" || control === "page") {
          if (!skipping) out += "\n"
        } else if (control === "tab") {
          if (!skipping) out += "\t"
        } else if (RTF_NON_TEXT_DESTINATIONS.has(control)) {
          skipping = true
        }
        i += word[0].length
        continue
      }
      i += 2
      continue
    }
    if (ch === "\n" || ch === "\r") {
      i += 1
      continue
    }
    if (!skipping) out += ch
    i += 1
  }
  return collapseBlankLines(out)
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf")
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return collapseBlankLines(Array.isArray(text) ? text.join("\n") : text)
}

export async function extractBinaryDocText(ext: string, bytes: Uint8Array): Promise<string> {
  switch (ext) {
    case ".docx":
      return extractDocxText(bytes)
    case ".odt":
      return extractOdtText(bytes)
    case ".rtf":
      return extractRtfText(bytes)
    case ".pdf":
      return extractPdfText(bytes)
    default:
      throw new Error(`no binary text extractor for ${ext}`)
  }
}

// The single "give me this file's natural-language text" seam: utf8 for text formats, deterministic
// extraction for binary docs, "" for anything unscannable (or when extraction fails) so callers never throw.
export async function extractScannableText(ext: string, bytes: Uint8Array): Promise<string> {
  const lower = ext.toLowerCase()
  if (TEXT_LANGUAGE_EXTENSIONS.has(lower)) return new TextDecoder("utf-8").decode(bytes)
  if (BINARY_DOC_EXTENSIONS.has(lower)) {
    try {
      return await extractBinaryDocText(lower, bytes)
    } catch {
      return ""
    }
  }
  return ""
}
