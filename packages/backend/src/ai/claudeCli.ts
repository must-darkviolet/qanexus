/**
 * ClaudeCliProvider: Claude through the locally installed Claude Code CLI.
 *
 * No Anthropic API key is involved. The CLI is already logged in (for example
 * with a claude.ai subscription) and owns its own authentication; this
 * provider never reads, copies or logs those credentials. It runs
 *
 *   claude -p --output-format json --system-prompt <agent prompt> ...
 *
 * with the user prompt on stdin, and reads the single JSON result envelope.
 *
 * Token discipline:
 *   - --system-prompt replaces Claude Code's own (much larger) system prompt
 *   - --tools "" and --strict-mcp-config: no tool or MCP definitions are sent,
 *     and the model cannot go off and read the repository by itself
 *   - --disable-slash-commands: no skill listing is attached
 *   - --no-session-persistence and a neutral working directory: no session
 *     history, no CLAUDE.md auto-discovery, every call is self-contained
 *   - the context itself is selected and budgeted by the caller
 */
import os from 'node:os';
import { AiProviderError, estimateTokens, type AiProvider, type AiRequest, type AiResponse, type AiUsage } from './provider.js';
import { sanitizeForAi } from '../analysis/secrets.js';
import { createLogger } from '../util/logger.js';
import { ProcessStartError, runProcess, type ProcessResult } from '../util/process.js';

const log = createLogger('ai:claude-cli');

export interface ClaudeCliOptions {
  command: string;
  /** Undefined = the model the CLI is configured to use. */
  model?: string;
  timeoutMs: number;
  effort?: string;
  /** Working directory for the CLI; a neutral one keeps project files out of its context. */
  cwd?: string;
}

/** The fields of the CLI's `--output-format json` envelope this provider reads. */
interface CliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

/**
 * Environment variables never passed to the CLI. ANTHROPIC_API_KEY in
 * particular would make the CLI bill an API account instead of using the
 * subscription it is logged in with; the rest are this app's own secrets,
 * which the CLI has no use for.
 */
const WITHHELD_ENV = [
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_CLIENT_SECRET', 'CREDENTIAL_ENCRYPTION_KEY', 'TEST_USER_PASSWORD', 'TEST_ADMIN_PASSWORD', 'DATABASE_URL',
];

export function cliEnv(maxOutputTokens?: number): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of WITHHELD_ENV) delete childEnv[key];
  if (maxOutputTokens) childEnv['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = String(maxOutputTokens);
  return childEnv;
}

/** Builds the argument vector. Exported for tests; values are never shell-interpreted. */
export function buildCliArgs(opts: ClaudeCliOptions, system: string): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  return args;
}

/** stderr can be long and chatty; keep a short, secret-scrubbed tail. */
function stderrSummary(stderr: string): string {
  const text = sanitizeForAi(stderr.trim()).replace(/\s+/g, ' ');
  return text.length > 400 ? `...${text.slice(-400)}` : text;
}

function parseEnvelope(stdout: string): CliEnvelope | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    // Some CLI versions print an array of events; the result is the last one.
    if (Array.isArray(value)) return (value.filter((v) => (v as CliEnvelope)?.type === 'result').pop() as CliEnvelope) ?? null;
    return value as CliEnvelope;
  } catch {
    return null;
  }
}

export class ClaudeCliProvider implements AiProvider {
  readonly name = 'claude-cli';
  readonly model: string;

  constructor(private readonly opts: ClaudeCliOptions) {
    this.model = opts.model ?? 'cli-default';
  }

  /** Subscription usage is not billed per token, so nothing is attributed. */
  estimateCost(_usage: AiUsage): number {
    return 0;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    // Last-chance scrub: no secret ever leaves this process (spec section 27).
    const system = sanitizeForAi(request.system);
    const user = sanitizeForAi(request.user);

    let result: ProcessResult;
    try {
      result = await runProcess(this.opts.command, buildCliArgs(this.opts, system), {
        input: user,
        timeoutMs: this.opts.timeoutMs,
        env: cliEnv(request.maxOutputTokens),
        cwd: this.opts.cwd ?? os.tmpdir(),
      });
    } catch (e) {
      if (e instanceof ProcessStartError && (e.code === 'ENOENT' || e.code === 'EACCES')) {
        throw new AiProviderError(
          `Claude CLI not found: could not run "${this.opts.command}" (${e.code}). Install Claude Code, run "claude" once to log in, or set CLAUDE_CLI_COMMAND to its path.`,
          false,
        );
      }
      throw new AiProviderError(`Claude CLI could not be started: ${e instanceof Error ? e.message : String(e)}`, false);
    }

    if (result.timedOut) {
      log.warn(`${request.agent}: Claude CLI timed out after ${this.opts.timeoutMs}ms.`);
      // Not retried automatically: a retry would spend the same budget again.
      throw new AiProviderError(`Claude CLI timed out after ${this.opts.timeoutMs}ms (CLAUDE_CLI_TIMEOUT_MS).`, false);
    }

    const envelope = parseEnvelope(result.stdout);

    if (envelope?.is_error || (result.exitCode !== 0 && envelope)) {
      const status = envelope?.api_error_status ?? undefined;
      const detail = sanitizeForAi(String(envelope?.result ?? envelope?.subtype ?? 'unknown error')).slice(0, 400);
      const retryable = status === 429 || status === 529 || (status !== undefined && status >= 500);
      log.warn(`${request.agent}: Claude CLI reported an error (exit ${result.exitCode}${status ? `, status ${status}` : ''}).`);
      throw new AiProviderError(`Claude CLI error${status ? ` (${status})` : ''}: ${detail}`, retryable, status ?? undefined);
    }

    if (result.exitCode !== 0 || !envelope) {
      const why = result.exitCode !== 0
        ? `exited with code ${result.exitCode ?? `signal ${result.signal}`}`
        : 'returned output that is not the expected JSON envelope';
      const stderr = stderrSummary(result.stderr);
      throw new AiProviderError(`Claude CLI ${why}.${stderr ? ` stderr: ${stderr}` : ''}`, false);
    }

    const text = envelope.structured_output !== undefined && envelope.structured_output !== null
      ? JSON.stringify(envelope.structured_output)
      : String(envelope.result ?? '');

    const u = envelope.usage ?? {};
    const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      || estimateTokens(system + user);
    const completionTokens = u.output_tokens ?? estimateTokens(text);
    const usedModel = Object.keys(envelope.modelUsage ?? {})[0] ?? this.model;

    return {
      text,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      model: usedModel,
      provider: this.name,
    };
  }
}
