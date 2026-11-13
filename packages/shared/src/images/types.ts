import { z } from 'zod';

/**
 * Contracts for image discovery and licence checks (module 1.8). Provider formats stay inside the
 * adapters; the rest of SMB works with these types.
 */

export const IMAGE_ROLES = ['player', 'event', 'venue', 'generic'] as const;
export const ImageRole = z.enum(IMAGE_ROLES);
export type ImageRole = z.infer<typeof ImageRole>;

/** What a photo should show. A person is found by identity (FIDE id), never by a name search alone. */
export const ImageSubject = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('player'),
      name: z.string().min(1),
      fideId: z.string().regex(/^\d+$/).optional(),
    })
    .strict(),
  z.object({ role: z.literal('event'), name: z.string().min(1) }).strict(),
  z
    .object({ role: z.literal('venue'), name: z.string().min(1), location: z.string().optional() })
    .strict(),
  z.object({ role: z.literal('generic'), keywords: z.string().min(1) }).strict(),
]);
export type ImageSubject = z.infer<typeof ImageSubject>;

/** The licence facts a provider gave for one photo, exactly as published, before any decision. */
export const LicenceEvidence = z
  .object({
    sourceId: z.string().regex(/^I\d+$/),
    sourceName: z.string().min(1),
    originalUrl: z.string().url(),
    sourcePageUrl: z.string().url().optional(),
    licenceShortName: z.string().optional(),
    licenceUrl: z.string().url().optional(),
    usageTerms: z.string().optional(),
    author: z.string().optional(),
    copyrightHolder: z.string().optional(),
    /** The provider's own "attribution required" flag, when it has one. */
    providerRequiresAttribution: z.boolean().optional(),
    /** Provider restriction tags such as "personality" or "trademarked". */
    restrictions: z.array(z.string()),
    /** Non-free / fair-use file. */
    nonFree: z.boolean(),
    /** The provider's raw licence metadata, kept as the licence evidence. */
    raw: z.unknown(),
  })
  .strict();
export type LicenceEvidence = z.infer<typeof LicenceEvidence>;

/** How well the photo is tied to the subject. Keyword search is never enough to name a person. */
export const MATCH_KINDS = ['wikidata_image', 'category', 'search'] as const;
export const MatchKind = z.enum(MATCH_KINDS);
export type MatchKind = z.infer<typeof MatchKind>;

export const ImageCandidate = z
  .object({
    sourceId: z.string().regex(/^I\d+$/),
    externalId: z.string().min(1),
    title: z.string().min(1),
    pageUrl: z.string().url(),
    /** The original file, not a thumbnail. */
    imageUrl: z.string().url(),
    mime: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative().optional(),
    takenAt: z.string().optional(),
    match: MatchKind,
    subject: ImageSubject,
    evidence: LicenceEvidence,
  })
  .strict();
export type ImageCandidate = z.infer<typeof ImageCandidate>;

export const ImageQuery = z
  .object({
    subject: ImageSubject,
    /** Candidates to return at most. */
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export type ImageQuery = z.input<typeof ImageQuery>;
