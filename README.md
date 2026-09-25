# QA PR Review Agent

A QA engineer for pull requests. When a PR is opened or pushed to, it reads the
description and the diff, works out what the change affects, writes or updates
the Playwright tests for those areas, runs them with the browser recorded,
walks through the affected pages on camera, and posts the result as one comment
on the pull request.

```
pull request opened / updated
  -> read the PR title and description
  -> read the diff against the merge base (what GitHub shows under "Files changed")
  -> analyse it: which modules, routes, business rules and tests it reaches
  -> write the missing tests, update the ones the change invalidated
  -> run the affected Playwright tests, recording every one
  -> walk through the affected modules in a recorded browser
  -> comment on the pull request, and keep that comment up to date
```

Every conclusion comes with the evidence behind it. A failure is reported as a
hypothesis with its recording, screenshot, trace, console and network logs —
never as a confirmed defect.

---

## What the comment says

An **🤖 AI QA Report**, posted only once the review has finished:

- **Status** — ✅ PASS, ❌ FAIL or ⚠️ BLOCKED (the environment, sign-in or the
  review itself failed, so the code was not verified), with the reason.
- **Change Analysis** — stated intent, files added / modified / deleted, the
  kinds of code touched (UI, routes, APIs, auth, validation, business logic),
  and what changed since the previous review of the same PR.
- **Affected Modules** with risk, the changed files, and why each was implicated.
- **Tests Executed** — generated specs (new 🆕 / updated ✏️ / rejected ⛔ for
  breaking quality rules) and the repository's own related Playwright tests.
- **Results** — passed, failed, skipped, flaky and total. Every failure is
  retried once before it is reported.
- **Authentication** — whether tests really signed in (and as which roles),
  failed to, or ran with a simulated session.
- **Findings** — per failure: severity, module, scenario, expected, actual,
  URL, evidence, likely cause and recommended action, with console errors and
  failed requests. Each is classified as a possible product defect, a test
  environment problem, a test that needs updating, or pre-existing.
- **Regression Assessment** — per affected module, and which earlier failures
  are now fixed.
- **Evidence**, **Browser Recording** and **Test Report** — the recorded
  walkthrough, every video (only files that exist), and the Playwright HTML report.
- **Conclusion**.

Secrets are masked in everything the comment contains, and a review refuses to
run against a host that looks like production (see `QA_ALLOWED_TEST_HOSTS`).
Cancelling a review from the dashboard posts nothing.

### Authentication, test selection and blocked reviews

- **Authentication is a prerequisite.** Before the walkthrough or any test, the
  review opens the affected routes signed out. If they send it to a login, it
  signs in with the test account (or reuses a saved session), then verifies the
  protected route opens. The walkthrough and every test reuse that one session.
  If signing in is impossible, the result is `AUTHENTICATION_REQUIRED`,
  `AUTHENTICATION_FAILED` or `AUTHENTICATED_ACCESS_FAILED`. Protected tests are
  not run, and the review is **BLOCKED**, not reported as a pass.
- **Behind a CAPTCHA**, run `npm run qa -- auth <project>`, sign in once in the
  browser window that opens, and later reviews reuse the saved session
  (`workspaces/<project>/auth/`, never served) until it expires.
- **Impact-aware selection.** Tier 1 is the specs of modules whose own files
  changed. Tier 2 is modules reached indirectly. Tier 3 (every spec) runs only
  for a cross-cutting change or with `--full-regression`. For a pull request,
  tests are generated only for the modules it touches.
- **Status.** PASSED means the required tests ran and passed. FAILED means some
  of them failed. BLOCKED means nothing could run (authentication, the app not
  answering, a startup hang, or 0 tests discovered). PARTIAL means some ran and
  the rest could not. Zero executed tests is never PASSED.
- **Timeouts say what timed out**: application readiness, route navigation,
  authentication, Playwright startup, or Playwright execution (with how many
  tests finished and which one was running). Results of a run cut short are
  kept.

One comment per pull request, edited in place on every push.

---

## Quick start

```bash
# 1. Install, including the browser Playwright drives
npm install
npm run playwright:install

# 2. Configure
cp .env.example .env
#    Works with no editing: embedded SQLite and deterministic analysis.
#    For AI, add GEMINI_API_KEY, or set AI_PROVIDER=claude-cli to use your
#    logged-in Claude Code CLI (no API key).

# 3. Create the database schema
npm run migrate

# 4. Start it: the API and the dashboard
npm run dev
#    dashboard  http://localhost:3100
#    API        http://localhost:4000

# 5. Or try a review from the terminal, against the bundled sample application
#    (serve it first: cd sample-app && npm install && npm run dev)
npm run qa -- add ./sample-app --name sample --branch master --base-url http://localhost:3000
npm run qa -- pr sample --base 93fb22e --head ae658c2 \
  --title "Rename users to members" --comment-file review.md
#    review.md is the comment it would have posted.
```

---

## The dashboard

`npm run dev` serves it on http://localhost:3100. It shows the repositories it
reviews, and for each one every review it has done: live progress while a review
runs, the modules the change affected, the tests written or updated, each test
with its outcome and recording, the diagnosis of every failure, the videos
playable inline, and the exact comment that was posted.

You can also start a review there: open a repository and give it a PR number.

## Three ways to trigger a review

**1. GitHub webhook** — the service reviews pull requests as they arrive.

```bash
GITHUB_WEBHOOK_SECRET=…                        # required; unsigned deliveries are rejected
PR_APP_START_COMMAND="npm ci && npm run dev"   # serve the PR's own build
QA_PUBLIC_URL=https://qa.example.com           # so the comment can link recordings
npm run dev                                    # API on :4000
```

Add a webhook in the repository's settings: payload URL
`https://your-qa-host/api/github/webhook`, content type `application/json`,
your secret, and the **Pull requests** event. The repository must already be
registered (`npm run qa -- add …`). `PR_REVIEW_ACTIONS` controls which actions
start a review (default `opened,synchronize,reopened,ready_for_review`); drafts
are skipped until marked ready, and pull requests from forks are skipped unless
`PR_REVIEW_FORKS=1`.

**2. GitHub Actions** — no server to host. Copy
[`examples/github-actions/qa-pr-review.yml`](examples/github-actions/qa-pr-review.yml)
into the repository you want reviewed. It needs `permissions: pull-requests:
write`, and uploads the recordings as a workflow artifact the comment links to.

**3. By hand** — from a terminal or the API:

```bash
npm run qa -- pr my-app --number 42 \
  --start "npm run dev" \             # serve the PR's checkout during the review
  --base-url http://localhost:3000 \
  --fail-on-failures                  # exit non-zero when a test fails

curl -X POST localhost:4000/api/projects/<id>/pull-requests/42/review
```

---

## How a review works

| Step | What happens |
|---|---|
| Checkout | Fetches the PR head (including from forks, via `refs/pull/N/head`) and checks it out **before** the application is served, so the build under test is the pull request's. |
| Diff | `git diff` against the **merge base**, the same range GitHub shows. |
| Analysis | Routes, components, APIs, types, roles, validation and authorization rules are extracted with the TypeScript compiler. The PR description is passed to the model as the author's claim, to check against the diff — never as an instruction. |
| Impact | Each changed file is traced through the components that render it to the routes, rules and tests it reaches; every link records why it was drawn. |
| Tests | Scenarios are generated for the affected areas and rendered as Playwright tests (Page Object Model, every locator justified). Generated code is parsed and linted before it is written: hard waits, `force: true`, un-awaited actions, `test.only` and selectors absent from the evidence are rejected. |
| Execution | Only the specs the change can affect, unless a full regression is warranted. Video for every test, screenshot and trace on failure. |
| Walkthrough | Each affected route is visited in a recorded browser and compared with what the code claimed. |
| Diagnosis | Each failure is classified (`APPLICATION_BUG`, `LOCATOR_CHANGED`, `ENVIRONMENT_FAILURE`, …) with its confidence, evidence and a recommended action. |
| Comment | Posted, or edited if this system already commented on the PR. |

Tests live in their own suite under `workspaces/<project>/qa-suite`, so the
repository being reviewed is never modified.

---

## The application under test

Tests run against a *running* application, so the review has to reach the pull
request's build:

- `PR_APP_START_COMMAND`, or `--start`, serves the PR's checkout for the
  review and stops it afterwards. The checkout is a fresh clone, so the command
  usually installs first (`npm ci && npm run dev`). If something is already
  listening on that URL the review stops rather than test the wrong build.
- `PR_PREVIEW_URL_TEMPLATE=https://pr-{number}.preview.example.com` uses your
  existing preview deployments instead.
- Otherwise the base URL is used as-is, and the comment says the application was
  already running and may not be this pull request's build.

With `TEST_MOCK_API=1` (the default) only the frontend needs serving: the API is
stubbed with fixtures derived from the application's own TypeScript types.

---

## The AI layer

Every stage that needs judgement uses the model, behind one provider interface
(`src/ai/provider.ts`), and every one has a deterministic fallback — no stage
is a hard dependency on the model being available.

| Agent | Its part of the review |
|---|---|
| `RepositoryAnalyzer` | what the application is, and its modules |
| `BusinessRuleAnalyzer` | the rules the change touches, from evidence in the code |
| `ApplicationMapper` | user flows, roles and state transitions |
| `ChangeAnalyzer` | what this diff affects, checked against the PR's description |
| `RegressionAdvisor` | what to re-test, beyond the deterministic trace |
| `ScenarioGenerator` | the scenarios the change needs covered |
| `TestGenerator` | the Playwright tests that implement them |
| `RegressionSelector` | which specs this change justifies running |
| `FailureAnalyzer` | why a test failed, from the evidence |

| `AI_PROVIDER` | Uses | Needs |
|---|---|---|
| `gemini` (default) | the Gemini API | `GEMINI_API_KEY` |
| `claude-cli` | the locally installed **Claude Code CLI** with its existing login | Claude Code installed and logged in — **no Anthropic API key** |

```bash
npm run qa -- ai-check --live      # one tiny request, to prove the provider works
```

Without a provider the service still reviews pull requests: rules, routes and
validation constraints are read from the code, tests are synthesized from the
application model, and failures are classified heuristically. `AI_DISABLED=1`
forces that mode.

Raw model output is never trusted: it is parsed, repaired, validated against a
zod schema, retried once with the errors shown to the model, and finally
replaced by the deterministic result. Prompts are cached by content hash, and
everything sent to a provider is scrubbed of credential-shaped strings first.

---

## Configuration

See `.env.example` for the full list. The essentials:

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | required to accept webhook deliveries |
| `GITHUB_TOKEN` | commenting needs **Pull requests: write**; everything else is read-only |
| `PR_APP_START_COMMAND` | serves the checked-out PR for the review |
| `PR_PREVIEW_URL_TEMPLATE` | use preview deployments instead |
| `PR_REVIEW_ACTIONS` | which `pull_request` actions start a review |
| `PR_REVIEW_FORKS` | review fork pull requests (off by default — it runs their code) |
| `PR_APP_ENV_ALLOW` | environment variables the app genuinely needs to boot |
| `QA_PUBLIC_URL` | public URL of this API, so comments can link recordings |
| `PLAYWRIGHT_VIDEO` | `on` by default: every test is recorded |
| `TEST_MOCK_API` | stub the app's API with type-derived fixtures (default on) |
| `AI_PROVIDER` / `GEMINI_API_KEY` | the AI layer; without it, deterministic analysis |
| `DATABASE_URL` | `sqlite:./data/qa-agent.db`, or `postgres://…` |

---

## What a review is trusted to do

A review builds and serves the pull request's code and runs generated tests
against it:

- **Fork pull requests execute their author's code** — `npm ci` runs the fork's
  install scripts. The webhook ignores them unless `PR_REVIEW_FORKS=1`.
- **Child processes do not inherit credentials.** The application under test and
  the generated suite start without anything credential-shaped in the
  environment (`…_SECRET`, `…_TOKEN`, `…_KEY`, `AWS_*`, `NPM_TOKEN`, the
  database URL, this system's own keys). Name exceptions in `PR_APP_ENV_ALLOW`.
- **Recordings are only as private as the API serving them.** This API has no
  authentication; setting `QA_PUBLIC_URL` publishes artifact links in a comment
  that, on a public repository, anyone can read. Put it behind authentication
  first. A trace of a failed login against a real backend records the test
  credentials, so use throwaway accounts or `PLAYWRIGHT_TRACE=off`.
- A pull request's title and description are treated as data: passed to the
  model as a claim to verify, and escaped before they reach the comment, so
  neither can forge a verdict.

---

## Commands

| Command | What it does |
|---|---|
| `npm run qa -- add <repo> [--branch B] [--base-url URL]` | register a repository |
| `npm run qa -- projects` | list registered repositories |
| `npm run qa -- pr <project> --number N` | review a pull request |
| `npm run qa -- pr <project> --base REF --head REF` | review two refs offline |
| `npm run qa -- ai-check [--live]` | check the AI provider |
| `npm run dev` | the dashboard (:3100) and the API (:4000) |
| `npm run dev:api` / `npm run dev:web` | one of them on its own |
| `npm run migrate` | apply database migrations |
| `npm test` / `npm run typecheck` / `npm run build` | the usual |

## API

```
GET    /api/health
POST   /api/github/webhook                        pull_request events (signature required)
GET    /api/projects/:id/pull-requests            reviews recorded for a repository
POST   /api/projects/:id/pull-requests/:n/review  review a pull request now
GET    /api/artifacts?path=…                      a recording, screenshot or trace
GET    /api/system/status                         what the service can currently do
GET    /api/projects                              repositories it reviews
POST   /api/projects                              connect one
GET    /api/projects/:id/pull-requests/:reviewId  one review: steps, results, recordings
```

## Architecture

```
packages/
  frontend/    the dashboard (Next.js; no UI library, one page per repository)
  shared/      types and schemas
  backend/
    analysis/  deterministic extraction (TypeScript compiler API, git, import graph)
    agents/    the AI agents, each with its own prompt, schema and fallback
    ai/        provider interface, budgets, caching, failover
    knowledge/ features, rules, scenarios, impact, coverage, evidence
    memory/    what past runs learned: failure history, flaky tests, hotspots
    playwright/ suite scaffolding, code generation, execution, recordings
    explore/   the recorded walkthrough of affected routes
    github/    authentication, checkout, diffing, pull requests, webhooks
    pipeline/  the review itself: orchestrator, prReview, prComment, appServer
    api/       the webhook and review endpoints
    scripts/   the CLI
sample-app/    a small Next.js application to try it against
examples/      a GitHub Actions workflow to copy into your repository
```

## Requirements

- Node.js 20.11 or newer (22+ recommended; embedded SQLite needs 22.5+)
- git
- Playwright's browsers (`npm run playwright:install`)
- Optionally: PostgreSQL, a Gemini key or the Claude Code CLI

## Current limits

- A review adds to what the service knows about a repository and rewrites the
  generated suite from the PR's code, so between a review and the next one both
  reflect that pull request. Reviews of one repository are serialised for that
  reason. A review never *removes* anything — it does not move the baseline
  commit, prune modules, retire specs or mark scenarios obsolete, because a
  pull request may never merge. Full isolation would need a workspace per pull
  request, which this does not yet do.
- Business-rule inference is only as good as the evidence in the repository. A
  codebase with no validation schemas and no role checks yields few confirmed
  rules, and the review says so rather than inventing them.
- With `TEST_MOCK_API=1` the API is stubbed, so the suite verifies frontend
  behaviour, not the backend. Use `TEST_MOCK_API=0` against a seeded backend for
  end-to-end coverage; data-dependent tests then skip themselves and say why.
- Impact tracing follows JSX usage and static imports. Dynamic imports built
  from variables, dependency injection and server-side coupling are invisible to
  it; the AI advisor is asked about indirect effects, and its suggestions are
  labelled as AI output rather than verified links.
- The walkthrough visits static routes only; parameterised routes need data the
  service does not have.
