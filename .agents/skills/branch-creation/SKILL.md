---
name: branch-creation
description: "Create a Git feature branch from the configured base branch. Use when starting work, creating a new branch, or when the user asks to branch from main. Branch names use the dahinger-<workdesc> format by default."
argument-hint: "[work description]"
user-invocable: true
---

# Branch Creation

Create a new work branch from the base branch configured in [branch-settings.yml](./branch-settings.yml).

## Procedure

1. Read `base_branch` and `branch_prefix` from [branch-settings.yml](./branch-settings.yml). The defaults are `main` and `dahinger-`.
2. Obtain the work description from the user if it was not supplied as the skill argument.
3. Convert the work description into a concise lowercase kebab-case slug:
   - Remove punctuation and unsupported characters.
   - Replace whitespace or repeated separators with `-`.
   - Trim leading and trailing hyphens.
4. Build the branch name as `<branch_prefix><slug>`, for example `dahinger-add-invoice-sync`.
5. Confirm the working tree is clean before switching branches. If it is not clean, stop and report the changed files instead of stashing or discarding changes.
6. Update the local base branch and create the work branch:

   ```powershell
   git switch <base_branch>
   git pull --ff-only origin <base_branch>
   git switch -c <branch_prefix><slug>
   ```

7. Report the created branch and its base branch.

## Configuration

Edit [branch-settings.yml](./branch-settings.yml) whenever the base branch or naming prefix should change. `main` is the default base branch.

Do not delete, reset, force-switch, or overwrite existing branches. If the generated branch already exists, stop and ask for a different work description.
