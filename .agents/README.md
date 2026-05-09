# Agent Guide

AI agents working on shiplog should read these files before making changes:

1. `docs/CONVENTIONS.md`
2. `docs/SCHEMA.md`
3. `docs/GITHUB_MAPPING.md`
4. `README.md`

Follow the conventions in `docs/CONVENTIONS.md` unless the user explicitly changes them.

## Working Rules

- Do not make code or schema changes without user approval when the user asks for step-by-step review.
- Prefer one small migration per table or view.
- Name migrations as `<timestamp>_<up_action>_<object_type>_<object_name>.sql`.
- Follow the domain language and type naming rules in `docs/CONVENTIONS.md`.
- Keep schema names provider-neutral.
- Keep GitHub-specific terminology in GitHub collector code and `docs/GITHUB_MAPPING.md`.
- Run `bun run format:check` before committing.
- Run `bun run typecheck` before committing once TypeScript source files exist.
- Validate migrations with the available local smoke tests.
- Use Conventional Commit messages.
- Use lowercase-only commit messages.
