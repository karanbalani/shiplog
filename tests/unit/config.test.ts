import { expect, test } from 'bun:test'
import path from 'node:path'
import * as config from '../../lib/config.ts'

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')
const ROOT = path.join(import.meta.dir, '..', '..')

test('load returns parsed valid config', () => {
  const c = config.load(path.join(FIXTURES, 'profile-config-valid.json'))

  expect(c.displayName).toBe('Example User')
  expect(c.identities).toHaveLength(1)
  expect(c.identities[0]!.provider).toBe('github')
  expect(c.identities[0]!.login).toBe('octocat')
  expect(c.identities[0]!.ignoreOrganizations).toEqual(['some-noisy-org'])
  expect(c.identities[0]!.ignoreRepositories).toContain('octocat/octocat')
  expect(c.publishTargets).toHaveLength(1)
  expect(c.publishTargets[0]!.repositoryFullName).toBe('octocat/octocat')
})

test('load accepts the shipped example config', () => {
  const c = config.load(path.join(ROOT, 'profile-config.example.json'))

  expect(c.identities[0]!.login).toBe('your-github-login')
  expect(c.publishTargets[0]!.repositoryFullName).toBe('your-github-login/your-github-login')
})

test('load defaults render knobs when omitted', () => {
  const c = config.load(path.join(FIXTURES, 'profile-config-default-render.json'))

  expect(c.render).toEqual(config.DEFAULT_RENDER)
  expect(c.identities[0]!.ignoreOrganizations).toEqual([])
  expect(c.identities[0]!.ignoreRepositories).toEqual([])
})

test('validate allows schema hint without returning it', () => {
  const c = config.validate({
    $schema: '../schemas/profile-config.schema.json',
    identities: [{ provider: 'github', login: 'octocat' }],
    publishTargets: [
      {
        provider: 'github',
        repositoryFullName: 'octocat/octocat',
        branch: 'main',
        path: 'README.md',
        tokenEnv: 'GITHUB_README_TOKEN'
      }
    ]
  })

  expect('$schema' in c).toBe(false)
})

test('load rejects empty identities', () => {
  expect(() => config.load(path.join(FIXTURES, 'profile-config-invalid-no-identity.json'))).toThrow(
    /at least one identity/i
  )
})

test('load rejects empty publish targets', () => {
  expect(() =>
    config.load(path.join(FIXTURES, 'profile-config-invalid-no-publish-target.json'))
  ).toThrow(/at least one publish target/i)
})

test('load rejects non-github identities in v1', () => {
  expect(() =>
    config.load(path.join(FIXTURES, 'profile-config-invalid-non-github-identity.json'))
  ).toThrow(/github.*v1/i)
})
