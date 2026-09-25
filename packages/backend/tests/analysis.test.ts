/**
 * Static analysis tests.
 *
 * These pin the extractors' behaviour on realistic source, because everything
 * downstream - rules, scenarios, locators - is only as good as what is
 * extracted here.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { extractRoutes } from '../src/analysis/routes.js';
import { extractComponents, pickSelector } from '../src/analysis/components.js';
import { extractApis } from '../src/analysis/apis.js';
import { extractValidations } from '../src/analysis/validation.js';
import { extractAuthz } from '../src/analysis/authz.js';
import { extractState } from '../src/analysis/state.js';
import { analyzeExistingTests } from '../src/analysis/existingTests.js';
import { detectSecrets, isSecretFile, redactSecrets } from '../src/analysis/secrets.js';
import type { ScannedFile } from '../src/analysis/scanner.js';

function file(path: string, content: string): ScannedFile {
  return {
    path, absPath: `/repo/${path}`, size: content.length, hash: 'h',
    language: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js',
    content, isTest: /\.(cy|spec|test)\./.test(path) || path.startsWith('cypress/') || path.startsWith('e2e/'), isTooLarge: false,
  };
}

describe('route extraction', () => {
  test('reads Next.js App Router conventions, including dynamic segments', () => {
    const routes = extractRoutes([
      file('src/app/page.tsx', 'export default function Home() { return <div/>; }'),
      file('src/app/users/page.tsx', 'export default function Users() { return <div/>; }'),
      file('src/app/users/[id]/page.tsx', 'export default function User() { return <div/>; }'),
      file('src/app/(marketing)/pricing/page.tsx', 'export default function P() { return <div/>; }'),
      file('src/app/blog/[...slug]/page.tsx', 'export default function B() { return <div/>; }'),
    ]);
    const paths = routes.map((r) => r.path).sort();
    assert.deepEqual(paths, ['/', '/blog/:slug*', '/pricing', '/users', '/users/:id']);
    assert.equal(routes.find((r) => r.path === '/users/:id')?.params[0], 'id');
    // A route group directory must not appear in the URL.
    assert.ok(!paths.some((p) => p.includes('(marketing)')));
  });

  test('reads Pages Router conventions', () => {
    const routes = extractRoutes([
      file('pages/index.tsx', 'export default function Home() { return <div/>; }'),
      file('pages/about.tsx', 'export default function About() { return <div/>; }'),
      file('pages/posts/[id].tsx', 'export default function Post() { return <div/>; }'),
      file('pages/_app.tsx', 'export default function App() { return <div/>; }'),
    ]);
    const paths = routes.map((r) => r.path).sort();
    assert.deepEqual(paths, ['/', '/about', '/posts/:id']);
  });

  test('reads react-router definitions in both JSX and object form', () => {
    const routes = extractRoutes([
      file('src/Router.tsx', `
        import { Route, createBrowserRouter } from 'react-router-dom';
        const router = createBrowserRouter([
          { path: '/settings', element: <Settings /> },
        ]);
        export const Routes = () => <Route path="/reports" element={<Reports />} />;
      `),
    ]);
    const paths = routes.map((r) => r.path).sort();
    assert.deepEqual(paths, ['/reports', '/settings']);
  });

  test('detects an authentication guard on a route', () => {
    const routes = extractRoutes([
      file('src/app/admin/page.tsx', `
        export default function Admin() {
          const session = useSession();
          if (session.role !== 'admin') return null;
          return <div/>;
        }
      `),
    ]);
    assert.equal(routes[0]?.requiresAuth, true);
    assert.deepEqual(routes[0]?.guardedByRoles, ['admin']);
  });
});

describe('selector selection', () => {
  test('prefers data-testid and explains why', () => {
    const picked = pickSelector({ 'data-testid': 'submit', 'aria-label': 'Send', id: 'x' }, 'button', 'Send');
    assert.equal(picked.selector, '[data-testid="submit"]');
    assert.equal(picked.selectorStrategy, 'data-testid');
    assert.match(picked.selectorRationale!, /most stable/i);
  });

  test('falls back through aria-label, name, then id', () => {
    assert.equal(pickSelector({ 'aria-label': 'Send' }, 'button', '').selectorStrategy, 'aria-label');
    assert.equal(pickSelector({ name: 'email' }, 'input', '').selectorStrategy, 'name');
    assert.equal(pickSelector({ id: 'email' }, 'input', '').selectorStrategy, 'id');
  });

  test('marks a CSS-only fallback as fragile', () => {
    const picked = pickSelector({}, 'div', '');
    assert.equal(picked.selectorStrategy, 'css');
    assert.match(picked.selectorRationale!, /fragile/i);
  });
});

describe('component and form extraction', () => {
  test('finds form fields with their constraints and selectors', () => {
    const [component] = extractComponents([
      file('src/UserForm.tsx', `
        export function UserForm() {
          return (
            <form>
              <input name="email" type="email" required data-testid="email-input" />
              <input name="age" type="number" min="18" max="99" />
              <button type="submit" data-testid="submit">Save</button>
            </form>
          );
        }
      `),
    ]);
    assert.ok(component);
    const fields = component!.forms.flatMap((f) => f.fields);
    const email = fields.find((f) => f.name === 'email');
    assert.equal(email?.required, true);
    assert.ok(email?.validation.includes('format:email'));
    assert.equal(email?.selector, '[data-testid="email-input"]');
    const age = fields.find((f) => f.name === 'age');
    assert.ok(age?.validation.includes('min:18'));
    assert.ok(age?.validation.includes('max:99'));
  });

  test('records loading, error and empty conditional branches separately', () => {
    const [component] = extractComponents([
      file('src/List.tsx', `
        export function List({ isLoading, error, items }) {
          return (
            <div>
              {isLoading && <Spinner />}
              {error && <Alert />}
              {items.length === 0 && <Empty />}
            </div>
          );
        }
      `),
    ]);
    assert.equal(component!.loadingStates.length, 1);
    assert.equal(component!.errorStates.length, 1);
    assert.equal(component!.emptyStates.length, 1);
  });
});

describe('API extraction', () => {
  test('reads fetch and axios calls, and normalizes a base-url template', () => {
    const apis = extractApis([
      file('src/api.ts', `
        const BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
        export async function createUser(payload) {
          const res = await fetch(\`\${BASE}/users\`, { method: 'POST', body: JSON.stringify(payload) });
          if (res.status === 409) throw new Error('conflict');
          return res.json();
        }
        export const listUsers = () => axios.get('/api/users');
      `),
    ]);
    const keys = apis.map((a) => `${a.method} ${a.path}`).sort();
    assert.ok(keys.includes('POST /users'), `expected POST /users in ${keys.join(', ')}`);
    assert.ok(keys.includes('GET /api/users'));
    assert.ok(apis.find((a) => a.method === 'POST')?.errorCodes.includes(409));
  });

  test('reads Next.js route handler exports', () => {
    const apis = extractApis([
      file('src/app/api/tasks/route.ts', `
        export async function GET() { return Response.json([]); }
        export async function POST() { return Response.json({}, { status: 201 }); }
      `),
    ]);
    const keys = apis.map((a) => `${a.method} ${a.path}`).sort();
    assert.deepEqual(keys, ['GET /api/tasks', 'POST /api/tasks']);
  });
});

describe('validation extraction', () => {
  test('reads zod constraints and resolves constants declared elsewhere', () => {
    const rules = extractValidations([
      file('src/constants.ts', 'export const TITLE_MIN = 5;\nexport const TITLE_MAX = 80;'),
      file('src/schema.ts', `
        import { z } from 'zod';
        import { TITLE_MIN, TITLE_MAX } from './constants';
        export const TaskSchema = z.object({
          title: z.string().min(TITLE_MIN, 'Too short').max(TITLE_MAX),
          email: z.string().email('Bad email'),
          notes: z.string().optional(),
        });
      `),
    ]);
    const titleRules = rules.filter((r) => r.field === 'title').map((r) => r.rule);
    assert.ok(titleRules.includes('min:5'), `expected min:5, got ${titleRules.join(', ')}`);
    assert.ok(titleRules.includes('max:80'));
    assert.ok(titleRules.includes('required'));
    assert.ok(rules.some((r) => r.field === 'email' && r.rule === 'format:email'));
    // An optional field must not be reported as required.
    assert.ok(!rules.some((r) => r.field === 'notes' && r.rule === 'required'));
  });

  test('reads HTML5 constraints from JSX', () => {
    const rules = extractValidations([
      file('src/Form.tsx', '<input name="code" required minLength={4} maxLength={8} />'),
    ]);
    const codeRules = rules.filter((r) => r.field === 'code').map((r) => r.rule);
    assert.ok(codeRules.includes('required'));
    assert.ok(codeRules.includes('minLength:4'));
  });
});

describe('authorization extraction', () => {
  test('finds role checks and the roles they name', () => {
    const { roles, permissionChecks } = extractAuthz([
      file('src/perm.ts', `
        export const ROLES = ['admin', 'editor', 'viewer'];
        export function canDelete(user) {
          if (user.role !== 'admin') return false;
          return true;
        }
      `),
    ]);
    const names = roles.map((r) => r.name).sort();
    assert.deepEqual(names, ['admin', 'editor', 'viewer']);
    assert.ok(permissionChecks.some((c) => c.roles.includes('admin')));
  });
});

describe('state extraction', () => {
  test('reads a status union as a state machine', () => {
    const { stateMachines, statusValues } = extractState([
      file('src/types.ts', `export type TaskStatus = 'draft' | 'pending' | 'approved' | 'rejected';`),
    ]);
    assert.equal(statusValues[0]?.values.length, 4);
    assert.ok(stateMachines.some((m) => m.states.includes('approved')));
  });
});

describe('existing test awareness', () => {
  test('finds titles, custom commands and selectors already in use', () => {
    const [info] = analyzeExistingTests([
      file('cypress/e2e/login.cy.ts', `
        describe('Login', () => {
          it('signs in with valid credentials', () => {
            cy.login('a@b.c', 'secret');
            cy.get('[data-testid="dashboard"]').should('be.visible');
          });
        });
      `),
    ]);
    assert.ok(info);
    assert.ok(info!.titles.includes('signs in with valid credentials'));
    assert.ok(info!.commands.includes('login'));
    assert.ok(info!.selectorsUsed.includes('[data-testid="dashboard"]'));
  });
});

describe('secret handling', () => {
  test('excludes secret-bearing files but keeps .env.example', () => {
    assert.equal(isSecretFile('.env'), true);
    assert.equal(isSecretFile('config/private.pem'), true);
    assert.equal(isSecretFile('.env.example'), false);
    assert.equal(isSecretFile('src/app/page.tsx'), false);
  });

  test('redacts credentials from text bound for logs or a model', () => {
    const redacted = redactSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz012345 and key AIzaSyA12345678901234567890123456789012');
    assert.ok(!redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
    assert.ok(redacted.includes('[REDACTED:github_token]'));
    assert.ok(redacted.includes('[REDACTED:google_api_key]'));
  });

  test('reports a secret without echoing its value', () => {
    const findings = detectSecrets('const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz";');
    assert.ok(findings.length > 0);
    assert.ok(!findings[0]!.preview.includes('abcdefghijklmnopqrstuvwxyz'));
  });
});
