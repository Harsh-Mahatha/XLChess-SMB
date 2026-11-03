import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ChannelsRegistry,
  ConfigError,
  PostTypeConfig,
  SourcesRegistry,
  Taxonomy,
  crossValidate,
  zodIssues,
  type ConfigSet,
  type LoadedConfig,
} from '@smb/shared';

/** Repo-level /config folder (works from src/ and from dist/, which sit at the same depth). */
export const DEFAULT_CONFIG_DIR = resolve(import.meta.dirname, '../../../../config');

export interface RawConfigFiles {
  sources: unknown;
  channels: unknown;
  taxonomy: unknown;
  postTypes: { file: string; json: unknown }[];
}

function readJson(path: string, label: string, issues: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    issues.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Reads the config folder. Files starting with "_" in post-types/ are ignored (drafts, notes). */
export function readConfigDir(
  dir: string = process.env.SMB_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
): RawConfigFiles {
  const issues: string[] = [];
  const sources = readJson(join(dir, 'sources.json'), 'sources.json', issues);
  const channels = readJson(join(dir, 'channels.json'), 'channels.json', issues);
  const taxonomy = readJson(join(dir, 'taxonomy.json'), 'taxonomy.json', issues);

  const typesDir = join(dir, 'post-types');
  const postTypes: RawConfigFiles['postTypes'] = [];
  if (!existsSync(typesDir)) {
    issues.push(`post-types: folder not found at ${typesDir}`);
  } else {
    for (const file of readdirSync(typesDir).sort()) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const json = readJson(join(typesDir, file), file, issues);
      if (json !== undefined) postTypes.push({ file, json });
    }
  }
  if (issues.length) throw new ConfigError(issues);
  return { sources, channels, taxonomy, postTypes };
}

/** Validates raw JSON (schemas first, then cross-file references). Throws one ConfigError listing every problem. */
export function buildConfigSet(raw: RawConfigFiles): ConfigSet {
  const issues: string[] = [];

  const sources = SourcesRegistry.safeParse(raw.sources);
  if (!sources.success) issues.push(...zodIssues('sources.json', sources.error));
  const channels = ChannelsRegistry.safeParse(raw.channels);
  if (!channels.success) issues.push(...zodIssues('channels.json', channels.error));
  const taxonomy = Taxonomy.safeParse(raw.taxonomy);
  if (!taxonomy.success) issues.push(...zodIssues('taxonomy.json', taxonomy.error));

  const configs: LoadedConfig[] = [];
  for (const { file, json } of raw.postTypes) {
    const parsed = PostTypeConfig.safeParse(json);
    if (parsed.success) configs.push({ file, config: parsed.data });
    else issues.push(...zodIssues(file, parsed.error));
  }
  if (issues.length || !sources.success || !channels.success || !taxonomy.success) {
    throw new ConfigError(issues);
  }

  const set: ConfigSet = {
    configs,
    sources: sources.data,
    channels: channels.data,
    taxonomy: taxonomy.data,
  };
  const crossIssues = crossValidate(set);
  if (crossIssues.length) throw new ConfigError(crossIssues);
  return set;
}

export function loadConfigSet(dir?: string): ConfigSet {
  return buildConfigSet(readConfigDir(dir));
}
