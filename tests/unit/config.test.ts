import { expect, test } from 'bun:test'
import path from 'node:path'
import * as config from '../../lib/config.ts'

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')
const ROOT = path.join(import.meta.dir, '..', '..')

test('load returns parsed valid config', () => {
  const c = config.load(path.join(FIXTURES, 'profile_config_valid.json'))

  expect(c.displayName).toBe('Example User')
  expect(c.identities).toHaveLength(1)
  expect(c.identities[0]!.provider).toBe('github')
  expect(c.identities[0]!.login).toBe('octocat')
  expect(c.identities[0]!.tokenEnv).toBe('GH_RO_CLASSIC_TOKEN')
  expect(c.identities[0]!.organizationTokens).toEqual([
    { organization: 'restricted-org', tokenEnv: 'GH_RO_RESTRICTED_ORG_TOKEN' }
  ])
  expect(c.identities[0]!.ignoreOrganizations).toEqual(['some-noisy-org'])
  expect(c.identities[0]!.ignoreRepositories).toContain('octocat/octocat')
  expect(c.publishTargets).toHaveLength(1)
  expect(c.publishTargets[0]!.repositoryFullName).toBe('octocat/octocat')
})

test('load accepts the shipped example config', () => {
  const c = config.load(path.join(ROOT, 'profile_config.example.json'))

  expect(c.identities[0]!.login).toBe('your-github-login')
  expect(c.publishTargets[0]!.repositoryFullName).toBe('your-github-login/your-github-login')
})

test('load defaults render knobs when omitted', () => {
  const c = config.load(path.join(FIXTURES, 'profile_config_default_render.json'))

  expect(c.render).toEqual(config.DEFAULT_RENDER)
  expect(c.identities[0]!.ignoreOrganizations).toEqual([])
  expect(c.identities[0]!.ignoreRepositories).toEqual([])
  expect(c.identities[0]!.tokenEnv).toBe('GH_RO_CLASSIC_TOKEN')
  expect(c.identities[0]!.organizationTokens).toEqual([])
})

test('validate allows schema hint without returning it', () => {
  const c = config.validate({
    $schema: '../schemas/profile_config.schema.json',
    identities: [{ provider: 'github', login: 'octocat' }],
    publishTargets: [
      {
        provider: 'github',
        repositoryFullName: 'octocat/octocat',
        branch: 'main',
        path: 'README.md',
        tokenEnv: 'GH_RW_REPO_TOKEN'
      }
    ]
  })

  expect('$schema' in c).toBe(false)
})

test('load rejects empty identities', () => {
  expect(() => config.load(path.join(FIXTURES, 'profile_config_invalid_no_identity.json'))).toThrow(
    /at least one identity/i
  )
})

test('load rejects empty publish targets', () => {
  expect(() =>
    config.load(path.join(FIXTURES, 'profile_config_invalid_no_publish_target.json'))
  ).toThrow(/at least one publish target/i)
})

test('load rejects non-github identities in v1', () => {
  expect(() =>
    config.load(path.join(FIXTURES, 'profile_config_invalid_non_github_identity.json'))
  ).toThrow(/github.*v1/i)
})
