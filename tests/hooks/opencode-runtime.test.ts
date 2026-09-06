import { afterEach, expect, test } from '@jest/globals';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const pluginSourcePath = path.join(
  repoRoot,
  'dist',
  'hooks',
  'opencode',
  'memory-anchor-plugin.js',
);
const opencodeCommand = process.env.MEMORY_ANCHOR_OPENCODE_BIN || 'opencode';
const runOpenCodeE2E = process.env.MEMORY_ANCHOR_OPENCODE_E2E !== '0';
const originalPath = process.env.PATH || '';

type JsonRecord = Record<string, unknown>;

interface FakeBackendRequest {
  body: JsonRecord | null;
  method: string | undefined;
  url: string | undefined;
}

interface FakeBackend {
  requests: FakeBackendRequest[];
  server: ReturnType<typeof createServer>;
  url: string;
}

interface OpenCodeSession extends JsonRecord {
  id: string;
}

interface ChatCompletionRequest extends JsonRecord {
  messages: unknown[];
}

let tempDir = '';
let fakeBackend: FakeBackend | undefined;
let opencodeProcess: ChildProcess | undefined;

function hasOpenCode(): boolean {
  if (!runOpenCodeE2E) return false;

  try {
    execFileSync(opencodeCommand, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>(resolve => child.once('exit', () => resolve()));
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const exited = Promise.race([
    waitForChildExit(child),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, 2_000);
    }),
  ]);
  await exited;
  clearTimeout(timer);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForChildExit(child);
  }
}

async function waitFor<T>(
  predicate: () => Promise<T | false | null | undefined>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startFakeBackend(): Promise<FakeBackend> {
  const requests: FakeBackendRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const parsedBody = bodyText ? JSON.parse(bodyText) as unknown : null;
      const body = isJsonRecord(parsedBody) ? parsedBody : null;
      requests.push({ body, method: request.method, url: request.url });

      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'fake-model', object: 'model', owned_by: 'memory-anchor-test' }],
          }),
        );
        return;
      }

      if (!body?.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chatcmpl-memory-anchor-test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1_000),
            model: 'fake-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'OK' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }

      response.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      const chunk = (choices: unknown[]) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-memory-anchor-test',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1_000),
          model: 'fake-model',
          choices,
        })}\n\n`;
      response.write(
        chunk([
          {
            index: 0,
            delta: { role: 'assistant', content: 'OK' },
            finish_reason: null,
          },
        ]),
      );
      response.write(
        chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
          'data: [DONE]\n\n',
      );
      response.end();
    });
  });

  return new Promise<FakeBackend>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fake backend did not receive a TCP address'));
        return;
      }
      resolve({
        requests,
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function getFreePort(): Promise<number> {
  const server = createNetServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | string | null;
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a local TCP port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function requestJson<T extends JsonRecord>(
  baseUrl: string,
  route: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${route} failed (${response.status}): ${text}`);
  }
  return body as T;
}

function startOpenCodeServer(cwd: string, env: NodeJS.ProcessEnv, port: number) {
  const child = spawn(
    opencodeCommand,
    ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });

  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `OpenCode did not start. stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }, 20_000);

    const onOutput = () => {
      if (!output.stdout.includes('opencode server listening')) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${port}`);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') return;
      clearTimeout(timer);
      reject(
        new Error(
          `OpenCode exited before startup (code=${code}, signal=${signal}). stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    });
  });

  return { child, output, ready };
}

function isChatCompletionRequest(
  request: FakeBackendRequest
): request is FakeBackendRequest & { body: ChatCompletionRequest } {
  return request.url?.endsWith('/chat/completions') === true &&
    request.body !== null &&
    Array.isArray(request.body.messages);
}

afterEach(async () => {
  await stopChild(opencodeProcess);
  opencodeProcess = undefined;

  if (fakeBackend) {
    const backend = fakeBackend;
    await new Promise<void>((resolve, reject) => {
      backend.server.close(error => error ? reject(error) : resolve());
    });
    fakeBackend = undefined;
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

const runtimeTest = hasOpenCode() ? test : test.skip;

runtimeTest(
  'starts real OpenCode, injects the plugin context, and invokes the idle hook through a local fake backend',
  async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-opencode-runtime-'));
    const backend = await startFakeBackend();
    fakeBackend = backend;

    const pluginDir = path.join(tempDir, '.opencode', 'plugins');
    const binDir = path.join(tempDir, 'fake-bin');
    const anchorDir = path.join(tempDir, '.memoryanchor');
    const chartDir = path.join(anchorDir, 'chart');
    const eventsPath = path.join(tempDir, 'hook-events.log');
    await Promise.all([mkdir(pluginDir, { recursive: true }), mkdir(binDir), mkdir(chartDir, { recursive: true })]);

    await copyFile(pluginSourcePath, path.join(pluginDir, 'memory-anchor.js'));
    await writeFile(path.join(tempDir, 'AGENTS.md'), '# OpenCode runtime test\n');
    await writeFile(path.join(anchorDir, 'index.md'), '# test index\n');
    await writeFile(path.join(chartDir, 'chart.md'), '# test root chart\n');
    await writeFile(path.join(anchorDir, 'guardrails.md'), '# test guardrails\n');
    await writeFile(path.join(anchorDir, 'project-state.md'), '# test project state\n');
    await writeFile(path.join(anchorDir, 'decisions.md'), '# test decisions\n');
    await writeFile(
      path.join(anchorDir, 'prompt-hooks.json'),
      JSON.stringify({ enabled: ['opencode'] }) + '\n',
    );
    await writeFile(
      path.join(tempDir, 'opencode.json'),
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: 'fake/fake-model',
          provider: {
            fake: {
              name: 'Memory Anchor local fake provider',
              npm: '@ai-sdk/openai-compatible',
              options: { apiKey: 'memory-anchor-test', baseURL: `${backend.url}/v1` },
              models: {
                'fake-model': {
                  name: 'Memory Anchor fake model',
                  limit: { context: 32_000, output: 1_024 },
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    for (const [name, event] of [['memoryanchor-opencode-post', 'post']]) {
      const scriptPath = path.join(binDir, name);
      await writeFile(
        scriptPath,
        `#!/bin/sh\nprintf '%s\\n' '${event}' >> "$MEMORY_ANCHOR_E2E_EVENTS"\n`,
      );
      await chmod(scriptPath, 0o755);
    }

    const xdgRoot = path.join(tempDir, 'xdg');
    const env = {
      ...process.env,
      MEMORY_ANCHOR_E2E_EVENTS: eventsPath,
      OPENCODE_LOG_LEVEL: 'ERROR',
      PATH: `${binDir}${path.delimiter}${originalPath}`,
      XDG_CACHE_HOME: path.join(xdgRoot, 'cache'),
      XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
      XDG_DATA_HOME: path.join(xdgRoot, 'data'),
      XDG_STATE_HOME: path.join(xdgRoot, 'state'),
    };

    const opencodePort = await getFreePort();
    const server = startOpenCodeServer(tempDir, env, opencodePort);
    opencodeProcess = server.child;
    const baseUrl = await server.ready;

    const session = await requestJson<OpenCodeSession>(baseUrl, '/session', {
      headers: { 'x-opencode-directory': tempDir },
      method: 'POST',
      body: JSON.stringify({ title: 'Memory Anchor runtime test' }),
    });
    await requestJson(baseUrl, `/session/${session.id}/message`, {
      headers: { 'x-opencode-directory': tempDir },
      method: 'POST',
      body: JSON.stringify({
        agent: 'build',
        parts: [{ type: 'text', text: 'Reply with OK and do not use tools.' }],
      }),
    });

    try {
      await waitFor(async () => {
        const events = await readFile(eventsPath, 'utf8').catch(() => '');
        return events.includes('post\n');
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; events=${await readFile(eventsPath, 'utf8').catch(() => '')}; ` +
          `backend=${JSON.stringify(backend.requests)}; ` +
          `opencode stdout=${server.output.stdout}; stderr=${server.output.stderr}`,
      );
    }

    const chatRequest = backend.requests.find(isChatCompletionRequest);
    if (!chatRequest) throw new Error('Expected a chat-completions request');
    expect(JSON.stringify(chatRequest.body.messages)).toContain(
      '[MEMORY ANCHOR: CONTEXT INJECTED]',
    );
    expect(JSON.stringify(chatRequest.body.messages)).toContain(
      '[IMPORTANT!] Must read ./.memoryanchor/chart/.../chart.md before any works and glob/grep.',
    );

    const events = await readFile(eventsPath, 'utf8');
    expect(events).toContain('post\n');
    expect(backend.requests.some(({ url }) => url?.endsWith('/chat/completions'))).toBe(true);
  },
  60_000,
);
