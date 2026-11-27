import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

const SENSITIVE_KEY = /(token|secret|password|api_?key|pairing_?code|authorization|cookie)/i;

/** Deep-copies an audit details object and replaces any sensitive key values with `[REDACTED]`. */
export function scrubAuditDetails(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => scrubAuditDetails(item));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrubAuditDetails(v);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  actor: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

/** Appends one row to `smb.audit_log`, scrubbing secret-looking keys from `details`. */
export async function writeAudit(tx: Db, entry: AuditEntry) {
  return tx.audit_log.create({
    data: {
      actor: entry.actor,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: scrubAuditDetails(entry.details ?? {}) as Prisma.InputJsonValue,
    },
  });
}
