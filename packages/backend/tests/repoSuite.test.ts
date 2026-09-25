/**
 * The repository's own Playwright suite: detection, choosing the specs a
 * change affects, and reading back the run.
 *
 * Built on a throwaway fake repository so the heuristics are pinned against
 * real files on disk, the way they meet a checkout.
 */
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectRepoPlaywrightSuite, selectRelatedRepoSpecs, runRepoSpecs, parseRepoJsonReport,
  type RepoPlaywrightJsonReport,
} from '../src/playwright/repoSuite.js';

let repo: string;

function write(rel: string, content: string) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-repo-suite-'));
  write('package.json', '{"name":"fake"}');
  write('playwright.config.ts', `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
});`);
  write('src/pages/users/[id].tsx', 'export default function User() { return null; }');
  write('tests/pages/ProfilePage.ts', `
import { type Page } from '@playwright/test';
import { fillForm } from '../helpers/forms';
export class ProfilePage {
  constructor(private page: Page) {}
  async open() { await this.page.goto('/profile'); }
}`);
  write('tests/helpers/forms.ts', 'export async function fillForm() {}');
  write('tests/profile.spec.ts', `
import { test } from '@playwright/test';
import { ProfilePage } from './pages/ProfilePage';
test.describe('Profile', () => { test('edits', async ({ page }) => { await new ProfilePage(page).open(); }); });`);
  write('tests/user-detail.spec.ts', `
import { test, expect } from '@playwright/test';
test('shows a user', async ({ page }) => { await page.goto(\`/users/\${42}\`); });`);
  write('tests/billing.spec.ts', `
import { test } from '@playwright/test';
test.describe('Invoices', () => { test('lists', async ({ page }) => { await page.goto('/billing'); }); });`);
  // Must be ignored.
  write('node_modules/some-lib/thing.spec.ts', 'x');
});

after(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('repository Playwright suite', () => {
  test('detects the config, testDir and specs, and no CLI when dependencies are not installed', () => {
    const suite = detectRepoPlaywrightSuite(repo);
    assert.ok(suite);
    assert.equal(suite.configFile, path.join(repo, 'playwright.config.ts'));
    assert.equal(suite.rootDir, repo);
    assert.equal(suite.testDir, path.join(repo, 'tests'));
    assert.deepEqual(suite.specFiles, ['tests/billing.spec.ts', 'tests/profile.spec.ts', 'tests/user-detail.spec.ts']);
    assert.equal(suite.cliPath, null);
  });

  test('returns null when the repository has no Playwright config', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-repo-empty-'));
    try { assert.equal(detectRepoPlaywrightSuite(empty), null); }
    finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });

  test('selects specs by changed imports (through a page object), routes and names, never the unrelated one', () => {
    const suite = detectRepoPlaywrightSuite(repo)!;
    const selected = selectRelatedRepoSpecs(suite, {
      repoDir: repo,
      changedFiles: ['tests/helpers/forms.ts', 'src/pages/users/[id].tsx'],
      affectedRoutes: ['/users/:id'],
      affectedFeatureNames: ['User management'],
      affectedComponents: [],
    });
    const specs = selected.map((s) => s.spec);
    assert.deepEqual(specs, ['tests/profile.spec.ts', 'tests/user-detail.spec.ts']);
    assert.match(selected[0]!.reasons.join('\n'), /forms\.ts via tests\/pages\/ProfilePage\.ts/);
    assert.ok(selected[1]!.reasons.some((r) => /navigates to affected route \/users\/:id/.test(r)));
    assert.ok(selected[1]!.reasons.some((r) => /feature "User management"/.test(r)));
  });

  test('a directly imported change and a changed spec rank above route matches', () => {
    const suite = detectRepoPlaywrightSuite(repo)!;
    const selected = selectRelatedRepoSpecs(suite, {
      repoDir: repo,
      changedFiles: ['tests/pages/ProfilePage.ts', 'tests/billing.spec.ts'],
      affectedRoutes: ['/users/[id]'],
      affectedFeatureNames: [],
      affectedComponents: ['InvoiceList'],
      max: 2,
    });
    assert.deepEqual(selected.map((s) => s.spec), ['tests/billing.spec.ts', 'tests/profile.spec.ts']);
  });

  test('does not run when the repository has no Playwright installed', async () => {
    const suite = detectRepoPlaywrightSuite(repo)!;
    const out = await runRepoSpecs({
      suite, specs: ['tests/profile.spec.ts'], baseUrl: 'http://localhost:1',
      outputDir: path.join(repo, '.qa-out'), timeoutMs: 5000,
    });
    assert.equal(out.ran, false);
    assert.match(out.skippedReason ?? '', /not installed/);
    assert.deepEqual(out.results, []);
  });

  test('runs the repository CLI from the config directory with scrubbed env and reads its report', async () => {
    // A stand-in CLI that records how it was invoked in the report it writes.
    write('node_modules/playwright/cli.js', `
const fs = require('fs');
const report = {
  config: { rootDir: process.cwd() + '/tests' },
  suites: [{ title: 'profile.spec.ts', file: 'profile.spec.ts', specs: [{ title: 'edits', file: 'profile.spec.ts',
    tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed', duration: 5 }] }] }] }],
  argv: process.argv.slice(2), baseUrl: process.env.PLAYWRIGHT_BASE_URL, leaked: process.env.GITHUB_TOKEN ?? null,
};
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));`);
    const suite = detectRepoPlaywrightSuite(repo)!;
    assert.ok(suite.cliPath);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-repo-out-'));
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_secret';
    try {
      const out = await runRepoSpecs({ suite, specs: ['tests/profile.spec.ts'], baseUrl: 'http://app:8080', outputDir, timeoutMs: 20000 });
      assert.equal(out.ran, true);
      assert.deepEqual(out.results.map((r) => [r.specFile, r.title, r.outcome, r.project]), [['tests/profile.spec.ts', 'edits', 'passed', 'chromium']]);
      const raw = JSON.parse(fs.readFileSync(path.join(outputDir, 'results.json'), 'utf8'));
      assert.equal(raw.baseUrl, 'http://app:8080');
      assert.equal(raw.leaked, null);
      assert.ok(raw.argv.includes('--reporter=json,html'));
      assert.ok(raw.argv.includes('tests/profile\\.spec\\.ts'));
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous;
      fs.rmSync(path.join(repo, 'node_modules/playwright'), { recursive: true, force: true });
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe('repository JSON report parsing', () => {
  test('maps outcomes, describe paths, retries and only attachments that exist', () => {
    const video = path.join(repo, 'video.webm');
    const shot = path.join(repo, 'shot.png');
    fs.writeFileSync(video, '');
    fs.writeFileSync(shot, '');
    const report: RepoPlaywrightJsonReport = {
      config: { rootDir: path.join(repo, 'tests') },
      suites: [{
        title: 'user-detail.spec.ts', file: 'user-detail.spec.ts',
        suites: [{
          title: 'Users', file: 'user-detail.spec.ts',
          specs: [
            { title: 'loads', file: 'user-detail.spec.ts', tests: [{ status: 'flaky', results: [
              { status: 'failed', duration: 100, error: { message: '\u001b[31mboom\u001b[39m' }, attachments: [
                { name: 'video', contentType: 'video/webm', path: video },
                { name: 'screenshot', contentType: 'image/png', path: shot },
                { name: 'trace', contentType: 'application/zip', path: path.join(repo, 'missing.zip') },
              ] },
              { status: 'passed', duration: 50 },
            ] }] },
            { title: 'fails', file: 'user-detail.spec.ts', tests: [{ status: 'unexpected', results: [
              { status: 'timedOut', duration: 30000, errors: [{ message: 'Timeout' }] },
            ] }] },
            { title: 'skips', file: 'user-detail.spec.ts', tests: [{ status: 'skipped', results: [{ status: 'skipped', duration: 0 }] }] },
          ],
        }],
      }],
    };
    const results = parseRepoJsonReport(report, { repoDir: repo, rootDir: repo });
    assert.equal(results.length, 3);
    const [flaky, failed, skipped] = results;
    assert.equal(flaky!.specFile, 'tests/user-detail.spec.ts');
    assert.equal(flaky!.title, 'Users › loads');
    assert.equal(flaky!.outcome, 'flaky');
    assert.equal(flaky!.retries, 1);
    assert.equal(flaky!.durationMs, 150);
    assert.equal(flaky!.errorMessage, 'boom');
    assert.equal(flaky!.videoPath, video);
    assert.deepEqual(flaky!.screenshotPaths, [shot]);
    assert.equal(flaky!.tracePath, null);
    assert.equal(failed!.outcome, 'failed');
    assert.equal(failed!.errorMessage, 'Timeout');
    assert.equal(skipped!.outcome, 'skipped');
    assert.equal(skipped!.retries, 0);
  });
});
