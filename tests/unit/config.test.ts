import { expect, test } from 'bun:test'
import path from 'node:path'
import * as config from '../../lib/config.ts'

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')

test('load returns parsed valid config', () => {
  const c = config.load(path.join(FIXTURES, 'profile-config-valid.json'))

  expect(c.displayName).toBe('Karan Balani')
  expect(c.identities).toHaveLength(1)
  expect(c.identities[0]!.provider).toBe('github')
  expect(c.identities[0]!.login).toBe('balanikaran')
  expect(c.identities[0]!.ignoreOrganizations).toEqual(['some-noisy-org'])
  expect(c.identities[0]!.ignoreRepositories).toContain('balanikaran/balanikaran')
  expect(c.publishTargets).toHaveLength(1)
  expect(c.publishTargets[0]!.repositoryFullName).toBe('balanikaran/balanikaran')
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
    identities: [{ provider: 'github', login: 'balanikaran' }],
    publishTargets: [
      {
        provider: 'github',
        repositoryFullName: 'balanikaran/balanikaran',
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
