/**
 * Issue a gateway token for a bot process.
 *
 *   pnpm token:issue -- --name my-bot [--scopes quote:read,order:submit]
 *
 * The secret is printed once and never stored in the clear.
 */
import { issueToken, SCOPES, type Scope } from '@/lib/gateway/auth';
import { ensureAccount } from '@/lib/gateway/paper';

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? (process.argv[index + 1] ?? null) : null;
}

const name = arg('--name') ?? `bot-${new Date().toISOString().slice(0, 16)}`;
const scopesArg = arg('--scopes');

let scopes: Scope[] | undefined;
if (scopesArg) {
  const requested = scopesArg.split(',').map((s) => s.trim());
  const invalid = requested.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (invalid.length > 0) {
    console.error(`Unknown scope(s): ${invalid.join(', ')}`);
    console.error(`Valid scopes: ${SCOPES.join(', ')}`);
    process.exit(1);
  }
  scopes = requested as Scope[];
}

const account = ensureAccount();
const issued = issueToken({ name, accountId: account.id, scopes });

console.log('\nToken issued. This secret is shown once and cannot be recovered.\n');
console.log(`  name    ${issued.name}`);
console.log(`  id      ${issued.id}`);
console.log(`  scopes  ${issued.scopes.join(' ')}`);
console.log(`  account ${account.name} (paper)\n`);
console.log(`  ${issued.token}\n`);
console.log('Use it as:  Authorization: Bearer <token>');
console.log('Revoke it from the /bot console, or with the kill switch.\n');
