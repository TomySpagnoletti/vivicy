export const SUPPORTED_DOC_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".rtf",
  ".docx",
  ".odt",
  ".pdf",
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
] as const

export const ZIP_TRANSPORT_EXTENSION = ".zip"

export const IMPORT_ACCEPT_EXTENSIONS = [...SUPPORTED_DOC_EXTENSIONS, ZIP_TRANSPORT_EXTENSION]

export const IMPORT_ACCEPT_ATTR = IMPORT_ACCEPT_EXTENSIONS.join(",")
