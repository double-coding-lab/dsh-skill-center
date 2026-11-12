declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  export interface MarkdownLabels {
    code: {
      copyLabel: string
      copiedLabel: string
      toolbarLabels: {
        codeLabel: string
        wrapLabel: string
        unwrapLabel: string
      }
    }
    footnotes: string
  }

  export interface MarkdownTextProps {
    text: string
    streaming?: boolean
    labels?: MarkdownLabels
    fileMentions?: unknown
    pathImages?: unknown
    variant?: 'body' | 'compact'
    omitHtml?: boolean
    textInteractionSource?: boolean
  }

  export const MarkdownText: ComponentType<MarkdownTextProps>
}