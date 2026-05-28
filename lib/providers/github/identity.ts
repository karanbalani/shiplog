import type { GraphQLClient } from './graphql.ts'
import * as queries from './queries.ts'
import type { GitHubUserCore } from './types.ts'

export interface GitHubAccountProfile {
  externalLogin: string
  externalId: string
  externalUrl: string
  externalCreatedAt: string
}

export interface GitHubOrganizationProfile {
  externalLogin: string
  externalId: string
  externalUrl: string
  name: string | null
}

export interface GitHubRepositoryProfile {
  externalId: string
  nameWithOwner: string
  externalUrl: string
}

interface GitHubOrganizationCore {
  id: string
  login: string
  name: string | null
  url: string
}

interface GitHubRepositoryCore {
  id: string
  nameWithOwner: string
  url: string
}

export async function fetchGitHubAccountProfileById(
  graphQL: GraphQLClient,
  externalId: string
): Promise<GitHubAccountProfile> {
  const data = await graphQL<{ node: GitHubUserCore | null }>(queries.USER_BY_ID, {
    id: externalId
  })
  if (!isGitHubUserCore(data.node)) {
    throw new Error(`GitHub user not found for externalId: ${externalId}`)
  }

  return accountProfileFromUser(data.node)
}

export async function fetchGitHubAccountProfileByLogin(
  graphQL: GraphQLClient,
  login: string
): Promise<GitHubAccountProfile> {
  const data = await graphQL<{ user: GitHubUserCore | null }>(queries.VIEWER_AND_USER, { login })
  if (!data.user) throw new Error(`GitHub user not found: ${login}`)

  return accountProfileFromUser(data.user)
}

export async function fetchGitHubOrganizationById(
  graphQL: GraphQLClient,
  externalId: string
): Promise<GitHubOrganizationProfile> {
  const data = await graphQL<{ node: GitHubOrganizationCore | null }>(queries.ORGANIZATION_BY_ID, {
    id: externalId
  })
  if (!isGitHubOrganizationCore(data.node)) {
    throw new Error(`GitHub organization not found for externalId: ${externalId}`)
  }

  return organizationProfileFromNode(data.node)
}

export async function fetchGitHubOrganizationByLogin(
  graphQL: GraphQLClient,
  login: string
): Promise<GitHubOrganizationProfile> {
  const data = await graphQL<{ organization: GitHubOrganizationCore | null }>(
    queries.ORGANIZATION_BY_LOGIN,
    { login }
  )
  if (!data.organization) throw new Error(`GitHub organization not found: ${login}`)

  return organizationProfileFromNode(data.organization)
}

export async function fetchGitHubRepositoryById(
  graphQL: GraphQLClient,
  externalId: string
): Promise<GitHubRepositoryProfile> {
  const data = await graphQL<{ node: GitHubRepositoryCore | null }>(queries.REPOSITORY_BY_ID, {
    id: externalId
  })
  if (!isGitHubRepositoryCore(data.node)) {
    throw new Error(`GitHub repository not found for externalId: ${externalId}`)
  }

  return repositoryProfileFromNode(data.node)
}

export async function fetchGitHubRepositoryByFullName(
  graphQL: GraphQLClient,
  fullName: string
): Promise<GitHubRepositoryProfile> {
  const [owner, name] = fullName.split('/')
  if (!owner || !name) throw new Error(`invalid GitHub repository full name: ${fullName}`)

  const data = await graphQL<{ repository: GitHubRepositoryCore | null }>(
    queries.REPOSITORY_BY_FULL_NAME,
    { owner, name }
  )
  if (!data.repository) throw new Error(`GitHub repository not found: ${fullName}`)

  return repositoryProfileFromNode(data.repository)
}

function accountProfileFromUser(user: GitHubUserCore): GitHubAccountProfile {
  return {
    externalLogin: user.login,
    externalId: user.id,
    externalUrl: user.url,
    externalCreatedAt: user.createdAt
  }
}

function organizationProfileFromNode(
  organization: GitHubOrganizationCore
): GitHubOrganizationProfile {
  return {
    externalLogin: organization.login,
    externalId: organization.id,
    externalUrl: organization.url,
    name: organization.name ?? null
  }
}

function repositoryProfileFromNode(repository: GitHubRepositoryCore): GitHubRepositoryProfile {
  return {
    externalId: repository.id,
    nameWithOwner: repository.nameWithOwner,
    externalUrl: repository.url
  }
}

function isGitHubUserCore(value: GitHubUserCore | null): value is GitHubUserCore {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    typeof value.login === 'string' &&
    typeof value.url === 'string' &&
    typeof value.createdAt === 'string'
  )
}

function isGitHubOrganizationCore(
  value: GitHubOrganizationCore | null
): value is GitHubOrganizationCore {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    typeof value.login === 'string' &&
    typeof value.url === 'string'
  )
}

function isGitHubRepositoryCore(value: GitHubRepositoryCore | null): value is GitHubRepositoryCore {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    typeof value.nameWithOwner === 'string' &&
    typeof value.url === 'string'
  )
}
