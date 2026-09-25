/**
 * Secret detection and redaction (spec section 27).
 *
 * Two jobs:
 *  1. Decide which repository files must never be read into AI context.
 *  2. Scrub anything that looks like a credential out of strings we log,
 *     persist, or send to a model.
 */

const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /(^|\/)credentials(\.json|\.yml|\.yaml)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|ts|js)$/i,
  /(^|\/)service-account.*\.json$/i,
];

/** `.env.example` is safe and useful: it documents variable names. */
const SECRET_FILE_ALLOWLIST: RegExp[] = [
  /(^|\/)\.env\.(example|sample|template)$/i,
];

export function isSecretFile(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  if (SECRET_FILE_ALLOWLIST.some((r) => r.test(p))) return false;
  return SECRET_FILE_PATTERNS.some((r) => r.test(p));
}

interface SecretPattern { name: string; re: RegExp }

const SECRET_VALUE_PATTERNS: SecretPattern[] = [
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'github_fine_grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: 'openai_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  { name: 'basic_auth_url', re: /\b([a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:[^\s/@]+@/gi },
  // key = "value" style assignments for obviously sensitive names
  { name: 'assigned_secret', re: /\b(?:api[_-]?key|apikey|secret|password|passwd|token|client[_-]?secret|private[_-]?key|access[_-]?token)\b\s*[:=]\s*["'`]([^"'`\n]{6,})["'`]/gi },
];

/** Replaces anything that looks like a credential with a marker. */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    if (name === 'assigned_secret') {
      out = out.replace(re, (match, value: string) => match.replace(value, `[REDACTED:${name}]`));
    } else if (name === 'basic_auth_url') {
      out = out.replace(re, (_m, scheme: string) => `${scheme}://[REDACTED:credentials]@`);
    } else {
      out = out.replace(re, `[REDACTED:${name}]`);
    }
  }
  return out;
}

export interface SecretFinding { pattern: string; line: number; preview: string }

/** Reports (without echoing) secrets found in a file's contents. */
export function detectSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      re.lastIndex = 0;
      if (re.test(line)) {
        findings.push({ pattern: name, line: i + 1, preview: redactSecrets(line).slice(0, 160) });
      }
    }
  }
  return findings;
}

/**
 * Last line of defence before any text reaches an AI provider.
 * Spec: "Do not send secrets to Gemini."
 */
export function sanitizeForAi(text: string): string {
  return redactSecrets(text);
}
