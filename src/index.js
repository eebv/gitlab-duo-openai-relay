import { createGitLabClient } from './gitlab-client.js';
import { createServer } from './server.js';

const port = Number(process.env.PORT || process.env.GITLAB_RELAY_PORT || 8048);
const host = process.env.HOST || '127.0.0.1';

const gitlabClient = createGitLabClient();
const server = createServer({ gitlabClient });

server.listen(port, host, () => {
  console.log(`[gitlab-relay] listening on http://${host}:${port}`);
  console.log(`[gitlab-relay] GraphQL: ${gitlabClient.graphqlUrl}`);
  console.log(`[gitlab-relay] Namespace: ${gitlabClient.namespaceId}`);
});
