import type { ChannelsRegistry } from '../config/registries.js';
import type { Channel, ClaimVerification } from '../domain/index.js';
import { FACT_CATALOGUE, isKnownFact, meetsMinimum } from '../research/index.js';
import { ANGLE_CATALOGUE, type ClaimView } from '../story/index.js';
import {
  GENERATION_SCHEMA_VERSION,
  type BriefFact,
  type ChannelSpec,
  type GenerationInput,
} from './schemas.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2026-11-10T12:00:00Z" becomes "10 November 2026". Anything unparseable is returned as given. */
export function longDate(iso: unknown): string {
  const s = str(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : s;
}

/**
 * One plain sentence per claim, written by code from the claim value. The model is told to prefer
 * these to the raw value, so figures reach the text exactly as the research package has them.
 */
export function statementFor(key: string, value: unknown): string {
  const v = rec(value);
  switch (key) {
    case 'event.name':
      return str(value);
    case 'event.dates':
      return v.end
        ? `The event runs from ${longDate(v.start)} to ${longDate(v.end)}`
        : `The event starts on ${longDate(v.start)}`;
    case 'event.venue':
      return `Venue: ${str(value)}`;
    case 'format':
      return `Format: ${[str(v.format), v.timeControl ? `time control ${str(v.timeControl)}` : '']
        .filter(Boolean)
        .join(', ')}`;
    case 'participants': {
      const names = Array.isArray(value) ? value.map((p) => str(rec(p).name)).filter(Boolean) : [];
      return `Players: ${names.join(', ')}`;
    }
    case 'game.result':
      return `Round ${str(v.round)}: ${str(v.white)} (White) vs ${str(v.black)} (Black) ended ${str(v.result)}`;
    case 'game.key_moments': {
      const moments = Array.isArray(value) ? value.map(rec) : [];
      const top = [...moments].sort((a, b) => Number(b.swing ?? 0) - Number(a.swing ?? 0))[0];
      return top
        ? `The biggest swing came at move ${str(top.moveNumber)} (${str(top.san)}), with the engine evaluation moving from ${str(top.evalBefore)} to ${str(top.evalAfter)}`
        : 'No large evaluation swing';
    }
    case 'match.score': {
      const players = Array.isArray(v.players) ? v.players.map(rec) : [];
      const [a, b] = players;
      if (!a || !b) return 'Match score unavailable';
      return `Match score after ${plural(Number(v.completedGames ?? 0), 'game', 'games')}: ${str(a.points)}-${str(b.points)} (${str(a.name)} v ${str(b.name)})`;
    }
    case 'match.situation': {
      const remaining = plural(Number(v.roundsRemaining ?? 0), 'round', 'rounds');
      return v.leader
        ? `${str(v.leader)} leads by ${plural(Number(v.margin ?? 0), 'point', 'points')} with ${remaining} remaining`
        : `The match is level with ${remaining} remaining`;
    }
    case 'next_game':
      return `Next: ${str(v.name)}${v.startsAt ? ` on ${longDate(v.startsAt)}` : ''}`;
    case 'event.outcome': {
      const table = Array.isArray(v.standings) ? v.standings.map(rec) : [];
      const standings = table.map((s) => `${str(s.name)} ${str(s.points)}`).join(', ');
      return v.winner
        ? `${str(v.winner)} won the event. Final standings: ${standings}`
        : `The event finished level. Standings: ${standings}`;
    }
    default:
      return `${key}: ${JSON.stringify(value)}`.slice(0, 300);
  }
}

// ---------------------------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------------------------

const INJECTION = [
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|instructions)/i,
  /\b(?:system|developer)\s*(?:prompt|message|instruction)/i,
  /you\s+(?:are|must|should)\s+now\b/i,
  /\bas\s+an\s+ai\b/i,
  /<\/?\s*(?:data|system|instructions?)\b/i,
  /\bnew\s+instructions?\b/i,
];

/** True when a piece of source text reads like an instruction to the model. */
export function looksLikeInstruction(text: string): boolean {
  return INJECTION.some((re) => re.test(text));
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((x) => strings(x, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((x) => strings(x, out));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Building the input
// ---------------------------------------------------------------------------------------------

export interface BuildInputParams {
  postType: string;
  opportunityId: string;
  packageId: string;
  phase: string | null;
  angleId: string;
  claims: ClaimView[];
  contentRules: { tone: string; structure: string[]; restrictions: string[] };
  /** Channels the post type publishes to. */
  channelIds: Channel[];
  channels: ChannelsRegistry;
  imageRules: GenerationInput['imageRules'];
}

/**
 * Turns a research package into the model's input. Claims below their verification level are left out
 * (the model never sees what may not be published), and so is any claim whose text looks like an
 * instruction. Disabled channels are skipped.
 */
export function buildGenerationInput(p: BuildInputParams): GenerationInput {
  const angle = ANGLE_CATALOGUE.find((a) => a.id === p.angleId);
  if (!angle) throw new Error(`unknown angle ${p.angleId}`);
  const warnings: string[] = [];

  const facts: BriefFact[] = [];
  for (const c of [...p.claims].sort((a, b) => a.claimKey.localeCompare(b.claimKey))) {
    if (!isKnownFact(c.claimKey)) {
      warnings.push(`${c.claimKey}: not in the fact catalogue, left out`);
      continue;
    }
    if (
      !meetsMinimum(c.verification as ClaimVerification, FACT_CATALOGUE[c.claimKey].minVerification)
    ) {
      warnings.push(`${c.claimKey}: ${c.verification}, below its required level, left out`);
      continue;
    }
    const statement = statementFor(c.claimKey, c.value);
    if ([statement, ...strings(c.value)].some(looksLikeInstruction)) {
      warnings.push(`${c.claimKey}: contains text that looks like an instruction, left out`);
      continue;
    }
    facts.push({
      key: c.claimKey,
      description: FACT_CATALOGUE[c.claimKey].description,
      statement,
      value: c.value,
      verification: c.verification as ClaimVerification,
      ...(c.eventTime && { eventTime: c.eventTime }),
    });
  }

  const channels: ChannelSpec[] = [];
  for (const id of p.channelIds) {
    const entry = p.channels.channels.find((c) => c.id === id);
    if (!entry) continue;
    if (!entry.enabled) {
      warnings.push(`channel ${id} is disabled, skipped`);
      continue;
    }
    channels.push({
      id,
      maxTextLength: entry.maxTextLength,
      altTextRequired: entry.altTextRequired,
      mediaRequired: entry.mediaRequired,
    });
  }

  return {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    postType: p.postType,
    opportunityId: p.opportunityId,
    packageId: p.packageId,
    phase: p.phase,
    angle: {
      id: angle.id,
      description: angle.description,
      requiredFacts: [...angle.requiredFacts],
    },
    facts,
    contentRules: p.contentRules,
    channels,
    imageRules: p.imageRules,
    allowedTemplates: p.imageRules.template ? [p.imageRules.template] : ['none'],
    warnings,
  };
}

/**
 * Renders data for a prompt. The JSON sits inside a labelled block, and `<` is escaped so source text
 * can never close the block or open a fake one.
 */
export function dataBlock(label: string, data: unknown): string {
  const json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
  return `<data label="${label}">\n${json}\n</data>`;
}
