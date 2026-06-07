import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { TargetRenderConfig } from '../../lib/types/index.ts'
import {
  appendShiplogFooter,
  buildTargetRenderContext,
  renderTargetConfigWithRunner,
  renderTargetMarkdown,
  validateTargetRenderSql
} from '../../lib/target_render.ts'

test('validateTargetRenderSql allows one read-only select statement', () => {
  expect(() =>
    validateTargetRenderSql(
      `
        -- recent repositories
        SELECT full_name
        FROM repositories
        WHERE visibility = 'public'
      `,
      'repositories'
    )
  ).not.toThrow()
})

test('validateTargetRenderSql rejects non-select and writable CTE queries', () => {
  expect(() => validateTargetRenderSql('DELETE FROM commits', 'bad')).toThrow(
    /must start with SELECT or WITH/
  )
  expect(() =>
    validateTargetRenderSql(
      'WITH deleted AS (DELETE FROM commits RETURNING oid) SELECT oid FROM deleted',
      'bad'
    )
  ).toThrow(/must not include DELETE/)
})

test('renderTargetMarkdown preserves interpolation and table escaping behavior', () => {
  const markdown = renderTargetMarkdown(
    [
      { type: 'heading', level: 2, text: 'Projects for {{ profile.displayName }}' },
      {
        type: 'paragraph',
        text: 'Shipped {{ summary.commits }} commits.'
      },
      {
        type: 'table',
        query: 'repositories',
        columns: [
          { label: 'Repository', value: '[{{ full_name }}]({{ web_url }})' },
          { label: 'Note', value: '{{ note }}' }
        ]
      },
      { type: 'list', query: 'languages', value: '{{ language }} - {{ commits }}' },
      { type: 'rawMarkdown', content: '<sub>{{ profile.displayName }}</sub>' },
      { type: 'divider' }
    ],
    {
      profile: { displayName: 'Example User' },
      summary: { commits: 5 },
      repositories: [
        {
          full_name: 'octo-org/hello|world',
          web_url: 'https://github.com/octo-org/hello',
          note: 'line one\nline two'
        }
      ],
      languages: [{ language: 'TypeScript', commits: 5 }]
    }
  )

  expect(markdown).toBe(
    [
      '## Projects for Example User',
      '',
      'Shipped 5 commits.',
      '',
      '| Repository | Note |',
      '| --- | --- |',
      '| [octo-org/hello\\|world](https://github.com/octo-org/hello) | line one<br>line two |',
      '',
      '- TypeScript - 5',
      '',
      '<sub>Example User</sub>',
      '',
      '---'
    ].join('\n')
  )
})

test('renderTargetMarkdown repeats a template with markdown line breaks by default', () => {
  const markdown = renderTargetMarkdown(
    [
      {
        type: 'repeat',
        query: 'languages',
        template: '{{ language }}: {{ commits }}'
      }
    ],
    {
      languages: [
        { language: 'TypeScript', commits: 12 },
        { language: 'Rust', commits: 8 }
      ]
    }
  )

  expect(markdown).toBe(['TypeScript: 12', 'Rust: 8'].join('  \n'))
})

test('renderTargetMarkdown repeats blocks with a custom separator', () => {
  const markdown = renderTargetMarkdown(
    [
      {
        type: 'repeat',
        query: 'languages',
        template: '![{{ language }}](https://img.shields.io/badge/{{ language }}-{{ color }})',
        separator: ' '
      }
    ],
    {
      languages: [
        { language: 'TypeScript', color: '3178c6' },
        { language: 'Rust', color: 'dea584' }
      ]
    }
  )

  expect(markdown).toBe(
    '![TypeScript](https://img.shields.io/badge/TypeScript-3178c6) ![Rust](https://img.shields.io/badge/Rust-dea584)'
  )
})

test('renderTargetMarkdown repeats empty query rows as an empty string', () => {
  const markdown = renderTargetMarkdown(
    [
      {
        type: 'repeat',
        query: 'languages',
        template: '{{ language }}'
      }
    ],
    {
      languages: []
    }
  )

  expect(markdown).toBe('')
})

test('renderTargetMarkdown hides visibleWhen hasRows true blocks when rows are empty', () => {
  const markdown = renderTargetMarkdown(
    [
      {
        type: 'heading',
        level: 2,
        text: 'Top Languages',
        visibleWhen: { query: 'languages', hasRows: true }
      },
      {
        type: 'paragraph',
        text: 'Always visible.'
      }
    ],
    {
      languages: []
    }
  )

  expect(markdown).toBe('Always visible.')
})

test('renderTargetMarkdown renders visibleWhen hasRows true blocks when rows exist', () => {
  const markdown = renderTargetMarkdown(
    [
      {
        type: 'heading',
        level: 2,
        text: 'Top Languages',
        visibleWhen: { query: 'languages', hasRows: true }
      }
    ],
    {
      languages: [{ language: 'TypeScript' }]
    }
  )

  expect(markdown).toBe('## Top Languages')
})

test('renderTargetMarkdown renders visibleWhen hasRows false fallback blocks for empty rows', () => {
  const markdown = renderTargetMarkdown(
    [
      {
        type: 'paragraph',
        text: 'No languages yet.',
        visibleWhen: { query: 'languages', hasRows: false }
      }
    ],
    {
      languages: []
    }
  )

  expect(markdown).toBe('No languages yet.')
})

test('renderTargetMarkdown reports missing visibleWhen queries with block context', () => {
  expect(() =>
    renderTargetMarkdown(
      [
        {
          type: 'heading',
          level: 2,
          text: 'Top Languages',
          visibleWhen: { query: 'languages', hasRows: true }
        }
      ],
      {}
    )
  ).toThrow(/render markdown block 1 \(heading\) failed: visibleWhen query languages was not found/)
})

test('appendShiplogFooter appends the footer once', () => {
  const markdown = appendShiplogFooter('# Hello\n')

  expect(markdown).toBe(
    '# Hello\n\n<sub>Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).</sub>\n'
  )
  expect(appendShiplogFooter(markdown)).toBe(markdown)
})

test('buildTargetRenderContext runs queries through an injected runner', async () => {
  const calls: Array<{ sql: string; queryName: string }> = []
  const config: TargetRenderConfig = {
    version: 1,
    queries: {
      summary: {
        mode: 'one',
        sql: 'SELECT 5::int AS commits'
      },
      repositories: {
        mode: 'many',
        sql: 'SELECT full_name FROM repositories'
      },
      empty: {
        mode: 'one',
        sql: 'SELECT commits FROM empty_summary'
      }
    },
    markdown: [{ type: 'paragraph', text: '{{ summary.commits }}' }]
  }

  const context = await buildTargetRenderContext({
    config,
    profile: { displayName: 'Example User' },
    queryRunner: async (sql, queryName) => {
      calls.push({ sql, queryName })
      if (queryName === 'summary') return [{ commits: 5 }]
      if (queryName === 'repositories') return [{ full_name: 'octo-org/hello' }]
      return []
    }
  })

  expect(context).toEqual({
    profile: { displayName: 'Example User' },
    summary: { commits: 5 },
    repositories: [{ full_name: 'octo-org/hello' }],
    empty: {}
  })
  expect(calls).toEqual([
    { queryName: 'summary', sql: 'SELECT 5::int AS commits' },
    { queryName: 'repositories', sql: 'SELECT full_name FROM repositories' },
    { queryName: 'empty', sql: 'SELECT commits FROM empty_summary' }
  ])
})

test('renderTargetConfigWithRunner renders the same target markdown shape as the CLI path', async () => {
  const output = await renderTargetConfigWithRunner({
    config: {
      version: 1,
      queries: {
        summary: {
          mode: 'one',
          sql: 'SELECT commits, pull_requests FROM summary'
        },
        repositories: {
          mode: 'many',
          sql: 'SELECT full_name, web_url, commits FROM repositories'
        }
      },
      markdown: [
        { type: 'heading', level: 1, text: "Hi, I'm {{ profile.displayName }}" },
        {
          type: 'paragraph',
          text: 'I shipped {{ summary.commits }} commits and opened {{ summary.pull_requests }} PRs.'
        },
        {
          type: 'table',
          query: 'repositories',
          columns: [
            { label: 'Repository', value: '[{{ full_name }}]({{ web_url }})' },
            { label: 'Commits', value: '{{ commits }}' }
          ]
        }
      ]
    },
    profile: { displayName: 'Example User' },
    queryRunner: async (_sql, queryName) => {
      if (queryName === 'summary') return [{ commits: 5, pull_requests: 2 }]
      return [
        { full_name: 'octo-org/hello', web_url: 'https://github.com/octo-org/hello', commits: 5 }
      ]
    }
  })

  expect(output).toBe(
    [
      "# Hi, I'm Example User",
      '',
      'I shipped 5 commits and opened 2 PRs.',
      '',
      '| Repository | Commits |',
      '| --- | --- |',
      '| [octo-org/hello](https://github.com/octo-org/hello) | 5 |',
      '',
      '<sub>Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).</sub>',
      ''
    ].join('\n')
  )
})

test('target_render module does not import Node-only runtime modules', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'lib', 'target_render.ts'),
    'utf8'
  )

  expect(source).not.toContain("from 'node:")
  expect(source).not.toContain('lib/db')
  expect(source).not.toContain('providers/github')
  expect(source).not.toContain('logger')
})
