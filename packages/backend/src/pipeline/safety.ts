/**
 * Where a review is allowed to point a browser.
 *
 * A review signs in, fills forms and submits them. Against production that
 * writes real data, so a review only runs against a host that is plainly not
 * production: this machine, a host named like a non-production environment
 * (dev-, staging., qa-, preview-...), the pull-request preview host, or one
 * listed in QA_ALLOWED_TEST_HOSTS. Anything else is refused and the review is
 * reported as blocked, with the reason, instead of being run.
 */

const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$|\.(localhost|local|test|internal)$/i;

/** A host label that names a non-production environment: "dev-admin", "staging", "qa2", "pr-12"... */
const NON_PRODUCTION_LABEL = /^(dev|develop|development|stg|stage|staging|test|testing|qa|uat|preview|sandbox|demo|pr)(\d+|-.*)?$/i;

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** "*.staging.example.com" matches any subdomain; a bare name matches exactly. */
function matchesPattern(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
}

export function unsafeTargetReason(baseUrl: string, opts: {
  allowedHosts: string;
  previewTemplate?: string;
}): string | null {
  const host = hostOf(baseUrl);
  if (!host) return `The application URL "${baseUrl}" is not a valid URL.`;
  if (LOCAL_HOST.test(host)) return null;
  if (host.split('.').some((label) => NON_PRODUCTION_LABEL.test(label))) return null;

  const previewHost = opts.previewTemplate ? hostOf(opts.previewTemplate.replace(/\{number\}/g, '0')) : null;
  if (previewHost) {
    const shape = new RegExp(`^${previewHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/0/g, '\\d+')}$`);
    if (shape.test(host)) return null;
  }
  if (opts.allowedHosts.split(',').some((p) => matchesPattern(host, p))) return null;

  return `Refusing to test ${host}: it does not look like a local, development, staging or preview environment, `
    + 'and a review signs in and submits forms, which would write real data. '
    + `If ${host} is safe to test, add it to QA_ALLOWED_TEST_HOSTS.`;
}
