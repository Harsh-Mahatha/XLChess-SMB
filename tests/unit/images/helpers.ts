import type { ImageCandidate, LicenceEvidence } from '@smb/shared';

export function evidence(over: Partial<LicenceEvidence> = {}): LicenceEvidence {
  return {
    sourceId: 'I1',
    sourceName: 'Wikimedia Commons',
    originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Gukesh.jpg',
    sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Gukesh.jpg',
    licenceShortName: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
    author: 'Jane Doe',
    restrictions: [],
    nonFree: false,
    raw: {},
    ...over,
  };
}

export function candidate(over: Partial<ImageCandidate> = {}): ImageCandidate {
  return {
    sourceId: 'I1',
    externalId: 'File:Gukesh.jpg',
    title: 'Gukesh.jpg',
    pageUrl: 'https://commons.wikimedia.org/wiki/File:Gukesh.jpg',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Gukesh.jpg',
    mime: 'image/jpeg',
    width: 3000,
    height: 2000,
    match: 'wikidata_image',
    subject: { role: 'player', name: 'Gukesh D', fideId: '46616543' },
    evidence: evidence(),
    ...over,
  };
}
