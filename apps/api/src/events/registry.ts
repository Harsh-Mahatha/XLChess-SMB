import type { EventDetector } from './types.js';

/** The detectors this process runs, in registration order. */
export class DetectorRegistry {
  private readonly detectors = new Map<string, EventDetector>();

  register(detector: EventDetector): this {
    if (this.detectors.has(detector.id)) {
      throw new Error(`Event detector "${detector.id}" is already registered`);
    }
    this.detectors.set(detector.id, detector);
    return this;
  }

  get(id: string): EventDetector | undefined {
    return this.detectors.get(id);
  }

  list(): EventDetector[] {
    return [...this.detectors.values()];
  }
}
