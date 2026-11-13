import type { LicenceEvidence } from './types.js';

/**
 * Licence rules for photographs (module 1.8). Pure code, no model. The rule is "reject uncertain rights":
 * a photo is accepted only when its licence is understood, allows commercial use and modification, and
 * every obligation (credit, share-alike) can be met.
 */

/** Bump whenever a rule below changes, so a stored decision says which rules made it. */
export const LICENCE_POLICY_VERSION = 'licence-policy@1.0.0';

export type LicenceFamily = 'public_domain' | 'cc' | 'gfdl' | 'unknown';

export interface ParsedLicence {
  family: LicenceFamily;
  version?: string;
  nc: boolean;
  nd: boolean;
  sa: boolean;
  /** Short display name such as "CC BY-SA 4.0". */
  label: string;
}

const UNKNOWN: ParsedLicence = { family: 'unknown', nc: false, nd: false, sa: false, label: '' };

function ccLabel(nc: boolean, nd: boolean, sa: boolean, version?: string): string {
  return `CC BY${nc ? '-NC' : ''}${nd ? '-ND' : ''}${sa ? '-SA' : ''}${version ? ` ${version}` : ''}`;
}

/** "CC BY-SA 4.0", "CC-BY-3.0-de", "CC BY-NC-ND 2.0", "CC0", "Public domain", "GFDL 1.2". */
export function parseLicenceName(name: string | undefined): ParsedLicence {
  const s = (name ?? '').trim();
  if (!s) return UNKNOWN;
  const lower = s.toLowerCase();

  if (/^cc[\s_-]*(0|zero)\b/.test(lower)) {
    return {
      family: 'public_domain',
      version: '1.0',
      nc: false,
      nd: false,
      sa: false,
      label: 'CC0 1.0',
    };
  }
  const cc = /^cc[\s_-]*by((?:[\s_-]*(?:nc|nd|sa))*)(?:[\s_-]*(\d\.\d))?/.exec(lower);
  if (cc) {
    const mods = cc[1] ?? '';
    const nc = /nc/.test(mods);
    const nd = /nd/.test(mods);
    const sa = /sa/.test(mods);
    return { family: 'cc', version: cc[2], nc, nd, sa, label: ccLabel(nc, nd, sa, cc[2]) };
  }
  if (/^(public[\s_-]*domain|pdm\b|pd([\s_-]|$))/.test(lower)) {
    return { family: 'public_domain', nc: false, nd: false, sa: false, label: 'Public domain' };
  }
  if (/^(gfdl|gnu free documentation)/.test(lower)) {
    const v = /(\d\.\d)/.exec(lower)?.[1];
    return {
      family: 'gfdl',
      version: v,
      nc: false,
      nd: false,
      sa: true,
      label: v ? `GFDL ${v}` : 'GFDL',
    };
  }
  return { ...UNKNOWN, label: s };
}

/** creativecommons.org/licenses/by-sa/4.0/ and /publicdomain/zero|mark/1.0/. */
export function parseLicenceUrl(url: string | undefined): ParsedLicence {
  if (!url) return UNKNOWN;
  const lower = url.toLowerCase();
  if (/creativecommons\.org\/publicdomain\/zero\//.test(lower)) {
    return {
      family: 'public_domain',
      version: '1.0',
      nc: false,
      nd: false,
      sa: false,
      label: 'CC0 1.0',
    };
  }
  if (/creativecommons\.org\/publicdomain\/mark\//.test(lower)) {
    return {
      family: 'public_domain',
      version: '1.0',
      nc: false,
      nd: false,
      sa: false,
      label: 'Public domain',
    };
  }
  const m = /creativecommons\.org\/licenses\/by((?:-nc)?(?:-nd|-sa)?)\/(\d\.\d)/.exec(lower);
  if (!m) return UNKNOWN;
  const mods = m[1] ?? '';
  const nc = mods.includes('nc');
  const nd = mods.includes('nd');
  const sa = mods.includes('sa');
  return { family: 'cc', version: m[2], nc, nd, sa, label: ccLabel(nc, nd, sa, m[2]) };
}

export type LicenceRejectionCode =
  | 'non_free'
  | 'personality_rights'
  | 'restricted_use'
  | 'unknown_licence'
  | 'unknown_version'
  | 'licence_mismatch'
  | 'gfdl_only'
  | 'non_commercial'
  | 'no_derivatives'
  | 'share_alike_not_allowed'
  | 'no_author';

export const LICENCE_REJECTION_MESSAGES: Record<LicenceRejectionCode, string> = {
  non_free: 'The file is marked non-free (fair use) and cannot be used for promotion.',
  personality_rights: 'The provider flags personality rights on this image.',
  restricted_use: 'The provider lists use restrictions on this image.',
  unknown_licence: 'The licence is missing or not one SMB understands.',
  unknown_version: 'The licence version could not be determined.',
  licence_mismatch: 'The licence name and the licence link do not agree.',
  gfdl_only: 'GFDL-only files need the full licence text printed with the image.',
  non_commercial: 'The licence forbids commercial use.',
  no_derivatives: 'The licence forbids changes, and SMB crops and resizes photos.',
  share_alike_not_allowed: 'Share-alike licences are switched off in the image policy.',
  no_author: 'The licence requires crediting the author and none is recorded.',
};

export interface AssessOptions {
  /** Accept CC BY-SA. Decision of 2026-11-13: on. */
  allowShareAlike?: boolean;
}

export interface LicenceAssessment {
  decision: 'accepted' | 'rejected';
  reasons: LicenceRejectionCode[];
  /** Plain-language reasons joined, stored as the decision reason when rejected. */
  reason?: string;
  licenceType: string;
  licenceVersion?: string;
  commercialUseAllowed: boolean;
  modificationsAllowed: boolean;
  attributionRequired: boolean;
  attributionText?: string;
  shareAlike: boolean;
  otherObligations?: string;
  policyVersion: string;
}

/** A usable author name, or undefined. "Unknown" and similar placeholders are not an author. */
export function cleanAuthor(value: string | undefined): string | undefined {
  const s = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (/^(unknown|anonymous|n\/?a|not specified|none|\?+|-+)\b/i.test(s)) return undefined;
  return s;
}

/** The credit line that goes with the photo, in a fixed format. */
export function buildAttribution(args: {
  author?: string;
  sourceName: string;
  licenceLabel: string;
}): string {
  const who = args.author ? `${args.author} / ${args.sourceName}` : args.sourceName;
  return `Photo: ${who}, ${args.licenceLabel}`;
}

function sameTerms(a: ParsedLicence, b: ParsedLicence): boolean {
  if (a.family !== b.family) return false;
  if (a.family === 'cc') {
    return (
      a.nc === b.nc &&
      a.nd === b.nd &&
      a.sa === b.sa &&
      (!a.version || !b.version || a.version === b.version)
    );
  }
  return true;
}

/**
 * Decide whether a photo may be used in promotional graphics. Every reason that applies is reported, not
 * just the first. The intended use is fixed: commercial promotion, with the photo cropped and resized.
 */
export function assessLicence(
  evidence: LicenceEvidence,
  options: AssessOptions = {},
): LicenceAssessment {
  const allowShareAlike = options.allowShareAlike ?? true;
  const reasons: LicenceRejectionCode[] = [];

  const byName = parseLicenceName(evidence.licenceShortName);
  const byUrl = parseLicenceUrl(evidence.licenceUrl);
  let parsed = byName;
  if (byName.family === 'unknown' && byUrl.family !== 'unknown') parsed = byUrl;
  else if (byName.family !== 'unknown' && byUrl.family !== 'unknown' && !sameTerms(byName, byUrl)) {
    reasons.push('licence_mismatch');
  } else if (byName.family === 'cc' && !byName.version && byUrl.family === 'cc') {
    parsed = byUrl;
  }

  if (evidence.nonFree) reasons.push('non_free');
  const restrictions = evidence.restrictions.map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (restrictions.includes('personality')) reasons.push('personality_rights');
  if (restrictions.some((r) => r !== 'personality')) reasons.push('restricted_use');

  if (parsed.family === 'unknown') reasons.push('unknown_licence');
  if (parsed.family === 'gfdl') reasons.push('gfdl_only');
  if (parsed.family === 'cc') {
    if (parsed.nc) reasons.push('non_commercial');
    if (parsed.nd) reasons.push('no_derivatives');
    if (parsed.sa && !allowShareAlike) reasons.push('share_alike_not_allowed');
    if (!parsed.version) reasons.push('unknown_version');
  }

  const author = cleanAuthor(evidence.author) ?? cleanAuthor(evidence.copyrightHolder);
  const attributionRequired =
    parsed.family === 'cc' || evidence.providerRequiresAttribution === true;
  if (attributionRequired && !author) reasons.push('no_author');

  const accepted = reasons.length === 0;
  const label = parsed.label || evidence.licenceShortName?.trim() || 'unknown';
  const shareAlike = parsed.sa && parsed.family === 'cc';
  const commercial = parsed.family === 'public_domain' || (parsed.family === 'cc' && !parsed.nc);
  const modifications = parsed.family === 'public_domain' || (parsed.family === 'cc' && !parsed.nd);
  const unique = [...new Set(reasons)];

  return {
    decision: accepted ? 'accepted' : 'rejected',
    reasons: unique,
    reason: accepted ? undefined : unique.map((r) => LICENCE_REJECTION_MESSAGES[r]).join(' '),
    licenceType:
      parsed.family === 'cc'
        ? ccLabel(parsed.nc, parsed.nd, parsed.sa)
        : label.replace(/\s+\d\.\d$/, ''),
    licenceVersion: parsed.version,
    commercialUseAllowed: accepted ? commercial : false,
    modificationsAllowed: accepted ? modifications : false,
    attributionRequired,
    attributionText: accepted
      ? buildAttribution({ author, sourceName: evidence.sourceName, licenceLabel: label })
      : undefined,
    shareAlike,
    otherObligations: shareAlike
      ? `Share-alike: adaptations must be released under ${label} or a compatible licence.`
      : undefined,
    policyVersion: LICENCE_POLICY_VERSION,
  };
}
