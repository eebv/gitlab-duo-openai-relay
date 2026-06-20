import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChatGoal,
  createOpenAIChatCompletion,
  extractAssistantContentFromWorkflow,
  mapGitLabModelsToOpenAI,
  openAIError,
} from '../src/openai.js';
import {
  buildDuoWorkflowStartRequest,
  buildDuoWorkflowWsUrl,
  createGitLabClient,
  fetchGitLabAuthFromChrome,
  extractAssistantContentFromWorkflowEvent,
  extractWorkflowNumericId,
} from '../src/gitlab-client.js';
import { createServer } from '../src/server.js';

test('buildChatGoal converts OpenAI messages into a readable GitLab goal', () => {
  const goal = buildChatGoal([
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'ping' },
    { role: 'assistant', content: 'pong' },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ]);

  assert.match(goal, /System: Be concise/);
  assert.match(goal, /User: ping/);
  assert.match(goal, /Assistant: pong/);
  assert.match(goal, /User: again/);
});

test('mapGitLabModelsToOpenAI exposes selectable GitLab model refs as OpenAI model ids', () => {
  const mapped = mapGitLabModelsToOpenAI({
    defaultModel: {
      name: 'Claude Sonnet 4.6 - Vertex',
      ref: 'claude_sonnet_4_6_vertex',
      modelProvider: 'Gemini Enterprise Agent Platform',
    },
    selectableModels: [
      {
        name: 'GPT-5.4 - OpenAI',
        ref: 'gpt_5_4',
        modelProvider: 'OpenAI',
        modelDescription: 'frontier',
      },
    ],
  });

  assert.equal(mapped.object, 'list');
  assert.deepEqual(
    mapped.data.map((model) => model.id),
    ['claude_sonnet_4_6_vertex', 'gpt_5_4'],
  );
  assert.equal(mapped.data[0].owned_by, 'Gemini Enterprise Agent Platform');
});

test('createGitLabClient sends auth headers and normalizes GraphQL errors', async () => {
  const calls = [];
  const client = createGitLabClient({
    env: {
      GITLAB_COOKIE: 'gitlab_session_fixture=test',
      GITLAB_CSRF_TOKEN: 'csrf',
      GITLAB_GRAPHQL_URL: 'https://gitlab.example/api/graphql',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          errors: [{ message: 'bad csrf' }],
        }),
        text: async () => '{"errors":[{"message":"bad csrf"}]}',
      };
    },
  });

  await assert.rejects(
    () => client.graphql('query Example { x }', {}),
    (error) => error.body?.error?.message === 'bad csrf',
  );
  assert.equal(calls[0].url, 'https://gitlab.example/api/graphql');
  assert.equal(calls[0].init.headers.Cookie, 'gitlab_session_fixture=test');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf');
});

test('createGitLabClient can load GitLab auth from browser provider when env auth is absent', async () => {
  const calls = [];
  const client = createGitLabClient({
    env: {
      GITLAB_GRAPHQL_URL: 'https://gitlab.example/api/graphql',
      GITLAB_NAMESPACE_ID: 'gid://gitlab/Group/12345',
    },
    browserAuthProvider: async () => ({
      cookie: 'gitlab_session_fixture=from_browser',
      csrfToken: 'csrf-from-browser',
      userAgent: 'Browser UA',
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            aiChatAvailableModels: {
              defaultModel: { name: 'Claude', ref: 'claude_sonnet_4_6_vertex' },
              selectableModels: [],
            },
          },
        }),
      };
    },
  });

  await client.getAvailableModels();

  assert.equal(calls[0].init.headers.Cookie, 'gitlab_session_fixture=from_browser');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'csrf-from-browser');
  assert.equal(calls[0].init.headers['User-Agent'], 'Browser UA');
});

test('createGitLabClient refreshes browser auth once when cached GitLab auth is rejected', async () => {
  const calls = [];
  const browserAuths = [
    {
      cookie: 'gitlab_session_fixture=expired',
      csrfToken: 'expired-csrf',
      userAgent: 'Browser UA',
    },
    {
      cookie: 'gitlab_session_fixture=fresh',
      csrfToken: 'fresh-csrf',
      userAgent: 'Browser UA',
    },
  ];
  const client = createGitLabClient({
    env: {
      GITLAB_GRAPHQL_URL: 'https://gitlab.example/api/graphql',
      GITLAB_NAMESPACE_ID: 'gid://gitlab/Group/12345',
    },
    browserAuthProvider: async () => browserAuths.shift(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({
            errors: [{ message: 'bad csrf' }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            aiChatAvailableModels: {
              defaultModel: { name: 'Claude', ref: 'claude_sonnet_4_6_vertex' },
              selectableModels: [],
            },
          },
        }),
      };
    },
  });

  const models = await client.getAvailableModels();

  assert.equal(models.defaultModel.ref, 'claude_sonnet_4_6_vertex');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Cookie, 'gitlab_session_fixture=expired');
  assert.equal(calls[0].init.headers['X-CSRF-Token'], 'expired-csrf');
  assert.equal(calls[1].init.headers.Cookie, 'gitlab_session_fixture=fresh');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'fresh-csrf');
});

test('fetchGitLabAuthFromChrome reads csrf, cookie, and user-agent from GitLab tab', async () => {
  const sent = [];
  const auth = await fetchGitLabAuthFromChrome({
    cdpPort: 9223,
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:9223/json');
      return {
        ok: true,
        status: 200,
        json: async () => [
          { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1' },
          { type: 'page', url: 'https://gitlab.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/gitlab' },
        ],
      };
    },
    cdpClientFactory: async (wsUrl) => {
      assert.equal(wsUrl, 'ws://127.0.0.1:9223/devtools/page/gitlab');
      return {
        send: async (method) => {
          sent.push(method);
          if (method === 'Runtime.evaluate') {
            return {
              result: {
                result: {
                  value: {
                    csrf: 'csrf-from-page',
                    userAgent: 'Browser UA',
                    username: 'test-user',
                  },
                },
              },
            };
          }
          if (method === 'Network.getCookies') {
            return {
              result: {
                cookies: [
                  { name: 'gitlab_session_fixture', value: 'abc' },
                  { name: 'preferred_language', value: 'en' },
                ],
              },
            };
          }
          throw new Error(`unexpected ${method}`);
        },
        close() {},
      };
    },
  });

  assert.deepEqual(sent, ['Runtime.evaluate', 'Network.getCookies']);
  assert.equal(auth.cookie, 'gitlab_session_fixture=abc; preferred_language=en');
  assert.equal(auth.csrfToken, 'csrf-from-page');
  assert.equal(auth.userAgent, 'Browser UA');
});

test('createDuoWorkflow does not send foundational model refs as aiCatalogItemVersionId', async () => {
  let variables;
  const client = createGitLabClient({
    env: {
      GITLAB_COOKIE: 'gitlab_session_fixture=test',
      GITLAB_CSRF_TOKEN: 'csrf',
      GITLAB_GRAPHQL_URL: 'https://gitlab.example/api/graphql',
      GITLAB_NAMESPACE_ID: 'gid://gitlab/Group/12345',
    },
    fetchImpl: async (_url, init) => {
      variables = JSON.parse(init.body).variables;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            aiDuoWorkflowCreate: {
              workflow: { id: 'gid://gitlab/Ai::DuoWorkflows::Workflow/1' },
              errors: [],
            },
          },
        }),
      };
    },
  });

  await client.createDuoWorkflow({ goal: 'ping', model: 'claude_sonnet_4_6_vertex' });

  assert.equal(variables.aiCatalogItemVersionId, undefined);
});

test('buildDuoWorkflowStartRequest matches GitLab frontend startRequest shape', () => {
  const payload = buildDuoWorkflowStartRequest({
    workflowId: 'gid://gitlab/Ai::DuoWorkflows::Workflow/123456',
    goal: 'ping',
    workflowDefinition: 'chat',
  });

  assert.deepEqual(payload, {
    startRequest: {
      workflowID: '123456',
      clientVersion: '1.0',
      workflowDefinition: 'chat',
      workflowMetadata: '{"extended_logging":false,"is_team_member":false,"tool_approval_for_session_enabled":true}',
      clientCapabilities: ['incremental_streaming', 'web_search'],
      goal: 'ping',
      approval: {},
      useOrbit: false,
      additional_context: [],
    },
  });
});

test('extractAssistantContentFromWorkflowEvent reads streamed agent checkpoint content', () => {
  const event = {
    newCheckpoint: {
      status: 'INPUT_REQUIRED',
      checkpoint: JSON.stringify({
        channel_values: {
          ui_chat_log: [
            { message_type: 'user', content: 'ping' },
            { message_type: 'agent', content: 'pong' },
          ],
        },
      }),
    },
  };

  assert.deepEqual(extractAssistantContentFromWorkflowEvent(JSON.stringify(event)), {
    content: 'pong',
    status: 'INPUT_REQUIRED',
  });
});

test('buildDuoWorkflowWsUrl includes browser query parameters used by GitLab frontend', () => {
  const url = buildDuoWorkflowWsUrl({
    baseUrl: 'https://gitlab.example/api/v4/ai/duo_workflows/ws',
    namespaceId: 'gid://gitlab/Group/12345',
    workflowDefinition: 'chat',
    workflowId: 'gid://gitlab/Ai::DuoWorkflows::Workflow/123456',
  });

  assert.equal(url.origin, 'https://gitlab.example');
  assert.equal(url.pathname, '/api/v4/ai/duo_workflows/ws');
  assert.equal(url.searchParams.get('namespace_id'), '12345');
  assert.equal(url.searchParams.get('workflow_definition'), 'chat');
  assert.equal(url.searchParams.get('workflow_id'), '123456');
  assert.equal(url.searchParams.get('client_type'), 'browser');
});

test('buildDuoWorkflowWsUrl uses GitLab frontend parameter for selected foundational model', () => {
  const url = buildDuoWorkflowWsUrl({
    baseUrl: 'https://gitlab.example/api/v4/ai/duo_workflows/ws',
    rootNamespaceId: 'gid://gitlab/Group/12345',
    namespaceId: 'gid://gitlab/Group/12345',
    workflowDefinition: 'chat',
    workflowId: 'gid://gitlab/Ai::DuoWorkflows::Workflow/123456',
    model: 'gpt_5_4',
    defaultModel: 'claude_sonnet_4_6_vertex',
  });

  assert.equal(url.searchParams.get('user_selected_model_identifier'), 'gpt_5_4');
  assert.equal(url.searchParams.get('model'), null);
});

test('extractAssistantContentFromWorkflow reads final assistant text from latest checkpoint', () => {
  const content = extractAssistantContentFromWorkflow({
    duoWorkflowWorkflows: {
      edges: [
        {
          node: {
            status: 'FINISHED',
            latestCheckpoint: {
              duoMessages: [
                { role: 'user', content: 'ping' },
                { role: 'assistant', content: 'pong' },
              ],
            },
          },
        },
      ],
    },
  });

  assert.equal(content, 'pong');
});

test('extractWorkflowNumericId accepts gid and numeric ids', () => {
  assert.equal(extractWorkflowNumericId('gid://gitlab/Ai::DuoWorkflows::Workflow/123456'), 123456);
  assert.equal(extractWorkflowNumericId('123456'), 123456);
});

test('createOpenAIChatCompletion returns assistant content when available', () => {
  const response = createOpenAIChatCompletion({
    model: 'claude_sonnet_4_6_vertex',
    workflowId: 'gid://gitlab/Ai::DuoWorkflows::Workflow/123457',
    content: 'pong',
  });

  assert.equal(response.object, 'chat.completion');
  assert.equal(response.model, 'claude_sonnet_4_6_vertex');
  assert.equal(response.choices[0].message.content, 'pong');
});

test('openAIError produces OpenAI-compatible error objects', () => {
  const err = openAIError('missing auth', 'authentication_error', 401);
  assert.equal(err.status, 401);
  assert.equal(err.body.error.message, 'missing auth');
  assert.equal(err.body.error.type, 'authentication_error');
});

test('HTTP server exposes health, models, and chat completion routes', async () => {
  const gitlabClient = {
    graphqlUrl: 'https://gitlab.example/api/graphql',
    namespaceId: 'gid://gitlab/Group/1',
    getAvailableModels: async () => ({
      defaultModel: {
        name: 'Claude Sonnet 4.6 - Vertex',
        ref: 'claude_sonnet_4_6_vertex',
        modelProvider: 'Gemini Enterprise Agent Platform',
      },
      selectableModels: [],
    }),
    createDuoWorkflow: async ({ goal, model }) => {
      assert.match(goal, /User: ping/);
      assert.equal(model, 'claude_sonnet_4_6_vertex');
      return { workflowId: 'gid://gitlab/Ai::DuoWorkflows::Workflow/1' };
    },
    startDuoWorkflow: async ({ workflowId, goal }) => {
      assert.equal(workflowId, 'gid://gitlab/Ai::DuoWorkflows::Workflow/1');
      assert.match(goal, /User: ping/);
    },
    waitForDuoWorkflowResult: async (workflowId) => {
      assert.equal(workflowId, 'gid://gitlab/Ai::DuoWorkflows::Workflow/1');
      return { content: 'pong', status: 'FINISHED' };
    },
  };

  const server = createServer({
    gitlabClient,
    logger: { error() {} },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then((r) => r.json());
    assert.equal(models.data[0].id, 'claude_sonnet_4_6_vertex');

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude_sonnet_4_6_vertex',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    }).then((r) => r.json());

    assert.equal(chat.object, 'chat.completion');
    assert.equal(chat.choices[0].message.content, 'pong');
    assert.equal(chat.gitlab.workflow_id, 'gid://gitlab/Ai::DuoWorkflows::Workflow/1');

    const stream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude_sonnet_4_6_vertex',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const streamText = await stream.text();
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.match(streamText, /"object":"chat\.completion\.chunk"/);
    assert.match(streamText, /"content":"pong"/);
    assert.match(streamText, /data: \[DONE\]/);

    const responses = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude_sonnet_4_6_vertex',
        input: 'ping',
      }),
    }).then((r) => r.json());

    assert.equal(responses.object, 'response');
    assert.equal(responses.output_text, 'pong');
    assert.equal(responses.output[0].content[0].text, 'pong');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
