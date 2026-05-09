const filePath = Bun.argv[2]

export {}

if (!filePath) {
  console.error('Usage: bun scripts/check-commit-msg.ts <commit-msg-file>')
  process.exit(2)
}

const message = await Bun.file(filePath).text()
const lines = message.split(/\r?\n/)
const checkedLines = lines.filter((line) => !line.startsWith('#'))
const checkedMessage = checkedLines.join('\n').trim()
const subject = checkedLines[0]?.trim() ?? ''

const conventional =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9._/-]+\))?!?: .{1,100}$/

if (!conventional.test(subject)) {
  console.error('Commit message must be a Conventional Commit.')
  console.error('')
  console.error('Expected: type(scope): subject')
  console.error('Examples:')
  console.error('  feat(db): add account schema')
  console.error('  fix(render): handle empty activity')
  console.error('  chore: update dependencies')
  console.error('')
  console.error(`Received: ${subject || '(empty)'}`)
  process.exit(1)
}

if (/[A-Z]/.test(checkedMessage)) {
  console.error('Commit message must use lowercase letters only.')
  console.error('')
  console.error('Examples:')
  console.error('  feat(db): add account schema')
  console.error('  fix(render): handle empty activity')
  console.error('  chore: update dependencies')
  console.error('')
  console.error(`Received: ${subject || '(empty)'}`)
  process.exit(1)
}
