# Contributing to postman-api-onboarding-action

Thank you for your interest in contributing. This guide covers the workflow and standards for submitting changes.

## Getting Started

1. Fork and clone the repository
2. Install dependencies: `npm ci`
3. Create a feature branch: `git checkout -b my-change`

## Development Workflow

```bash
npm ci              # Install dependencies
npm test            # Run tests (vitest)
npm run typecheck   # TypeScript type checking
npm run lint        # ESLint
```

## Before Submitting a PR

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] Changes are focused and address a single concern
- [ ] New functionality includes tests

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). All commits must follow this format:

```
<type>: <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`, `revert`

**Examples:**

```
feat: add retry logic to spec upload
fix: handle 429 rate limit in API client
docs: update CLI usage examples
ci: add ESLint to CI workflow
```

Commit messages are validated in CI via commitlint. Optionally install git hooks locally for faster feedback -- see [Local Git Hooks](#local-git-hooks).

## Local Git Hooks (Optional)

For commit message validation before push:

```bash
npx husky init
echo 'npx --no-install commitlint --edit "$1"' > .husky/commit-msg
```

This is optional. CI validates commit messages on every pull request regardless.

## Code Style

- TypeScript strict mode
- ESLint enforced (run `npm run lint` or `npm run lint:fix`)
- Keep changes minimal and focused
- Match existing patterns in the codebase

## Reporting Issues

Use the GitHub issue templates for bug reports and feature requests. For questions, open a Discussion thread.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
