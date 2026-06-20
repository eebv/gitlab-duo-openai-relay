import { openAIError } from './openai.js';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes, createHash } from 'node:crypto';

const DEFAULT_GRAPHQL_URL = 'https://gitlab.com/api/graphql';
const DEFAULT_DUO_WORKFLOWS_WS_URL = 'https://gitlab.com/api/v4/ai/duo_workflows/ws';
const DEFAULT_NAMESPACE_ID = '';
const DEFAULT_CHROME_CDP_HOST = '127.0.0.1';
const DEFAULT_CHROME_CDP_PORT = 9223;
const TERMINAL_WORKFLOW_STATUSES = new Set(['FINISHED', 'FAILED', 'STOPPED']);

export const GET_AI_CHAT_AVAILABLE_MODELS = `
query getAiChatAvailableModels($rootNamespaceId: GroupID, $namespaceId: GroupID, $projectId: ProjectID) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId, namespaceId: $namespaceId, projectId: $projectId) {
    defaultModel {
      name
      ref
      modelProvider
      __typename
    }
    selectableModels {
      name
      ref
      modelProvider
      modelDescription
      costIndicator
      __typename
    }
    pinnedModel {
      name
      ref
      __typename
    }
    __typename
  }
}`;

export const CREATE_AI_DUO_WORKFLOW = `
mutation createAiDuoWorkflow(
  $projectId: ProjectID,
  $namespaceId: NamespaceID,
  $goal: String!,
  $workflowDefinition: String!,
  $agentPrivileges: [Int!],
  $preApprovedAgentPrivileges: [Int!],
  $allowAgentToRequestUser: Boolean,
  $aiCatalogItemVersionId: AiCatalogItemVersionID
) {
  aiDuoWorkflowCreate(
    input: {
      projectId: $projectId,
      namespaceId: $namespaceId,
      environment: WEB,
      goal: $goal,
      workflowDefinition: $workflowDefinition,
      agentPrivileges: $agentPrivileges,
      preApprovedAgentPrivileges: $preApprovedAgentPrivileges,
      allowAgentToRequestUser: $allowAgentToRequestUser,
      aiCatalogItemVersionId: $aiCatalogItemVersionId
    }
  ) {
    workflow {
      id
      __typename
    }
    errors
    __typename
  }
}`;

function missingAuthError(message, code) {
  return openAIError(
    message,
    'authentication_error',
    401,
    code,
  );
}

function requiredAuth(auth) {
  if (!auth.cookie) {
    throw openAIError(
      'Missing GITLAB_COOKIE. Export browser GitLab session cookie or keep GitLab open in the fixed Chrome 9223 browser.',
      'authentication_error',
      401,
      'missing_gitlab_cookie',
    );
  }
  if (!auth.csrfToken) {
    throw missingAuthError(
      'Missing GITLAB_CSRF_TOKEN. Copy it from GitLab page meta csrf-token or keep GitLab open in the fixed Chrome 9223 browser.',
      'missing_gitlab_csrf',
    );
  }
}

function graphQLErrorMessage(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    return payload.errors
      .map((err) => err?.message ?? JSON.stringify(err))
      .join('; ');
  }
  return null;
}

export function extractWorkflowNumericId(workflowId) {
  const raw = String(workflowId ?? '').trim();
  const tail = raw.split('/').pop();
  const numeric = Number.parseInt(tail, 10);
  if (!Number.isInteger(numeric)) {
    throw openAIError(
      `Invalid GitLab workflow id: ${workflowId}`,
      'upstream_error',
      502,
      'gitlab_invalid_workflow_id',
    );
  }
  return numeric;
}

function extractGidNumericId(gid) {
  if (!gid) return null;
  const tail = String(gid).split('/').pop();
  return /^\d+$/.test(tail) ? tail : String(gid);
}

function isAiCatalogItemVersionId(value) {
  return typeof value === 'string' && /^gid:\/\/gitlab\/Ai.*Catalog.*Version\//.test(value);
}

export function buildDuoWorkflowStartRequest({
  workflowId,
  goal,
  workflowDefinition = 'chat',
  approval = {},
  additionalContext = [],
  metadata = '{"extended_logging":false,"is_team_member":false,"tool_approval_for_session_enabled":true}',
  clientCapabilities = ['incremental_streaming', 'web_search'],
  orbitEnabled = false,
} = {}) {
  return {
    startRequest: {
      workflowID: String(extractWorkflowNumericId(workflowId)),
      clientVersion: '1.0',
      workflowDefinition,
      workflowMetadata: metadata,
      clientCapabilities,
      goal,
      approval,
      useOrbit: orbitEnabled,
      additional_context: additionalContext,
    },
  };
}

export function extractAssistantContentFromWorkflowEvent(rawEvent) {
  let event;
  try {
    event = typeof rawEvent === 'string' ? JSON.parse(rawEvent) : rawEvent;
  } catch {
    return null;
  }

  const checkpoint = event?.newCheckpoint;
  if (!checkpoint?.checkpoint) return null;

  let checkpointPayload;
  try {
    checkpointPayload =
      typeof checkpoint.checkpoint === 'string'
        ? JSON.parse(checkpoint.checkpoint)
        : checkpoint.checkpoint;
  } catch {
    return null;
  }

  const messages = checkpointPayload?.channel_values?.ui_chat_log ?? [];
  const assistantMessage = messages
    .filter((message) => {
      const type = String(message?.message_type ?? message?.role ?? '').toLowerCase();
      return (type === 'agent' || type === 'assistant') && typeof message?.content === 'string' && message.content.trim();
    })
    .at(-1);

  if (!assistantMessage) return null;
  return {
    content: assistantMessage.content.trim(),
    status: checkpoint.status,
  };
}

export function buildDuoWorkflowWsUrl({
  baseUrl = DEFAULT_DUO_WORKFLOWS_WS_URL,
  namespaceId,
  rootNamespaceId,
  projectId,
  workflowDefinition = 'chat',
  workflowId,
  model,
  defaultModel,
  aiCatalogItemVersionId,
} = {}) {
  const url = new URL(baseUrl);
  if (rootNamespaceId) url.searchParams.set('root_namespace_id', extractGidNumericId(rootNamespaceId));
  if (namespaceId) url.searchParams.set('namespace_id', extractGidNumericId(namespaceId));
  if (projectId) url.searchParams.set('project_id', extractGidNumericId(projectId));
  if (model && model !== 'gitlab-default' && model !== defaultModel) {
    url.searchParams.set('user_selected_model_identifier', model);
  }
  if (workflowDefinition) url.searchParams.set('workflow_definition', workflowDefinition);
  if (aiCatalogItemVersionId) url.searchParams.set('ai_catalog_item_version_id', extractGidNumericId(aiCatalogItemVersionId));
  if (workflowId) url.searchParams.set('workflow_id', String(extractWorkflowNumericId(workflowId)));
  url.searchParams.set('client_type', 'browser');
  return url;
}

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (buffer.length - cursor < length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function openSocketForUrl(url) {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
  if (url.protocol === 'https:' || url.protocol === 'wss:') {
    return tlsConnect({ host: url.hostname, port, servername: url.hostname });
  }
  return netConnect({ host: url.hostname, port });
}

async function sendWebSocketJson({
  url,
  payload,
  cookie,
  csrfToken,
  userAgent,
  timeoutMs = 10_000,
}) {
  const socket = openSocketForUrl(url);
  const key = randomBytes(16).toString('base64');
  const targetPath = `${url.pathname}${url.search}`;
  const origin = `${url.protocol === 'https:' || url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}`;
  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.write(
    [
      `GET ${targetPath} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Origin: ${origin}`,
      `User-Agent: ${userAgent}`,
      cookie ? `Cookie: ${cookie}` : null,
      csrfToken ? `X-CSRF-Token: ${csrfToken}` : null,
      'X-Requested-With: XMLHttpRequest',
      '',
      '',
    ]
      .filter((line) => line !== null)
      .join('\r\n'),
  );

  let buffer = Buffer.alloc(0);
  const header = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket handshake timeout')), timeoutMs);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const text = buffer.toString('latin1', 0, end);
      buffer = buffer.subarray(end + 4);
      resolve(text);
    }
    socket.on('data', onData);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  if (!header.startsWith('HTTP/1.1 101') || !header.includes(expectedAccept)) {
    socket.destroy();
    throw openAIError(
      `GitLab workflow WebSocket handshake failed: ${header.split('\r\n')[0]}`,
      'upstream_error',
      502,
      'gitlab_workflow_ws_handshake_failed',
    );
  }

  socket.write(encodeWebSocketTextFrame(JSON.stringify(payload)));

  const messages = [];
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 1) messages.push(frame.text);
        if (frame.opcode === 8) resolve();
      }
    });
    socket.once('close', resolve);
    socket.once('error', resolve);
    socket.once('end', resolve);
    setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, timeoutMs);
  });
  socket.end();
  return messages;
}

async function createChromeCdpClient(wsUrl, { timeoutMs = 10_000 } = {}) {
  const url = new URL(wsUrl);
  const socket = openSocketForUrl(url);
  const key = randomBytes(16).toString('base64');
  const targetPath = `${url.pathname}${url.search}`;
  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome CDP WebSocket connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.write(
    [
      `GET ${targetPath} HTTP/1.1`,
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  let buffer = Buffer.alloc(0);
  const header = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome CDP WebSocket handshake timeout')), timeoutMs);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const text = buffer.toString('latin1', 0, end);
      buffer = buffer.subarray(end + 4);
      resolve(text);
    }
    socket.on('data', onData);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  if (!header.startsWith('HTTP/1.1 101') || !header.includes(expectedAccept)) {
    socket.destroy();
    throw new Error(`Chrome CDP WebSocket handshake failed: ${header.split('\r\n')[0]}`);
  }

  let nextId = 1;
  const pending = new Map();

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeWebSocketFrames(buffer);
    buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode !== 1) continue;
      let message;
      try {
        message = JSON.parse(frame.text);
      } catch {
        continue;
      }
      if (!message?.id || !pending.has(message.id)) continue;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message);
    }
  });

  socket.once('error', (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  });

  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const payload = JSON.stringify({ id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome CDP command timeout: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.write(encodeWebSocketTextFrame(payload));
      });
    },
    close() {
      socket.end();
    },
  };
}

export async function fetchGitLabAuthFromChrome({
  cdpHost = DEFAULT_CHROME_CDP_HOST,
  cdpPort = DEFAULT_CHROME_CDP_PORT,
  cdpJsonUrl = `http://${cdpHost}:${cdpPort}/json`,
  fetchImpl = globalThis.fetch,
  cdpClientFactory = createChromeCdpClient,
  gitlabOrigin = 'https://gitlab.com/',
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const response = await fetchImpl(cdpJsonUrl);
  if (!response.ok) {
    throw missingAuthError(
      `Cannot read Chrome CDP tabs from ${cdpJsonUrl} (HTTP ${response.status}). Start the fixed Chrome 9223 browser and log in to GitLab.`,
      'gitlab_browser_auth_unavailable',
    );
  }

  const tabs = await response.json();
  const gitlabTab = (Array.isArray(tabs) ? tabs : []).find((tab) => (
    tab?.type === 'page' &&
    typeof tab?.url === 'string' &&
    tab.url.startsWith(gitlabOrigin) &&
    typeof tab?.webSocketDebuggerUrl === 'string'
  ));

  if (!gitlabTab) {
    throw missingAuthError(
      `No logged-in GitLab tab found in Chrome CDP ${cdpJsonUrl}. Open https://gitlab.com/ in the fixed Chrome 9223 browser first.`,
      'gitlab_browser_tab_not_found',
    );
  }

  const client = await cdpClientFactory(gitlabTab.webSocketDebuggerUrl, { timeoutMs });
  try {
    const pageAuth = await client.send('Runtime.evaluate', {
      expression: `(() => ({
        csrf: document.querySelector('meta[name="csrf-token"]')?.content || '',
        userAgent: navigator.userAgent || '',
        username: window.gon?.current_username || ''
      }))()`,
      returnByValue: true,
    });
    const cookiesPayload = await client.send('Network.getCookies', {
      urls: [gitlabOrigin],
    });

    const pageValue = pageAuth?.result?.result?.value ?? {};
    const cookies = cookiesPayload?.result?.cookies ?? [];
    const cookie = cookies
      .filter((item) => item?.name && typeof item?.value === 'string')
      .map((item) => `${item.name}=${item.value}`)
      .join('; ');

    return {
      cookie,
      csrfToken: pageValue.csrf || '',
      userAgent: pageValue.userAgent || '',
      username: pageValue.username || '',
    };
  } finally {
    client.close?.();
  }
}

export const GET_AGENT_FLOW = `
# @feature_category: duo_agent_platform
query getAgentFlow($workflowId: AiDuoWorkflowsWorkflowID!) {
  duoWorkflowWorkflows(workflowId: $workflowId) {
    edges {
      node {
        id
        title
        status
        humanStatus
        workflowDefinition
        latestCheckpoint {
          duoMessages {
            content
            correlationId
            role
            messageType
            messageSubType
            componentName
            subsessionId
            status
            timestamp
            toolInfo
          }
        }
        summary
        createdAt
      }
    }
  }
}`;

export function createGitLabClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  browserAuthProvider,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  const graphqlUrl = env.GITLAB_GRAPHQL_URL || DEFAULT_GRAPHQL_URL;
  const workflowWsUrl = env.GITLAB_DUO_WORKFLOWS_WS_URL || DEFAULT_DUO_WORKFLOWS_WS_URL;
  const namespaceId = env.GITLAB_NAMESPACE_ID || DEFAULT_NAMESPACE_ID;
  const fallbackUserAgent =
    env.GITLAB_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GitLab-Duo-Local-Relay/0.1';
  const effectiveBrowserAuthProvider =
    browserAuthProvider ||
    (() => fetchGitLabAuthFromChrome({
      cdpHost: env.GITLAB_CHROME_CDP_HOST || DEFAULT_CHROME_CDP_HOST,
      cdpPort: Number(env.GITLAB_CHROME_CDP_PORT || DEFAULT_CHROME_CDP_PORT),
      fetchImpl: globalThis.fetch,
    }));
  let cachedAuth = null;

  function canRefreshBrowserAuth() {
    return (
      env.GITLAB_BROWSER_AUTH !== '0' &&
      typeof effectiveBrowserAuthProvider === 'function' &&
      !(env.GITLAB_COOKIE && env.GITLAB_CSRF_TOKEN)
    );
  }

  function isRetryableAuthError(error) {
    const message = String(error?.body?.error?.message ?? error?.message ?? error ?? '').toLowerCase();
    const status = Number(error?.status ?? 0);
    const type = error?.body?.error?.type;
    return (
      status === 401 ||
      status === 403 ||
      type === 'authentication_error' ||
      message.includes('bad csrf') ||
      message.includes('csrf') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('session') ||
      message.includes('http/1.1 401') ||
      message.includes('http/1.1 403')
    );
  }

  async function resolveAuth({ forceRefresh = false } = {}) {
    if (forceRefresh) cachedAuth = null;
    if (cachedAuth) return cachedAuth;
    if (env.GITLAB_COOKIE && env.GITLAB_CSRF_TOKEN) {
      cachedAuth = {
        cookie: env.GITLAB_COOKIE,
        csrfToken: env.GITLAB_CSRF_TOKEN,
        userAgent: env.GITLAB_USER_AGENT || fallbackUserAgent,
      };
      return cachedAuth;
    }

    if (env.GITLAB_BROWSER_AUTH !== '0' && typeof effectiveBrowserAuthProvider === 'function') {
      const browserAuth = await effectiveBrowserAuthProvider();
      cachedAuth = {
        cookie: browserAuth?.cookie,
        csrfToken: browserAuth?.csrfToken,
        userAgent: browserAuth?.userAgent || fallbackUserAgent,
      };
      requiredAuth(cachedAuth);
      return cachedAuth;
    }

    cachedAuth = {
      cookie: env.GITLAB_COOKIE,
      csrfToken: env.GITLAB_CSRF_TOKEN,
      userAgent: env.GITLAB_USER_AGENT || fallbackUserAgent,
    };
    requiredAuth(cachedAuth);
    return cachedAuth;
  }

  async function sendGraphQLRequest(query, variables, auth) {
    const response = await fetchImpl(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: auth.cookie ?? '',
        'X-CSRF-Token': auth.csrfToken ?? '',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': auth.userAgent,
      },
      body: JSON.stringify({ query, variables }),
    });

    let payload;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw openAIError(
        `GitLab returned non-JSON response (${response.status}): ${text.slice(0, 300)}`,
        'upstream_error',
        response.status || 502,
        'gitlab_non_json',
      );
    }

    if (!response.ok) {
      throw openAIError(
        graphQLErrorMessage(payload) || `GitLab GraphQL HTTP ${response.status}`,
        response.status === 401 || response.status === 403 ? 'authentication_error' : 'upstream_error',
        response.status,
        'gitlab_http_error',
      );
    }

    const gqlMessage = graphQLErrorMessage(payload);
    if (gqlMessage) {
      throw openAIError(gqlMessage, 'upstream_error', 502, 'gitlab_graphql_error');
    }

    logger.debug?.('[gitlab-relay] graphql ok');
    return payload.data;
  }

  async function graphql(query, variables = {}, { requireAuth = true } = {}) {
    const auth = requireAuth
      ? await resolveAuth()
      : { cookie: '', csrfToken: '', userAgent: fallbackUserAgent };

    try {
      return await sendGraphQLRequest(query, variables, auth);
    } catch (error) {
      if (!requireAuth || !canRefreshBrowserAuth() || !isRetryableAuthError(error)) {
        throw error;
      }
      logger.warn?.('[gitlab-relay] GitLab auth rejected; refreshing from Chrome 9223 and retrying once');
      const refreshedAuth = await resolveAuth({ forceRefresh: true });
      return sendGraphQLRequest(query, variables, refreshedAuth);
    }
  }

  async function getAvailableModels() {
    if (!namespaceId) {
      throw openAIError(
        'Missing GITLAB_NAMESPACE_ID. Set it to your GitLab group namespace GID, for example gid://gitlab/Group/<id>.',
        'invalid_request_error',
        400,
        'missing_gitlab_namespace_id',
      );
    }
    const data = await graphql(GET_AI_CHAT_AVAILABLE_MODELS, {
      namespaceId,
    });
    return data?.aiChatAvailableModels;
  }

  async function createDuoWorkflow({ goal, model }) {
    if (!namespaceId) {
      throw openAIError(
        'Missing GITLAB_NAMESPACE_ID. Set it to your GitLab group namespace GID, for example gid://gitlab/Group/<id>.',
        'invalid_request_error',
        400,
        'missing_gitlab_namespace_id',
      );
    }
    const variables = {
      goal,
      workflowDefinition: 'chat',
      agentPrivileges: [2, 3, 7],
      preApprovedAgentPrivileges: [2],
      namespaceId,
    };

    if (isAiCatalogItemVersionId(model)) {
      variables.aiCatalogItemVersionId = model;
    }

    const data = await graphql(CREATE_AI_DUO_WORKFLOW, variables);
    const payload = data?.aiDuoWorkflowCreate;
    if (payload?.errors?.length) {
      throw openAIError(
        payload.errors.join('; '),
        'upstream_error',
        502,
        'gitlab_workflow_create_error',
      );
    }
    const workflowId = payload?.workflow?.id;
    if (!workflowId) {
      throw openAIError(
        'GitLab did not return workflow.id',
        'upstream_error',
        502,
        'gitlab_missing_workflow_id',
      );
    }
    return { workflowId };
  }

  async function startDuoWorkflow({ workflowId, goal, model }) {
    const url = buildDuoWorkflowWsUrl({
      baseUrl: workflowWsUrl,
      rootNamespaceId: namespaceId,
      namespaceId,
      workflowDefinition: 'chat',
      workflowId,
      model,
      defaultModel: env.GITLAB_DEFAULT_MODEL_REF,
    });
    const payload = buildDuoWorkflowStartRequest({
      workflowId,
      goal,
      workflowDefinition: 'chat',
    });
    async function sendWithAuth(auth) {
      return sendWebSocketJson({
        url,
        payload,
        cookie: auth.cookie,
        csrfToken: auth.csrfToken,
        userAgent: auth.userAgent,
        timeoutMs: Number(env.GITLAB_WORKFLOW_WS_TIMEOUT_MS || 15_000),
      });
    }

    let messages;
    try {
      messages = await sendWithAuth(await resolveAuth());
    } catch (error) {
      if (!canRefreshBrowserAuth() || !isRetryableAuthError(error)) {
        throw error;
      }
      logger.warn?.('[gitlab-relay] GitLab workflow WebSocket auth rejected; refreshing from Chrome 9223 and retrying once');
      messages = await sendWithAuth(await resolveAuth({ forceRefresh: true }));
    }
    logger.debug?.('[gitlab-relay] workflow websocket started', { workflowId, messages: messages.length });
    const parsedResult = messages.map(extractAssistantContentFromWorkflowEvent).filter(Boolean).at(-1);
    return { messages, ...parsedResult };
  }

  async function getDuoWorkflow(workflowId) {
    return graphql(GET_AGENT_FLOW, { workflowId });
  }

  async function waitForDuoWorkflowResult(workflowId) {
    const timeoutMs = Number(env.GITLAB_WORKFLOW_TIMEOUT_MS || 120_000);
    const intervalMs = Number(env.GITLAB_WORKFLOW_POLL_INTERVAL_MS || 2_500);
    const startedAt = Date.now();
    let lastStatus = 'UNKNOWN';

    while (Date.now() - startedAt < timeoutMs) {
      const data = await getDuoWorkflow(workflowId);
      const node = data?.duoWorkflowWorkflows?.edges?.[0]?.node;
      lastStatus = node?.status ?? lastStatus;
      const messages = node?.latestCheckpoint?.duoMessages ?? [];
      const assistantMessage = messages
        .filter((message) => {
          const role = String(message?.role ?? message?.messageType ?? '').toLowerCase();
          return (role === 'assistant' || role === 'agent') && message?.content;
        })
        .at(-1);
      if (assistantMessage?.content) {
        return { content: assistantMessage.content.trim(), status: lastStatus };
      }
      if (TERMINAL_WORKFLOW_STATUSES.has(lastStatus)) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw openAIError(
      `Timed out waiting for GitLab Duo workflow result (last status: ${lastStatus})`,
      'upstream_error',
      504,
      'gitlab_workflow_timeout',
    );
  }

  return {
    graphql,
    getAvailableModels,
    createDuoWorkflow,
    startDuoWorkflow,
    getDuoWorkflow,
    waitForDuoWorkflowResult,
    namespaceId,
    graphqlUrl,
    workflowWsUrl,
  };
}
