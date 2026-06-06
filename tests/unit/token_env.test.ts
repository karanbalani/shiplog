import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as config from '../../lib/config.ts'
import type { ShiplogConfig } from '../../lib/types/index.ts'
import { exportTokenEnv, tokenEnvNames } from '../../scripts/export_token_env.ts'

function testConfig(): ShiplogConfig {
  return config.validate({
    version: 1,
    collect: {
      accounts: [
        {
          provider: 'github',
          accountId: 'U_TEST_1',
          tokenEnv: 'GH_RO_CLASSIC_TOKEN',
          organizationPatTokens: [
            { organizationId: 'O_ACME_1', tokenEnv: 'GH_RO_ACME_PAT_TOKEN' },
            { organizationId: 'O_BETA_1', tokenEnv: 'GH_RO_BETA_PAT_TOKEN' }
          ]
        }
      ]
    },
    publish: {
      targets: [
        {
          provider: 'github',
          repositoryId: 'R_PROFILE_1',
          tokenEnv: 'GH_RW_PROFILE_TOKEN'
        }
      ]
    }
  })
}

test('tokenEnvNames returns config token env names by scope', () => {
  const c = testConfig()

  expect(tokenEnvNames(c, 'read')).toEqual([
    'GH_RO_CLASSIC_TOKEN',
    'GH_RO_ACME_PAT_TOKEN',
    'GH_RO_BETA_PAT_TOKEN'
  ])
  expect(tokenEnvNames(c, 'publish')).toEqual(['GH_RW_PROFILE_TOKEN'])
  expect(tokenEnvNames(c, 'all')).toEqual([
    'GH_RO_CLASSIC_TOKEN',
    'GH_RO_ACME_PAT_TOKEN',
    'GH_RO_BETA_PAT_TOKEN',
    'GH_RW_PROFILE_TOKEN'
  ])
})

test('exportTokenEnv writes only configured tokens for the selected scope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-token-env-'))
  const configPath = path.join(dir, 'shiplog.config.json')
  const githubEnvPath = path.join(dir, 'github-env')
  const masked: string[] = []
  fs.writeFileSync(configPath, JSON.stringify(testConfig()))

  const exported = exportTokenEnv({
    configPath,
    githubEnvPath,
    scope: 'read',
    addMask: (value) => masked.push(value),
    tokenSecretsJson: JSON.stringify({
      GH_RO_CLASSIC_TOKEN: 'classic-token',
      GH_RO_ACME_PAT_TOKEN: 'acme-token',
      GH_RO_BETA_PAT_TOKEN: 'beta-token',
      GH_RW_PROFILE_TOKEN: 'write-token'
    })
  })

  expect(exported).toEqual(['GH_RO_CLASSIC_TOKEN', 'GH_RO_ACME_PAT_TOKEN', 'GH_RO_BETA_PAT_TOKEN'])
  expect(masked).toEqual(['classic-token', 'acme-token', 'beta-token'])
  expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe(
    [
      'GH_RO_CLASSIC_TOKEN=classic-token',
      'GH_RO_ACME_PAT_TOKEN=acme-token',
      'GH_RO_BETA_PAT_TOKEN=beta-token',
      ''
    ].join('\n')
  )
})

test('exportTokenEnv can read token values from GitHub secrets JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-token-env-'))
  const configPath = path.join(dir, 'shiplog.config.json')
  const githubEnvPath = path.join(dir, 'github-env')
  fs.writeFileSync(configPath, JSON.stringify(testConfig()))

  const exported = exportTokenEnv({
    configPath,
    githubEnvPath,
    scope: 'publish',
    tokenSecretsJson: JSON.stringify({
      DATABASE_CONNECTION_STRING: 'postgres://secret',
      GH_RO_CLASSIC_TOKEN: 'classic-token',
      GH_RW_PROFILE_TOKEN: 'write-token'
    })
  })

  expect(exported).toEqual(['GH_RW_PROFILE_TOKEN'])
  expect(fs.readFileSync(githubEnvPath, 'utf8')).toBe('GH_RW_PROFILE_TOKEN=write-token\n')
})

test('exportTokenEnv reports missing configured token secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-token-env-'))
  const configPath = path.join(dir, 'shiplog.config.json')
  const githubEnvPath = path.join(dir, 'github-env')
  fs.writeFileSync(configPath, JSON.stringify(testConfig()))

  expect(() =>
    exportTokenEnv({
      configPath,
      githubEnvPath,
      scope: 'read',
      tokenSecretsJson: JSON.stringify({
        GH_RO_CLASSIC_TOKEN: 'classic-token',
        GH_RO_ACME_PAT_TOKEN: 'acme-token'
      })
    })
  ).toThrow(/Missing token secrets for: GH_RO_BETA_PAT_TOKEN/)
})

test('config rejects token env names that cannot be exported', () => {
  expect(() =>
    config.validate({
      version: 1,
      collect: {
        accounts: [
          {
            provider: 'github',
            accountId: 'U_TEST_1',
            tokenEnv: 'gh-read-token'
          }
        ]
      },
      publish: { targets: [{ provider: 'github', repositoryId: 'R_PROFILE_1' }] }
    })
  ).toThrow(/tokenEnv/)
})
