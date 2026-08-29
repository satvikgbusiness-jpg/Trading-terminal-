import { z } from 'zod';
import { tryResolveAsset } from '@/lib/symbols';

/**
 * Every field the bot can send is validated here.
 *
 * The bot is assumed to be untrusted, self-modifying code. That makes this file
 * the trust boundary: schemas are strict (unknown keys are rejected, not
 * stripped and ignored), strings are length-capped so a payload cannot be used
 * to exhaust memory or bloat the audit log, and numbers must be finite. Nothing
 * a bot sends is ever interpolated into SQL, a shell, a template, or eval --
 * values reach the database only through parameterised statements.
 */

const MAX_STRING = 64;

/** Symbols must resolve to something the terminal actually models. */
const symbolSchema = z
  .string()
  .min(1)
  .max(MAX_STRING)
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => tryResolveAsset(s) !== null, {
    message: 'Unrecognised symbol. Use forms like AAPL, BTC-USD or EUR/USD.',
  });

const positiveFinite = z
  .number()
  .refine(Number.isFinite, { message: 'must be a finite number' })
  .positive();

export const orderIntentSchema = z
  .object({
    symbol: symbolSchema,
    side: z.enum(['buy', 'sell']),
    quantity: positiveFinite.max(1_000_000_000),
    orderType: z.enum(['market', 'limit']).default('market'),
    limitPrice: positiveFinite.max(1_000_000_000).optional(),
    /**
     * Live intents never execute automatically. They queue for explicit human
     * approval, and v1 has no broker connection behind that approval.
     */
    mode: z.enum(['paper', 'live']).default('paper'),
    /** Idempotency key. Re-submitting the same ref returns the original intent. */
    clientRef: z.string().min(1).max(MAX_STRING).optional(),
  })
  .strict()
  .refine((o) => o.orderType !== 'limit' || o.limitPrice !== undefined, {
    message: 'limitPrice is required for a limit order',
    path: ['limitPrice'],
  })
  .refine((o) => o.orderType !== 'market' || o.limitPrice === undefined, {
    message: 'limitPrice is not valid on a market order',
    path: ['limitPrice'],
  });

export type OrderIntentInput = z.infer<typeof orderIntentSchema>;

export const quoteQuerySchema = z.object({ symbol: symbolSchema }).strict();

export const orderIdSchema = z
  .string()
  .min(1)
  .max(MAX_STRING)
  .regex(/^[A-Za-z0-9_-]+$/, 'Order ids are alphanumeric');

export const approvalDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    /** Shown in the audit log so a decision can be explained later. */
    note: z.string().max(500).optional(),
  })
  .strict();

/** Flattens a ZodError into a bot-readable list without leaking internals. */
export function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}
