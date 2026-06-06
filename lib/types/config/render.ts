export type RenderQueryMode = 'one' | 'many'

export interface TargetRenderConfig {
  $schema?: string
  version: 1
  queries?: Record<string, TargetRenderQueryConfig>
  markdown: TargetRenderBlock[]
}

export interface TargetRenderQueryConfig {
  mode: RenderQueryMode
  sql: string
}

export type TargetRenderBlock =
  | TargetRenderHeadingBlock
  | TargetRenderParagraphBlock
  | TargetRenderTableBlock
  | TargetRenderListBlock
  | TargetRenderRawMarkdownBlock
  | TargetRenderDividerBlock

export interface TargetRenderHeadingBlock {
  type: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
}

export interface TargetRenderParagraphBlock {
  type: 'paragraph'
  text: string
}

export interface TargetRenderTableBlock {
  type: 'table'
  query: string
  columns: TargetRenderTableColumn[]
}

export interface TargetRenderTableColumn {
  label: string
  value: string
}

export interface TargetRenderListBlock {
  type: 'list'
  query: string
  value: string
}

export interface TargetRenderRawMarkdownBlock {
  type: 'rawMarkdown'
  content: string
}

export interface TargetRenderDividerBlock {
  type: 'divider'
}
