# shiplog

Daily GitHub activity snapshots into your own Postgres, rendered back into a profile README.

shiplog is a forkable profile-README pipeline. You own the database, GitHub Actions keeps it fresh, and the renderer publishes the generated README to the repository you choose.

## Why shiplog?

Why not?

People care about control over their own data. Your contribution history is part of that data too, and it should not only live inside a platform-owned graph.

shiplog gives you your own contribution archive and one umbrella for activity across platforms. GitHub is supported first, and the shape is built so more providers can fit later.

## Start Here

- [Setup guide](SETUP_GUIDE.md): fork the repo, create the database, configure tokens, and run the workflows.
- [Config builder](https://shiplog.karanbalani.tech/config-builder/): generate `shiplog.config.json` and the Base64 value for workflows.
- [Example config](shiplog.config.example.json): copy this when creating your own `shiplog.config.json`.
- [Config schema](schemas/shiplog.config.schema.json): full JSON schema for the config file.
- [FAQ](docs/FAQ.md): common setup and operations questions.

## What It Does

- Collects GitHub commits, pull requests, reviews, issues, repositories, languages, and organization context.
- Stores activity in Postgres with historical tables and daily rollups.
- Runs scheduled GitHub Actions for freshness, history, integrity repair, rendering, and publishing.
- Uses stable GitHub IDs so username, organization, and repository renames do not split history.

## Useful Docs

- [Setup guide](SETUP_GUIDE.md): run shiplog in your own fork.
- [Schema](docs/SCHEMA.md): database tables, views, and timestamp semantics.
- [GitHub mapping](docs/GITHUB_MAPPING.md): how GitHub data maps into shiplog.
- [Conventions](docs/CONVENTIONS.md): project naming and implementation conventions.
- [Contributing](CONTRIBUTING.md): development workflow for changing shiplog itself.

## Main Commands

```bash
bun run init
bun run backfill
bun run collect
bun run drift
bun run maintenance
bun run render
bun run publish
```

For the full setup flow, use [SETUP_GUIDE.md](SETUP_GUIDE.md).
