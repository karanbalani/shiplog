export const VIEWER_AND_USER = `
query ViewerAndUser($login: String!) {
  viewer { login }
  user(login: $login) {
    id login name url createdAt
  }
}
`

export const CONTRIBUTIONS_COLLECTION = `
query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      commitContributionsByRepository(maxRepositories: 100) {
        repository {
          id nameWithOwner
          owner {
            __typename
            id
            login
            ... on Organization {
              name
              description
              avatarUrl
              websiteUrl
            }
          }
          isPrivate isFork isArchived
          primaryLanguage { name }
          stargazerCount forkCount
          createdAt pushedAt
          defaultBranchRef { name }
          url description
        }
        contributions(first: 1) { totalCount }
      }
      pullRequestContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner owner { __typename id login ... on Organization { name description avatarUrl websiteUrl } } isPrivate isFork isArchived primaryLanguage { name } defaultBranchRef { name } url description createdAt pushedAt }
        contributions(first: 1) { totalCount }
      }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner owner { __typename id login ... on Organization { name description avatarUrl websiteUrl } } isPrivate isFork isArchived primaryLanguage { name } defaultBranchRef { name } url description createdAt pushedAt }
        contributions(first: 1) { totalCount }
      }
      issueContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner owner { __typename id login ... on Organization { name description avatarUrl websiteUrl } } isPrivate isFork isArchived primaryLanguage { name } defaultBranchRef { name } url description createdAt pushedAt }
        contributions(first: 1) { totalCount }
      }
    }
  }
}
`

export const REPOSITORY_COMMITS_IN_WINDOW = `
query RepositoryCommits($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor, since: $since, until: $until) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              oid committedDate
              additions deletions changedFiles
              messageHeadline
              author { name email user { id login } }
              authors(first: 100) {
                nodes { name email user { id login } }
              }
            }
          }
        }
      }
    }
  }
}
`

export const REPOSITORY_LANGUAGES = `
query RepositoryLanguages($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id stargazerCount forkCount isArchived isPrivate
    primaryLanguage { name }
    languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
      edges { size node { name } }
    }
  }
}
`
