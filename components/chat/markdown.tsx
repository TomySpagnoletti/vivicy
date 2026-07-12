"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

const COMPONENTS: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt, title }) => {
    const url = typeof src === "string" && src.length > 0 ? src : undefined
    const label =
      (typeof alt === "string" && alt.trim().length > 0 ? alt : url) ?? "image"
    return (
      <span title={title} className="text-muted-foreground">
        {label}
      </span>
    )
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

const PROSE = [
  "min-w-0 text-xs leading-relaxed wrap-break-word [&>*+*]:mt-2",
  "[&_strong]:font-semibold [&_em]:italic [&_del]:line-through",
  "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[0.85em]",
  "[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em]",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-1 [&_li]:marker:text-muted-foreground",
  "[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1",
  "[&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-semibold",
  "[&_h4]:text-xs [&_h4]:font-semibold [&_h5]:text-xs [&_h5]:font-semibold [&_h6]:text-xs [&_h6]:font-semibold [&_h6]:text-muted-foreground",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic",
  "[&_hr]:border-border",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.9em]",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
  "[&_input]:mr-1.5 [&_input]:align-middle",
].join(" ")

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div data-slot="chat-markdown" className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
