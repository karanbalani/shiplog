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

export interface TargetRenderBlockVisibility {
  query: string
  hasRows: boolean
}

export interface TargetRenderBaseBlock {
  visibleWhen?: TargetRenderBlockVisibility
}

export type TargetRenderBlock =
  | TargetRenderHeadingBlock
  | TargetRenderParagraphBlock
  | TargetRenderTableBlock
  | TargetRenderListBlock
  | TargetRenderRepeatBlock
  | TargetRenderRawMarkdownBlock
  | TargetRenderDividerBlock

export interface TargetRenderHeadingBlock extends TargetRenderBaseBlock {
  type: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  text: string
}

export interface TargetRenderParagraphBlock extends TargetRenderBaseBlock {
  type: 'paragraph'
  text: string
}

export interface TargetRenderTableBlock extends TargetRenderBaseBlock {
  type: 'table'
  query: string
  columns: TargetRenderTableColumn[]
}

export interface TargetRenderTableColumn {
  label: string
  value: string
}

export interface TargetRenderListBlock extends TargetRenderBaseBlock {
  type: 'list'
  query: string
  value: string
}

export interface TargetRenderRepeatBlock extends TargetRenderBaseBlock {
  type: 'repeat'
  query: string
  template: string
  separator?: string
}

export interface TargetRenderRawMarkdownBlock extends TargetRenderBaseBlock {
  type: 'rawMarkdown'
  content: string
}

export interface TargetRenderDividerBlock extends TargetRenderBaseBlock {
  type: 'divider'
}
