/* eslint-disable no-console -- command-line tool */
import { ConfigError } from '@smb/shared';
import { loadConfigSet } from './loader.js';

/** `npm run config:validate`: checks every file in /config and exits non-zero on any problem. */
try {
  const set = loadConfigSet(process.argv[2]);
  const enabled = set.configs.filter((c) => c.config.enabled).length;
  const subtypes = set.taxonomy.categories.reduce((n, c) => n + c.subtypes.length, 0);
  console.log(
    `Config OK: ${set.configs.length} post type(s) configured (${enabled} enabled) of ${subtypes} in the taxonomy; ` +
      `${set.sources.sources.length} sources, ${set.channels.channels.length} channels.`,
  );
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
