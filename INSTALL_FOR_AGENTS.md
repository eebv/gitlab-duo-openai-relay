# Agent install guide

This file is written for an AI coding agent. Give the agent this file and ask it
to install and verify the project end-to-end.

## Goal

Install `gitlab-duo-local-relay`, a local OpenAI-compatible HTTP relay for
GitLab Duo Chat.

The relay:

- reads GitLab web login state from a local Chrome/Chromium CDP session;
- calls GitLab GraphQL / Duo workflow APIs;
- exposes local OpenAI-compatible endpoints:
  - `GET /health`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/responses`

## Agent rules

Before running commands:

1. Do not ask for Cookie, CSRF token, GitLab password, or personal access token.
2. Ask the human only for `GITLAB_NAMESPACE_ID` if it is not already known.
3. Keep all secrets in local environment variables or `.env`; never commit them.
4. Do not upload `.env`, raw browser captures, `.tmp/`, archives, logs, or local
   handoff files.
5. Bind Chrome CDP and the relay to `127.0.0.1` only.

## Prerequisites

- Node.js `>=20`
- npm
- Chrome or Chromium
- A GitLab account with Duo Chat access
- A GitLab group/user namespace ID in GID format, for example:

```text
gid://gitlab/Group/<YOUR_GROUP_ID>
```

## 1. Clone and enter the repository

```powershell
git clone <REPOSITORY_URL>
cd <REPOSITORY_FOLDER>
```

If the repository is already present:

```powershell
cd <REPOSITORY_FOLDER>
```

## 2. Verify Node.js

```powershell
node -v
npm -v
```

If `node -v` is lower than `v20.0.0`, install or switch to Node.js 20+ before
continuing.

## 3. Install dependencies

This project currently uses only Node.js built-ins, but run install anyway so
future package metadata is honored:

```powershell
npm install
```

## 4. Start Chrome with CDP

The relay reads GitLab login state from Chrome DevTools Protocol.

Use an isolated browser profile. Replace the Chrome path if needed.

```powershell
$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
$profile = "$env:LOCALAPPDATA\gitlab-duo-relay-chrome-profile"

Start-Process -FilePath $chrome -ArgumentList @(
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9223',
  "--user-data-dir=$profile",
  'https://gitlab.com/'
)
```

Then log in to GitLab in that Chrome window and keep the tab open.

Verify CDP is reachable:

```powershell
Invoke-RestMethod http://127.0.0.1:9223/json | Select-Object -First 1
```

## 5. Configure environment

Create `.env` from the example if your workflow uses dotenv tooling:

```powershell
Copy-Item .env.example .env -ErrorAction SilentlyContinue
```

For a plain PowerShell session, set variables directly:

```powershell
$env:PORT = '8048'
$env:GITLAB_RELAY_API_KEY = 'local-dev-key'
$env:GITLAB_GRAPHQL_URL = 'https://gitlab.com/api/graphql'
$env:GITLAB_NAMESPACE_ID = 'gid://gitlab/Group/<YOUR_GROUP_ID>'
$env:GITLAB_DEFAULT_MODEL_REF = 'claude_sonnet_4_6_vertex'
$env:GITLAB_BROWSER_AUTH = '1'
$env:GITLAB_CHROME_CDP_HOST = '127.0.0.1'
$env:GITLAB_CHROME_CDP_PORT = '9223'
$env:GITLAB_WORKFLOW_TIMEOUT_MS = '150000'
$env:GITLAB_WORKFLOW_POLL_INTERVAL_MS = '3000'
$env:GITLAB_WORKFLOW_WS_TIMEOUT_MS = '8000'
```

Replace `gid://gitlab/Group/<YOUR_GROUP_ID>` with the target GitLab namespace
GID. Do not commit the real value if it identifies a private organization.

## 6. Run tests

```powershell
npm test
```

Expected result:

```text
tests 16
pass 16
fail 0
```

## 7. Start the relay

```powershell
npm start
```

Expected startup log:

```text
[gitlab-relay] listening on http://127.0.0.1:8048
[gitlab-relay] GraphQL: https://gitlab.com/api/graphql
```

Keep this terminal running.

## 8. Verify endpoints

Open a second terminal in the same environment.

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8048/health
```

Model list:

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:8048/v1/models `
  -Headers @{ Authorization = 'Bearer local-dev-key' }
```

Minimal chat:

```powershell
$body = @{
  model = 'gitlab-default'
  messages = @(
    @{ role = 'user'; content = 'ping, reply only pong' }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri http://127.0.0.1:8048/v1/chat/completions `
  -Method Post `
  -ContentType 'application/json' `
  -Headers @{ Authorization = 'Bearer local-dev-key' } `
  -Body $body
```

Expected content:

```text
pong
```

Responses API compatibility:

```powershell
$body = @{
  model = 'gitlab-default'
  input = 'ping, reply only pong'
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri http://127.0.0.1:8048/v1/responses `
  -Method Post `
  -ContentType 'application/json' `
  -Headers @{ Authorization = 'Bearer local-dev-key' } `
  -Body $body
```

## 9. Client configuration

Use this as an OpenAI-compatible local endpoint:

```text
Base URL: http://127.0.0.1:8048/v1
API Key: local-dev-key
Model: gitlab-default
```

If `/v1/models` returns selectable model refs, a client may use those refs as
the `model` value.

## 10. Main model refs

The authoritative model list is always `GET /v1/models`. GitLab may change
availability based on account, namespace, subscription, and rollout state.

Common refs seen in GitLab Duo Chat include:

| Model ref | Purpose |
|---|---|
| `gitlab-default` | Relay default alias; uses the GitLab Duo default model |
| `claude_sonnet_4_6_vertex` | Claude Sonnet 4.6 via Vertex / Gemini Enterprise Agent Platform route |
| `claude_sonnet_4_6` | Claude Sonnet 4.6 base route |
| `claude_sonnet_4_6_bedrock` | Claude Sonnet 4.6 via Bedrock route |
| `claude_opus_4_8` | Claude Opus 4.8 base route |
| `claude_opus_4_8_vertex` | Claude Opus 4.8 via Vertex / Gemini Enterprise Agent Platform route |
| `claude_opus_4_8_bedrock` | Claude Opus 4.8 via Bedrock route |
| `gpt_5_4` | GPT-5.4 |
| `gpt_5_5` | GPT-5.5 |
| `gemini_3_5_flash_vertex` | Gemini 3.5 Flash via Vertex route |

Agent instruction: after `/v1/models` succeeds, prefer a model ID returned by
that endpoint over a hard-coded example from this table.

## Troubleshooting

### `missing_gitlab_namespace_id`

Set `GITLAB_NAMESPACE_ID`.

```powershell
$env:GITLAB_NAMESPACE_ID = 'gid://gitlab/Group/<YOUR_GROUP_ID>'
```

### `gitlab_browser_tab_not_found`

Open `https://gitlab.com/` in the Chrome instance running on CDP port `9223`,
log in, and retry.

### `gitlab_browser_auth_unavailable`

Check CDP:

```powershell
Invoke-RestMethod http://127.0.0.1:9223/json
```

If this fails, restart Chrome with:

```text
--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223
```

### `missing_gitlab_cookie` or `missing_gitlab_csrf`

The GitLab tab is not logged in or the page has not loaded completely. Refresh
the GitLab tab and retry.

### `401`, `403`, or `bad csrf`

The relay automatically refreshes browser auth once. If it still fails:

1. Refresh the GitLab tab.
2. Confirm the account still has Duo Chat access.
3. Restart the relay.

### Port conflict on `8048`

```powershell
Get-NetTCPConnection -LocalPort 8048 -ErrorAction SilentlyContinue
```

Either stop the conflicting process or choose another port:

```powershell
$env:PORT = '8049'
npm start
```

## Security checklist for the installing agent

Before handing off:

```powershell
npm test
rg -n --hidden -i "(glpat-|ghp_|_gitlab_session=|remember_user_token|cf_clearance|private-token|authorization: bearer)" .
```

The scan should only match fake fixtures or documentation placeholders.

Never print or save real Cookie / CSRF / token values in the final response.
