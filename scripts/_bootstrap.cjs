/**
 * Bootstrap for the standalone scripts (seed, worker, backtest, token issuer).
 *
 * The server modules these scripts import are marked with `server-only`, which
 * throws outside a React Server Component. That marker is worth keeping -- it is
 * what stops a database handle or a gateway secret from being pulled into a
 * client bundle by accident -- so rather than removing it, the scripts stub it
 * here. Node and Next resolve it normally everywhere else.
 */
const Module = require('node:module');
const path = require('node:path');

const STUB = path.join(__dirname, '_server-only-stub.cjs');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, ...rest) {
  if (request === 'server-only') return STUB;
  return originalResolve.call(this, request, ...rest);
};

/**
 * Load `.env.local` then `.env` into `process.env`.
 *
 * Next does this for the web app, but nothing did it for these scripts, so
 * `pnpm backtest`, `pnpm worker` and `pnpm refresh:sp500` ran with no API keys
 * however carefully the operator had filled the file in -- they reported
 * `no_api_key` and looked like a provider problem. A real environment variable
 * still wins: the file only fills in what the shell did not set.
 */
const fs = require('node:fs');

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0];
    if (quoted) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

for (const file of ['.env.local', '.env']) {
  loadEnvFile(path.join(process.cwd(), file));
}
