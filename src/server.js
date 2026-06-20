import http from 'node:http';

import {
  buildChatGoal,
  createOpenAIChatCompletion,
  mapGitLabModelsToOpenAI,
  openAIError,
} from './openai.js';

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw openAIError('Invalid JSON body', 'invalid_request_error', 400, 'invalid_json');
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendEventStream(response, completion) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const base = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
  };
  const content = completion.choices?.[0]?.message?.content ?? '';

  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function normalizeThrownError(error) {
  if (error?.body?.error && error?.status) return error;
  return openAIError(error?.message || String(error), 'api_error', 500);
}

async function runGitLabChat({ gitlabClient, model, messages }) {
  const goal = buildChatGoal(messages ?? []);
  if (!goal) {
    throw openAIError('messages must contain at least one text message', 'invalid_request_error', 400);
  }

  const { workflowId } = await gitlabClient.createDuoWorkflow({ goal, model });
  const streamResult = await gitlabClient.startDuoWorkflow({ workflowId, goal, model });
  const result = streamResult?.content
    ? streamResult
    : await gitlabClient.waitForDuoWorkflowResult(workflowId);

  return { workflowId, content: result.content, status: result.status };
}

function responsesInputToMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') return { role: 'user', content: item };
      return {
        role: item?.role || 'user',
        content: item?.content ?? item?.text ?? '',
      };
    });
  }
  if (input == null) return [];
  return [{ role: 'user', content: String(input) }];
}

function createOpenAIResponse({ model, workflowId, content, status }) {
  const created = Math.floor(Date.now() / 1000);
  const shortWorkflowId = String(workflowId ?? '').split('/').pop() || String(created);
  return {
    id: `resp-gitlab-${shortWorkflowId}`,
    object: 'response',
    created_at: created,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [
      {
        id: `msg-gitlab-${shortWorkflowId}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: content ?? '',
            annotations: [],
          },
        ],
      },
    ],
    output_text: content ?? '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
    gitlab: {
      workflow_id: workflowId,
      status,
    },
  };
}

export function createServer({ gitlabClient, logger = console } = {}) {
  if (!gitlabClient) throw new Error('gitlabClient is required');

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, {
          ok: true,
          service: 'gitlab-duo-local-relay',
          graphql_url: gitlabClient.graphqlUrl,
          namespace_id: gitlabClient.namespaceId,
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const models = await gitlabClient.getAvailableModels();
        return sendJson(response, 200, mapGitLabModelsToOpenAI(models));
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJson(request);
        const model = body.model || process.env.GITLAB_DEFAULT_MODEL_REF || 'gitlab-default';
        const result = await runGitLabChat({ gitlabClient, model, messages: body.messages ?? [] });
        const completion = createOpenAIChatCompletion({
          model,
          workflowId: result.workflowId,
          content: result.content,
          status: result.status,
        });
        if (body.stream) return sendEventStream(response, completion);
        return sendJson(response, 200, completion);
      }

      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readJson(request);
        const model = body.model || process.env.GITLAB_DEFAULT_MODEL_REF || 'gitlab-default';
        const result = await runGitLabChat({
          gitlabClient,
          model,
          messages: body.messages ?? responsesInputToMessages(body.input),
        });
        return sendJson(response, 200, createOpenAIResponse({
          model,
          workflowId: result.workflowId,
          content: result.content,
          status: result.status,
        }));
      }

      return sendJson(response, 404, openAIError(`No route for ${request.method} ${url.pathname}`, 'invalid_request_error', 404).body);
    } catch (error) {
      const normalized = normalizeThrownError(error);
      logger.error?.('[gitlab-relay] request failed', normalized.body?.error?.message ?? error);
      return sendJson(response, normalized.status, normalized.body);
    }
  });
}
