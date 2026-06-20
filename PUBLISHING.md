# Publishing checklist

Use this checklist before creating a public GitHub repository.

## Recommended repository names

- `gitlab-duo-openai-relay` **(selected default)**
- `duo-graphql-openai-bridge`
- `gitlab-duo-local-gateway`

## Files that must not be uploaded

- `.env`
- `.tmp/`
- raw DevTools / browser capture files, for example `*-2026-*.json`
- packaged local backups, for example `*.rar`, `*.zip`, `*.7z`
- `PROJECT_CONTEXT.md`
- `HANDOFF.md`
- `OPERATION_LOG.md`
- logs, heap snapshots, network request/response dumps

## Recommended docs to include

- `README.md`
- `INSTALL_FOR_AGENTS.md`
- `PUBLISHING.md`

## Required local configuration

Copy `.env.example` and set your own values locally:

```text
GITLAB_RELAY_API_KEY=change-me
GITLAB_NAMESPACE_ID=gid://gitlab/Group/<YOUR_GROUP_ID>
```

Do not commit real Cookie, CSRF token, GitLab session, GitHub token, or personal
namespace values.

## Pre-push checks

```powershell
npm test
rg -n --hidden -i "(glpat-|ghp_|_gitlab_session=|remember_user_token|cf_clearance|private-token|authorization: bearer)" .
```

The second command should only match fake test fixtures or documentation
placeholders.
