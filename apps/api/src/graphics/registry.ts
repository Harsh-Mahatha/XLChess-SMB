import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TemplateManifest, zodIssues } from '@smb/shared';
import { GraphicError } from './text.js';

/** Repo-level /config/templates (same depth from src/ and dist/). */
export const DEFAULT_TEMPLATE_DIR = resolve(import.meta.dirname, '../../../../config/templates');

export class TemplateRegistry {
  private readonly byName = new Map<string, TemplateManifest>();

  constructor(readonly manifests: TemplateManifest[]) {
    for (const m of manifests) {
      for (const name of [m.id, ...m.aliases]) {
        if (this.byName.has(name)) throw new Error(`template name "${name}" is used twice`);
        this.byName.set(name, m);
      }
    }
  }

  /** Resolves an id or alias. */
  get(name: string): TemplateManifest {
    const m = this.byName.get(name);
    if (!m) {
      throw new GraphicError(
        'unknown_template',
        `no template "${name}" (known: ${[...this.byName.keys()].sort().join(', ')})`,
      );
    }
    return m;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

export class TemplateConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`template configuration is invalid:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'TemplateConfigError';
  }
}

/** Reads and validates every `*.json` in the templates folder (files starting with "_" are ignored). */
export function loadTemplates(dir: string = process.env.SMB_TEMPLATE_DIR ?? DEFAULT_TEMPLATE_DIR): TemplateRegistry {
  if (!existsSync(dir)) throw new TemplateConfigError([`templates folder not found at ${dir}`]);
  const issues: string[] = [];
  const manifests: TemplateManifest[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      issues.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = TemplateManifest.safeParse(json);
    if (!parsed.success) issues.push(...zodIssues(file, parsed.error));
    else if (file !== `${parsed.data.id}.json`) issues.push(`${file}: the file must be named ${parsed.data.id}.json`);
    else manifests.push(parsed.data);
  }
  if (issues.length) throw new TemplateConfigError(issues);
  try {
    return new TemplateRegistry(manifests);
  } catch (err) {
    throw new TemplateConfigError([err instanceof Error ? err.message : String(err)]);
  }
}
