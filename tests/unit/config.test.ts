import { expect, test } from 'bun:test'
import path from 'node:path'
import * as config from '../../lib/config.ts'

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')
const ROOT = path.join(import.meta.dir, '..', '..')

test('load returns parsed valid config', () => {
  const c = config.load(path.join(FIXTURES, 'shiplog_config_valid.json'))

  expect(c.profile.displayName).toBe('Example User')
  expect(c.collect.accounts).toHaveLength(1)
  expect(c.collect.accounts[0]!.provider).toBe('github')
  expect(c.collect.accounts[0]!.accountId).toBe('U_TEST_1')
  expect(c.collect.accounts[0]!.tokenEnv).toBe('GH_RO_CLASSIC_TOKEN')
  expect(c.collect.accounts[0]!.organizationPatTokens).toEqual([
    {
      organizationId: 'O_RESTRICTED_1',
      tokenEnv: 'GH_RO_RESTRICTED_ORG_PAT_TOKEN'
    }
  ])
  expect(c.collect.accounts[0]!.ignore.organizations).toEqual(['O_NOISY_1'])
  expect(c.collect.accounts[0]!.ignore.repositories).toEqual(['R_PROFILE_1'])
  expect(c.publish.targets).toHaveLength(1)
  expect(c.publish.targets[0]!.repositoryId).toBe('R_PROFILE_1')
  expect(c.publish.targets[0]!.branch).toBe('main')
  expect(c.publish.targets[0]!.path).toBe('README.md')
  expect(c.publish.targets[0]!.tokenEnv).toBe('GH_RW_REPO_TOKEN')
})

test('load accepts the shipped example config', () => {
  const c = config.load(path.join(ROOT, 'shiplog.config.example.json'))

  expect(c.collect.accounts[0]!.accountId).toBe('your-github-user-node-id')
  expect(c.publish.targets[0]!.repositoryId).toBe('your-profile-repository-node-id')
})

test('load defaults optional config fields when omitted', () => {
  const c = config.load(path.join(FIXTURES, 'shiplog_config_defaults.json'))

  expect(c.profile).toEqual({})
  expect(c.collect.accounts[0]!.ignore).toEqual({ organizations: [], repositories: [] })
  expect(c.collect.accounts[0]!.tokenEnv).toBe('GH_RO_CLASSIC_TOKEN')
  expect(c.collect.accounts[0]!.organizationPatTokens).toEqual([])
  expect(c.publish.targets[0]!.branch).toBe('main')
  expect(c.publish.targets[0]!.path).toBe('README.md')
  expect(c.publish.targets[0]!.tokenEnv).toBe('GH_RW_REPO_TOKEN')
})

test('validate allows schema hint without returning it', () => {
  const c = config.validate({
    $schema: '../schemas/shiplog.config.schema.json',
    version: 1,
    collect: { accounts: [{ provider: 'github', accountId: 'U_TEST_1' }] },
    publish: { targets: [{ provider: 'github', repositoryId: 'R_PROFILE_1' }] }
  })

  expect('$schema' in c).toBe(false)
})

test('load rejects empty collect accounts', () => {
  expect(() => config.load(path.join(FIXTURES, 'shiplog_config_invalid_no_account.json'))).toThrow(
    /at least one collect account/i
  )
})

test('load rejects empty publish targets', () => {
  expect(() =>
    config.load(path.join(FIXTURES, 'shiplog_config_invalid_no_publish_target.json'))
  ).toThrow(/at least one publish target/i)
})

test('load rejects non-github accounts in v1', () => {
  expect(() =>
    config.load(path.join(FIXTURES, 'shiplog_config_invalid_non_github_account.json'))
  ).toThrow(/github.*v1/i)
})
