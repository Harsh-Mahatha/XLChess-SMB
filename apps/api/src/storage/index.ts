export * from './content.js';
export * from './object-store.js';

export const BUCKETS = {
  originals: 'originals',
  evidence: 'evidence',
  derived: 'derived',
  renders: 'renders',
  generated: 'generated',
} as const;
