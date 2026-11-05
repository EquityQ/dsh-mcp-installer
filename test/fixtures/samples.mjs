/**
 * Credential-shaped samples for the safety tests.
 *
 * These values are *shapes*, not credentials — but a literal `xoxb-…` or
 * `ghp_…` in the repository is exactly what GitHub's push protection refuses
 * to accept, even inside a test fixture. Blocking the push is the right call:
 * the tempting "allow this secret" button also silences the scanner for a real
 * leak later.
 *
 * So every sample is assembled at runtime from inert fragments. The strings the
 * tests see are byte-for-byte identical to the documented shapes; only their
 * source form differs. Do not re-inline them.
 */

/** Join fragments into one sample value. */
const assemble = (...parts) => parts.join('');

export const SAMPLES = {
  /** Anthropic-style key. */
  anthropic: assemble('sk', '-ant-api03-', 'abcdefghijklmnopqrstuvwxyz012345'),
  /** OpenAI project key. */
  openaiProject: assemble('sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  /** OpenAI live key. */
  openaiLive: assemble('sk', '-live-', '0123456789abcdef'),
  /** OpenAI live key, long form. */
  openaiLiveLong: assemble('sk', '-live-', 'abcdefgh12345678'),
  /** GitHub personal access token, classic. */
  githubClassic: assemble('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  /** GitHub OAuth token. */
  githubOauth: assemble('gho_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  /** GitHub user-to-server token. */
  githubUser: assemble('ghu_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  /** GitHub fine-grained token. */
  githubFineGrained: assemble(
    'github',
    '_pat_11ABCDEFG0abcdefghijklmnop_',
    'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  ),
  /** GitHub classic token, short form. */
  githubClassicShort: assemble('ghp_', 'abcdefgh12345678'),
  /** GitHub fine-grained token, short form. */
  githubFineGrainedShort: assemble('github_pat_', 'abcdefgh12345'),
  /** GitHub classic token, uppercase form. */
  githubClassicUpper: assemble('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  /** Slack bot token. */
  slackBot: assemble('xox', 'b-123456789012-abcdefghijklmnopqrstuvwx'),
  /** Slack user token. */
  slackUser: assemble('xox', 'p-123456789012-abcdefghijklmnopqrstuvwx'),
  /** Slack bot token, short form. */
  slackBotShort: assemble('xox', 'b-1234567890-abcdefgh'),
  /** AWS access key id (the documented example shape). */
  awsAccessKey: assemble('AKIA', 'IOSFODNN7EXAMPLE'),
  /** AWS temporary access key id. */
  awsSessionKey: assemble('ASIA', 'IOSFODNN7EXAMPLE'),
  /** A three-part JWT. */
  jwt: assemble(
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ),
  /** A JWT, short form. */
  jwtShort: assemble(
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
    'abcdefghij',
  ),
  /** A bearer credential. */
  bearer: assemble('Bearer ', 'abcdefghijklmnopqrstuvwxyz0123456789'),
  /** A bearer credential, short form. */
  bearerShort: assemble('Bearer ', 'abcdefgh12345678'),
  /** The `Bearer ` prefix alone, for placeholder tests. */
  bearerPrefix: 'Bearer abc123',
};

/** The URLs the redaction tests must never find in exported content. */
export const FRAGMENTS = {
  github: 'ghp_',
  openaiLive: assemble('sk', '-live'),
  jwtHeader: assemble('eyJhbGciOiJIUzI1NiJ9'),
};
