## Agent skills

### Starting new work

Before the first edit for each new task, create and switch to a local feature branch using the base and prefix in [branch settings](.agents/skills/branch-creation/branch-settings.yml). A request to start new work authorizes this step. Continue follow-up fixes and review on the same task branch. Publish a branch only when the user asks.

### Implementation and documentation

Before implementing features, fixing bugs, refactoring, or changing configuration/deployment, read [docs/agents/documentation.md](docs/agents/documentation.md). Use its context map before coding and complete its documentation checks in the same change. For documentation-only work, use it to identify the authoritative document and validate affected links and claims.

For build, run and test questions or actions, follow the npm workflow in [CONTRIBUTING.md](CONTRIBUTING.md) and verify current command behavior against [package.json](package.json) and the referenced configuration.

### Issue tracker

Issues and specs live in GitHub Issues for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses single-context domain docs. See `docs/agents/domain.md`.
