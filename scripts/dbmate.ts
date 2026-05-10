const args = Bun.argv.slice(2)
const command = args[0]
const needsConnection = command !== 'new'

export {}

if (needsConnection && !process.env.DATABASE_CONNECTION_STRING) {
  console.error('DATABASE_CONNECTION_STRING is not set. define it in .env or your shell.')
  process.exit(1)
}

const child = Bun.spawn(['dbmate', ...args], {
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_CONNECTION_STRING ?? ''
  },
  stderr: 'inherit',
  stdout: 'inherit'
})

process.exit(await child.exited)
