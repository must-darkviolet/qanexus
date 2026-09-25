/**
 * One QA comment per pull request: a re-review edits it in place, finds it
 * again by its marker when the stored id is stale, and only posts a new one
 * when there is none. Driven against a local stand-in for the GitHub API.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test, describe, before, after, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = 'sqlite::memory:';
const { env } = await import('../src/config/env.js');
const { upsertPullRequestComment, COMMENT_MARKER } = await import('../src/github/pullRequests.js');

interface Call { method: string; path: string; body: { body?: string } | null }
let calls: Call[] = [];
let comments: { id: number; body: string }[] = [];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = raw ? JSON.parse(raw) as { body?: string } : null;
    calls.push({ method: req.method ?? '', path: url.pathname, body });
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const edit = url.pathname.match(/\/issues\/comments\/(\d+)$/);
    if (req.method === 'PATCH' && edit) {
      const c = comments.find((x) => x.id === Number(edit[1]));
      if (!c) return json(404, { message: 'Not Found' });
      c.body = body?.body ?? '';
      return json(200, { id: c.id, html_url: `https://github.test/c/${c.id}` });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/issues/7/comments')) return json(200, comments);
    if (req.method === 'POST' && url.pathname.endsWith('/issues/7/comments')) {
      const c = { id: 100 + comments.length, body: body?.body ?? '' };
      comments.push(c);
      return json(201, { id: c.id, html_url: `https://github.test/c/${c.id}` });
    }
    json(404, {});
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  (env as { GITHUB_API_URL: string }).GITHUB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });
beforeEach(() => { calls = []; comments = [{ id: 1, body: 'LGTM from a human' }]; });

const upsert = (body: string, knownCommentId?: number) =>
  upsertPullRequestComment({ owner: 'acme', repo: 'shop', number: 7, body, token: 'test-token', knownCommentId });

describe('the QA comment on a pull request', () => {
  test('is posted once, with the marker, when the PR has none', async () => {
    const posted = await upsert('## 🤖 AI QA Report\n**Status:** ⚠️ BLOCKED');
    assert.equal(posted.created, true);
    assert.equal(comments.length, 2);
    assert.ok(comments[1]!.body.startsWith(COMMENT_MARKER));
  });

  test('is edited in place on the next review, never duplicated', async () => {
    const first = await upsert('## 🤖 AI QA Report\n**Status:** ⚠️ BLOCKED');
    calls = [];
    const second = await upsert('## 🤖 AI QA Report\n**Status:** ✅ PASSED', first.id);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.deepEqual(calls.map((c) => c.method), ['PATCH']);
    assert.equal(comments.filter((c) => c.body.includes(COMMENT_MARKER)).length, 1);
    assert.match(comments.find((c) => c.id === first.id)!.body, /✅ PASSED/);
  });

  test('is found again by its marker when the stored id no longer exists', async () => {
    comments.push({ id: 55, body: `${COMMENT_MARKER}\nold report` });
    const posted = await upsert('## 🤖 AI QA Report\n**Status:** ❌ FAILED', 999);
    assert.equal(posted.created, false);
    assert.equal(posted.id, 55);
    assert.deepEqual(calls.map((c) => c.method), ['PATCH', 'GET', 'PATCH']);
    assert.equal(comments.length, 2, 'no new comment');
  });
});
