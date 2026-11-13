import { describe, expect, it } from 'vitest';
import {
  assessLicence,
  buildAttribution,
  cleanAuthor,
  LICENCE_POLICY_VERSION,
  parseLicenceName,
  parseLicenceUrl,
} from '@smb/shared';
import { evidence } from './helpers.js';

describe('parseLicenceName', () => {
  it.each([
    ['CC BY-SA 4.0', { nc: false, nd: false, sa: true, version: '4.0', label: 'CC BY-SA 4.0' }],
    ['CC-BY-3.0-de', { nc: false, nd: false, sa: false, version: '3.0', label: 'CC BY 3.0' }],
    ['CC BY 2.0', { nc: false, nd: false, sa: false, version: '2.0', label: 'CC BY 2.0' }],
    [
      'CC BY-NC-ND 2.0',
      { nc: true, nd: true, sa: false, version: '2.0', label: 'CC BY-NC-ND 2.0' },
    ],
    [
      'CC BY-NC-SA 4.0',
      { nc: true, nd: false, sa: true, version: '4.0', label: 'CC BY-NC-SA 4.0' },
    ],
  ])('%s', (name, want) => {
    expect(parseLicenceName(name)).toMatchObject({ family: 'cc', ...want });
  });

  it('knows public domain forms', () => {
    for (const n of ['CC0', 'cc-zero', 'Public domain', 'PD-old-70', 'PDM 1.0']) {
      expect(parseLicenceName(n).family).toBe('public_domain');
    }
  });
  it('recognises GFDL and refuses to guess the rest', () => {
    expect(parseLicenceName('GFDL 1.2').family).toBe('gfdl');
    expect(parseLicenceName('All rights reserved').family).toBe('unknown');
    expect(parseLicenceName('').family).toBe('unknown');
    expect(parseLicenceName(undefined).family).toBe('unknown');
  });
});

describe('parseLicenceUrl', () => {
  it('reads Creative Commons links', () => {
    expect(parseLicenceUrl('https://creativecommons.org/licenses/by-sa/4.0/')).toMatchObject({
      family: 'cc',
      sa: true,
      version: '4.0',
    });
    expect(parseLicenceUrl('https://creativecommons.org/licenses/by-nc-nd/2.0')).toMatchObject({
      nc: true,
      nd: true,
    });
    expect(parseLicenceUrl('https://creativecommons.org/publicdomain/zero/1.0/').family).toBe(
      'public_domain',
    );
    expect(parseLicenceUrl('https://example.com/licence').family).toBe('unknown');
  });
});

describe('assessLicence', () => {
  it('accepts CC BY-SA with a credit, and records the share-alike duty', () => {
    const a = assessLicence(evidence());
    expect(a).toMatchObject({
      decision: 'accepted',
      licenceType: 'CC BY-SA',
      licenceVersion: '4.0',
      commercialUseAllowed: true,
      modificationsAllowed: true,
      attributionRequired: true,
      shareAlike: true,
      attributionText: 'Photo: Jane Doe / Wikimedia Commons, CC BY-SA 4.0',
      policyVersion: LICENCE_POLICY_VERSION,
    });
    expect(a.otherObligations).toMatch(/CC BY-SA 4.0/);
  });

  it('accepts CC BY and public domain', () => {
    expect(
      assessLicence(
        evidence({
          licenceShortName: 'CC BY 2.0',
          licenceUrl: 'https://creativecommons.org/licenses/by/2.0/',
        }),
      ).decision,
    ).toBe('accepted');
    const pd = assessLicence(
      evidence({ licenceShortName: 'CC0', licenceUrl: undefined, author: undefined }),
    );
    expect(pd).toMatchObject({
      decision: 'accepted',
      attributionRequired: false,
      shareAlike: false,
    });
    expect(pd.attributionText).toBe('Photo: Wikimedia Commons, CC0 1.0');
  });

  it('rejects BY-SA only when share-alike is switched off', () => {
    const a = assessLicence(evidence(), { allowShareAlike: false });
    expect(a.reasons).toEqual(['share_alike_not_allowed']);
  });

  const cc = (kind: string, v = '4.0') => `https://creativecommons.org/licenses/${kind}/${v}/`;
  it.each([
    [
      'non-commercial',
      { licenceShortName: 'CC BY-NC 4.0', licenceUrl: cc('by-nc') },
      'non_commercial',
    ],
    [
      'no derivatives',
      { licenceShortName: 'CC BY-ND 4.0', licenceUrl: cc('by-nd') },
      'no_derivatives',
    ],
    [
      'unknown licence',
      { licenceShortName: 'All rights reserved', licenceUrl: undefined },
      'unknown_licence',
    ],
    ['missing licence', { licenceShortName: undefined, licenceUrl: undefined }, 'unknown_licence'],
    ['gfdl', { licenceShortName: 'GFDL 1.2', licenceUrl: undefined }, 'gfdl_only'],
    ['no author', { author: undefined }, 'no_author'],
    ['placeholder author', { author: 'Unknown author' }, 'no_author'],
    ['non-free', { nonFree: true }, 'non_free'],
    ['personality rights', { restrictions: ['personality'] }, 'personality_rights'],
    ['other restriction', { restrictions: ['trademarked'] }, 'restricted_use'],
    ['name and link disagree', { licenceShortName: 'CC BY 4.0' }, 'licence_mismatch'],
  ] as const)('rejects: %s', (_name, over, code) => {
    const a = assessLicence(evidence(over));
    expect(a.decision).toBe('rejected');
    expect(a.reasons).toContain(code);
    expect(a.reason).toBeTruthy();
    expect(a.commercialUseAllowed).toBe(false);
    expect(a.attributionText).toBeUndefined();
  });

  it('rejects a CC licence with no version anywhere', () => {
    const a = assessLicence(evidence({ licenceShortName: 'CC BY-SA', licenceUrl: undefined }));
    expect(a.reasons).toContain('unknown_version');
  });

  it('takes the version from the licence link when the name has none', () => {
    const a = assessLicence(evidence({ licenceShortName: 'CC BY-SA' }));
    expect(a.decision).toBe('accepted');
    expect(a.licenceVersion).toBe('4.0');
  });

  it('uses the licence link when the name is unrecognised', () => {
    const a = assessLicence(evidence({ licenceShortName: 'See page' }));
    expect(a.decision).toBe('accepted');
  });

  it('reports every reason, not just the first', () => {
    const a = assessLicence(
      evidence({ licenceShortName: 'CC BY-NC-ND 2.0', licenceUrl: undefined, author: undefined }),
    );
    expect(a.reasons).toEqual(
      expect.arrayContaining(['non_commercial', 'no_derivatives', 'no_author']),
    );
  });

  it('falls back to the copyright holder as the credit', () => {
    const a = assessLicence(evidence({ author: undefined, copyrightHolder: 'FIDE' }));
    expect(a.decision).toBe('accepted');
    expect(a.attributionText).toContain('FIDE');
  });

  it('honours the provider flag on public-domain files', () => {
    const a = assessLicence(
      evidence({
        licenceShortName: 'Public domain',
        licenceUrl: undefined,
        author: undefined,
        providerRequiresAttribution: true,
      }),
    );
    expect(a.reasons).toEqual(['no_author']);
  });
});

describe('attribution helpers', () => {
  it('builds a fixed-format credit', () => {
    expect(
      buildAttribution({ author: 'A', sourceName: 'Wikimedia Commons', licenceLabel: 'CC BY 4.0' }),
    ).toBe('Photo: A / Wikimedia Commons, CC BY 4.0');
  });
  it('cleans author names', () => {
    expect(cleanAuthor('  Jane   Doe ')).toBe('Jane Doe');
    expect(cleanAuthor('Unknown')).toBeUndefined();
    expect(cleanAuthor('')).toBeUndefined();
    expect(cleanAuthor(undefined)).toBeUndefined();
  });
});
