import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';

/**
 * Provides one Postgres for the whole integration run.
 *  - SMB_TEST_DATABASE_URL set: use that database (each test file drops and recreates the `smb` schema).
 *  - otherwise: start the Supabase Postgres image with Testcontainers (needs Docker).
 */
const IMAGE = process.env.SMB_TEST_PG_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.11.0.003';

let container: StartedTestContainer | undefined;

async function waitForDb(url: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  let url = process.env.SMB_TEST_DATABASE_URL;
  if (!url) {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ POSTGRES_PASSWORD: 'postgres' })
      .withExposedPorts(5432)
      .start();
    url = `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
  }
  await waitForDb(url);
  provide('dbUrl', url);
  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
  }
}
