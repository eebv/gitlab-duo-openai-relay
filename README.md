# GitLab Duo Local Relay

本地 OpenAI-compatible 包装层，把调用转换成 GitLab Duo 网页端同款请求。

## Security note

Before publishing or sharing this project, do not include local runtime artifacts:

- `.env`
- raw browser captures / HAR / DevTools exports
- `.tmp/`
- compressed local backups such as `.rar`, `.zip`, `.7z`
- local handoff or operation logs

The committed examples intentionally use placeholders such as `change-me` and
`gid://gitlab/Group/<YOUR_GROUP_ID>`.

## Agent install

If you want another AI agent to install this project end-to-end, give it
[`INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md). That file contains the
copy-paste PowerShell steps, required user-provided values, validation commands,
and troubleshooting flow.

## 当前状态

已完成最小可用闭环：

- `GET /health`
- `GET /v1/models` -> GitLab `getAiChatAvailableModels`
- `POST /v1/chat/completions`
  - `createAiDuoWorkflow`
  - `wss://gitlab.com/api/v4/ai/duo_workflows/ws`
  - 非默认基础模型通过 `user_selected_model_identifier=<model ref>` 传给 GitLab WebSocket
  - 解析 `newCheckpoint.channel_values.ui_chat_log`
  - 返回 OpenAI-compatible assistant message
- `stream=true` 已做兼容：内部仍等待 GitLab 完整回复，然后以 OpenAI SSE chunk 格式返回，解决工具默认流式探活失败。
- `POST /v1/responses` 已做最小兼容：把 `input` 转成 GitLab chat goal，返回 Responses API 形态。

已用固定 Chrome `9223` 登录态验证过该流程，默认不需要手工复制 Cookie：

```json
{
  "status": 200,
  "content": "pong",
  "gitlab": {
    "workflow_id": "gid://gitlab/Ai::DuoWorkflows::Workflow/<workflow_id>",
    "status": "INPUT_REQUIRED"
  }
}
```

## 主要模型

模型列表以运行时 `GET /v1/models` 返回为准，不同 GitLab 账号、订阅、namespace
和 GitLab 后端灰度可能不同。常见可用模型 ref 包括：

| Model ref | 说明 |
|---|---|
| `gitlab-default` | relay 默认别名，使用当前 GitLab Duo 默认模型 |
| `claude_sonnet_4_6_vertex` | Claude Sonnet 4.6，Vertex / Gemini Enterprise Agent Platform 路由 |
| `claude_sonnet_4_6` | Claude Sonnet 4.6，基础路由 |
| `claude_sonnet_4_6_bedrock` | Claude Sonnet 4.6，Bedrock 路由 |
| `claude_opus_4_8` | Claude Opus 4.8，基础路由 |
| `claude_opus_4_8_vertex` | Claude Opus 4.8，Vertex / Gemini Enterprise Agent Platform 路由 |
| `claude_opus_4_8_bedrock` | Claude Opus 4.8，Bedrock 路由 |
| `gpt_5_4` | GPT-5.4 |
| `gpt_5_5` | GPT-5.5 |
| `gemini_3_5_flash_vertex` | Gemini 3.5 Flash，Vertex 路由 |

建议安装完成后先执行：

```powershell
Invoke-RestMethod `
  -Uri http://127.0.0.1:8048/v1/models `
  -Headers @{ Authorization = 'Bearer local-dev-key' }
```

然后使用返回的 `id` 作为 `/v1/chat/completions` 或 `/v1/responses` 的
`model` 值。

## 配置

默认鉴权方式：relay 会自动连接固定 Codex Chrome CDP `127.0.0.1:9223`，从已登录的 `https://gitlab.com/` 标签读取：

- Cookie
- `meta[name="csrf-token"]`
- User-Agent

因此正常只需要保持固定 Chrome 9223 中 GitLab 已登录。复制 `.env.example` 中的变量到当前 shell：

```powershell
$env:PORT='8048'
$env:GITLAB_RELAY_API_KEY='change-me'
$env:GITLAB_GRAPHQL_URL='https://gitlab.com/api/graphql'
$env:GITLAB_NAMESPACE_ID='gid://gitlab/Group/<YOUR_GROUP_ID>'
$env:GITLAB_DEFAULT_MODEL_REF='claude_sonnet_4_6_vertex'
$env:GITLAB_BROWSER_AUTH='1'
$env:GITLAB_CHROME_CDP_HOST='127.0.0.1'
$env:GITLAB_CHROME_CDP_PORT='9223'
$env:GITLAB_WORKFLOW_TIMEOUT_MS='150000'
$env:GITLAB_WORKFLOW_POLL_INTERVAL_MS='3000'
$env:GITLAB_WORKFLOW_WS_TIMEOUT_MS='8000'
```

说明：

- 当前 relay 不强制校验客户端 API Key；如果工具必须填写 OpenAI API Key，填你自己的本地占位值即可，例如 `local-dev-key`。
- 自动鉴权会在进程内缓存；如果 GitLab 返回 `401/403`、`bad csrf` 等认证失败，relay 会清空缓存，从 Chrome `9223` 重新读取 Cookie/CSRF，并自动重试一次。
- 如需禁用浏览器自动鉴权，设置 `GITLAB_BROWSER_AUTH=0`，并同时提供 `GITLAB_COOKIE` / `GITLAB_CSRF_TOKEN`。
- 基础模型 ref（如 `claude_sonnet_4_6_vertex`）不会作为 `aiCatalogItemVersionId` 传给 create mutation；它用于 relay 侧模型标识/后续 WS 参数。
- 非默认基础模型 ref（如 `gpt_5_4`）会进入 WebSocket 查询参数 `user_selected_model_identifier`。
- 自定义 Agent 版本 ID 才属于 `AiCatalogItemVersionID`。

## 启动

```powershell
npm start
```

## 测试

```powershell
npm test
```

## 调用

```powershell
curl.exe -sS http://127.0.0.1:8048/health
curl.exe -sS http://127.0.0.1:8048/v1/models `
  -H "Authorization: Bearer local-dev-key"
curl.exe -sS http://127.0.0.1:8048/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer local-dev-key" `
  -d "{\"model\":\"gpt_5_4\",\"messages\":[{\"role\":\"user\",\"content\":\"ping，只回复 pong\"}]}"

curl.exe -sS http://127.0.0.1:8048/v1/responses `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer local-dev-key" `
  -d "{\"model\":\"gpt_5_4\",\"input\":\"ping，只回复 pong\"}"
```

预期返回：

```json
{
  "object": "chat.completion",
  "model": "gpt_5_4",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "pong"
      }
    }
  ]
}
```

## 已确认真实网页协议

GitLab Duo Chat 前端发送：

```text
POST /api/graphql
mutation createAiDuoWorkflow
```

随后连接：

```text
wss://gitlab.com/api/v4/ai/duo_workflows/ws?root_namespace_id=<namespace_id>&namespace_id=<namespace_id>&workflow_definition=chat&workflow_id=<id>&client_type=browser&user_selected_model_identifier=<model ref>
```

初始消息：

```json
{
  "startRequest": {
    "workflowID": "<numeric workflow id>",
    "clientVersion": "1.0",
    "workflowDefinition": "chat",
    "workflowMetadata": "{\"extended_logging\":false,\"is_team_member\":false,\"tool_approval_for_session_enabled\":true}",
    "clientCapabilities": ["incremental_streaming", "web_search"],
    "goal": "用户问题",
    "approval": {},
    "useOrbit": false,
    "additional_context": []
  }
}
```
