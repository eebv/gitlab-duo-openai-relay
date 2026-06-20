export function openAIError(message, type = 'api_error', status = 500, code = null) {
  return {
    status,
    body: {
      error: {
        message,
        type,
        param: null,
        code,
      },
    },
  };
}

export function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

export function buildChatGoal(messages = []) {
  const roleLabels = {
    system: 'System',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
  };

  return messages
    .map((message) => {
      const role = roleLabels[message?.role] ?? 'User';
      const content = normalizeContent(message?.content).trim();
      if (!content) return null;
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function mapGitLabModelsToOpenAI(aiChatAvailableModels = {}) {
  const seen = new Set();
  const models = [];

  for (const model of [
    aiChatAvailableModels.defaultModel,
    ...(aiChatAvailableModels.selectableModels ?? []),
  ]) {
    if (!model?.ref || seen.has(model.ref)) continue;
    seen.add(model.ref);
    models.push({
      id: model.ref,
      object: 'model',
      created: 0,
      owned_by: model.modelProvider ?? 'gitlab',
      name: model.name ?? model.ref,
      description: model.modelDescription ?? null,
      cost_indicator: model.costIndicator ?? null,
    });
  }

  return {
    object: 'list',
    data: models,
  };
}

export function extractAssistantContentFromWorkflow(data) {
  const node = data?.duoWorkflowWorkflows?.edges?.[0]?.node;
  const messages = node?.latestCheckpoint?.duoMessages ?? [];
  const assistantMessages = messages.filter((message) => {
    const role = String(message?.role ?? '').toLowerCase();
    return role === 'assistant' && typeof message?.content === 'string' && message.content.trim();
  });
  return assistantMessages.at(-1)?.content?.trim() ?? '';
}

export function createOpenAIChatCompletion({
  model,
  workflowId,
  content = '',
  status = 'workflow_created',
  created = Math.floor(Date.now() / 1000),
}) {
  const shortWorkflowId = String(workflowId ?? '').split('/').pop() || String(workflowId ?? '');
  const assistantContent =
    content ||
    `GitLab Duo workflow created: ${workflowId}.\n\n` +
      '当前 PoC 已完成 workflow 创建；assistant 最终回复读取接口仍需继续抓包确认。';

  return {
    id: `chatcmpl-gitlab-${shortWorkflowId || created}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: assistantContent,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    gitlab: {
      workflow_id: workflowId,
      status,
    },
  };
}
