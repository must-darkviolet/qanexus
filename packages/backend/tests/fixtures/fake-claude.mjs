#!/usr/bin/env node
// Stand-in for the Claude Code CLI in unit tests. Behaviour is chosen with
// FAKE_CLAUDE_MODE; no network, no model, no credentials.
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';

if (args[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\n'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: mode !== 'logged-out', email: 'someone@example.com', orgName: 'Private Org' }));
  process.exit(0);
}

let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const envelope = (result, extra = {}) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 7 },
    modelUsage: { 'fake-model': {} }, ...extra,
  });
  switch (mode) {
    case 'ok':
      process.stdout.write(envelope(JSON.stringify({
        ok: true, args, stdinLength: stdin.length,
        maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
        leaked: ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN'].filter((k) => process.env[k]),
      })));
      process.exit(0);
      break;
    case 'malformed':
      process.stdout.write(envelope('I think the answer is probably fine, no JSON here.'));
      process.exit(0);
      break;
    case 'fail':
      process.stderr.write('fatal: something broke in the CLI\n');
      process.exit(2);
      break;
    case 'api-error':
      process.stdout.write(envelope('API Error: rate limited', { is_error: true, subtype: 'error', api_error_status: 429 }));
      process.exit(1);
      break;
    case 'logged-out':
      process.stdout.write(envelope('Not logged in · Please run /login', { is_error: true, subtype: 'error' }));
      process.exit(1);
      break;
    case 'garbage':
      process.stdout.write('<<not json>>');
      process.exit(0);
      break;
    case 'hang':
      setTimeout(() => process.exit(0), 30_000);
      break;
  }
});
