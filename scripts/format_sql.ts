import { format } from 'sql-formatter'

type Mode = 'check' | 'write'

const mode = parseMode(Bun.argv.slice(2))
const files = await sqlFiles('db/migrations')
const unformatted: string[] = []

for (const file of files) {
  const original = await Bun.file(file).text()
  const formatted = formatSql(original)

  if (formatted === original) continue

  if (mode === 'write') {
    await Bun.write(file, formatted)
  } else {
    unformatted.push(file)
  }
}

if (unformatted.length > 0) {
  console.error('SQL files are not formatted:')
  for (const file of unformatted) console.error(`  ${file}`)
  console.error('')
  console.error('Run: bun run format:sql')
  process.exit(1)
}

function parseMode(args: string[]): Mode {
  if (args.includes('--write')) return 'write'
  if (args.includes('--check')) return 'check'
  throw new Error('Usage: bun scripts/format_sql.ts --check|--write')
}

async function sqlFiles(dir: string): Promise<string[]> {
  const glob = new Bun.Glob('*.sql')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: dir, absolute: false })) {
    files.push(`${dir}/${file}`)
  }
  return files.sort()
}

function formatSql(sql: string): string {
  const formatted = format(sql, {
    language: 'postgresql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1
  })
  return `${formatted.trimEnd()}\n`
}
