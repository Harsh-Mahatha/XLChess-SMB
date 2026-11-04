import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { configHash } from '@smb/shared';

export interface SourceRecordInput {
  sourceId: string;
  url: string;
  retrievedAt: Date;
  eventTime?: Date;
  adapterVersion: string;
  rawPayload: unknown;
  payloadHash: string;
  normalised: unknown;
}

export interface StoredRecord {
  id: string;
  retrievedAt: Date;
}

/** Persists evidence for every item an adapter returns (smb.source_records). */
export interface SourceRecordStore {
  save(input: SourceRecordInput): Promise<StoredRecord>;
}

/** SHA-256 of a string payload as-is, or of canonical JSON for structured payloads. */
export function payloadHash(raw: unknown): string {
  if (typeof raw === 'string') return createHash('sha256').update(raw).digest('hex');
  return configHash(raw);
}

/** For tests and dry runs. Same dedupe rule as the database store. */
export class InMemorySourceRecordStore implements SourceRecordStore {
  readonly records: (SourceRecordInput & StoredRecord)[] = [];

  async save(input: SourceRecordInput): Promise<StoredRecord> {
    const latest = this.records
      .filter((r) => r.sourceId === input.sourceId && r.url === input.url)
      .at(-1);
    if (latest?.payloadHash === input.payloadHash) return latest;
    const stored = { ...input, id: randomUUID() };
    this.records.push(stored);
    return stored;
  }
}

/**
 * Database store. If the newest record for the same source and URL has an identical payload hash,
 * that record is reused instead of inserting a duplicate row on every poll.
 */
export class PrismaSourceRecordStore implements SourceRecordStore {
  constructor(private readonly db: PrismaClient) {}

  async save(input: SourceRecordInput): Promise<StoredRecord> {
    const latest = await this.db.source_records.findFirst({
      where: { source_id: input.sourceId, url: input.url },
      orderBy: { retrieved_at: 'desc' },
      select: { id: true, retrieved_at: true, payload_hash: true },
    });
    if (latest?.payload_hash === input.payloadHash) {
      return { id: latest.id, retrievedAt: latest.retrieved_at };
    }
    const row = await this.db.source_records.create({
      data: {
        source_id: input.sourceId,
        url: input.url,
        retrieved_at: input.retrievedAt,
        event_time: input.eventTime,
        adapter_version: input.adapterVersion,
        raw_payload: input.rawPayload as Prisma.InputJsonValue,
        payload_hash: input.payloadHash,
        normalised: input.normalised as Prisma.InputJsonValue,
      },
      select: { id: true, retrieved_at: true },
    });
    return { id: row.id, retrievedAt: row.retrieved_at };
  }
}
