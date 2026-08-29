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
