import { ZodError } from 'zod';
import type { ChannelsRegistry, SourcesRegistry, Taxonomy } from './registries.js';
import { ConfigOverride, PostTypeConfig, type ContentRules, type ScheduleRule } from './schema.js';

/** Thrown with every problem found, so a bad config set is fixed in one pass. */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function zodIssues(prefix: string, err: ZodError): string[] {
  return err.issues.map(
    (i) => `${prefix}${i.path.length ? ` ${i.path.join('.')}:` : ':'} ${i.message}`,
  );
}

export interface LoadedConfig {
  /** File name, used in messages and to check the `<id>-name.json` convention. */
  file: string;
  config: PostTypeConfig;
}

export interface ConfigSet {
  configs: LoadedConfig[];
  sources: SourcesRegistry;
  channels: ChannelsRegistry;
  taxonomy: Taxonomy;
}

/** Checks that need more than one file: references between configs, registries and the taxonomy. */
export function crossValidate(set: ConfigSet): string[] {
  const issues: string[] = [];
  const subtypes = new Map(
    set.taxonomy.categories.flatMap((c) => c.subtypes).map((s) => [s.id, s]),
  );
  const sources = new Map(set.sources.sources.map((s) => [s.id, s]));
  const channels = new Map(set.channels.channels.map((c) => [c.id, c]));
  const seen = new Map<string, string>();

  for (const { file, config: cfg } of set.configs) {
    const at = (msg: string) => `${file}: ${msg}`;

    const dup = seen.get(cfg.id);
    if (dup) issues.push(at(`id ${cfg.id} is already used by ${dup}`));
    seen.set(cfg.id, file);

    if (!file.startsWith(`${cfg.id}-`)) issues.push(at(`file name must start with "${cfg.id}-"`));
    if (!subtypes.has(cfg.id)) issues.push(at(`id ${cfg.id} is not in the taxonomy`));

    for (const id of cfg.sources) {
      const s = sources.get(id);
      if (!s) issues.push(at(`unknown data source ${id}`));
      else if (s.kind !== 'data') issues.push(at(`${id} is an image source, not a data source`));
      else if (!s.enabled && cfg.enabled) issues.push(at(`data source ${id} is disabled`));
    }
    for (const id of cfg.imageSources) {
      const s = sources.get(id);
      if (!s) issues.push(at(`unknown image source ${id}`));
      else if (s.kind !== 'image') issues.push(at(`${id} is a data source, not an image source`));
      else if (!s.enabled && cfg.enabled) issues.push(at(`image source ${id} is disabled`));
    }

    for (const id of cfg.channels) {
      if (!channels.has(id)) issues.push(at(`unknown channel ${id}`));
    }
    // Disabled channels are allowed (skipped at publish time), but a live post type needs one that works.
    if (cfg.enabled && !cfg.channels.some((id) => channels.get(id)?.enabled)) {
      issues.push(at('enabled post type has no enabled channel'));
    }
  }
  return issues;
}

/** Applies a runtime override to the file config and re-validates the result in full. */
export function applyOverride(base: PostTypeConfig, override: unknown): PostTypeConfig {
  const parsed = ConfigOverride.safeParse(override);
  if (!parsed.success) throw new ConfigError(zodIssues('override', parsed.error));
  const o = parsed.data;

  if (o.channels) {
    const extra = o.channels.filter((c) => !base.channels.includes(c));
    if (extra.length) {
      throw new ConfigError([
        `override channels must be a subset of the file config (not allowed: ${extra.join(', ')})`,
      ]);
    }
  }
  const merged = {
    ...base,
    ...(o.enabled !== undefined && { enabled: o.enabled }),
    ...(o.priority !== undefined && { priority: o.priority }),
    ...(o.channels && { channels: o.channels }),
    ...(o.schedule && { schedule: o.schedule }),
    contentRules: {
      ...base.contentRules,
      restrictions: [
        ...new Set([...base.contentRules.restrictions, ...(o.contentRules?.restrictions ?? [])]),
      ],
    },
  };
  const result = PostTypeConfig.safeParse(merged);
  if (!result.success) throw new ConfigError(zodIssues('merged config', result.error));
  return result.data;
}

export interface EffectiveConfig {
  phaseId: string | null;
  schedule: ScheduleRule[];
  priority: number;
  contentRules: ContentRules;
  staleAfterMinutes: number;
}

/**
 * What applies while a phase is active. A phase replaces schedule, priority and wording,
 * and adds restrictions on top of the base ones. Passing null returns the base behaviour.
 */
export function resolvePhase(cfg: PostTypeConfig, phaseId: string | null): EffectiveConfig {
  const phase = phaseId === null ? undefined : cfg.phases.find((p) => p.id === phaseId);
  if (phaseId !== null && !phase)
    throw new ConfigError([`post type ${cfg.id} has no phase "${phaseId}"`]);
  const overlay = phase?.contentRules;
  return {
    phaseId,
    schedule: phase?.schedule ?? cfg.schedule,
    priority: phase?.priority ?? cfg.priority,
    staleAfterMinutes: phase?.staleAfterMinutes ?? cfg.retryPolicy.staleAfterMinutes,
    contentRules: {
      ...cfg.contentRules,
      ...(overlay?.requiredFacts && { requiredFacts: overlay.requiredFacts }),
      ...(overlay?.tone && { tone: overlay.tone }),
      ...(overlay?.structure && { structure: overlay.structure }),
      restrictions: [
        ...new Set([...cfg.contentRules.restrictions, ...(overlay?.restrictions ?? [])]),
      ],
    },
  };
}
