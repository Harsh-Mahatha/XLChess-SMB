import { createHash } from 'node:crypto';

/** A ComfyUI API-format workflow: node id -> node. */
export type Workflow = Record<
  string,
  { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
>;

/**
 * The only node types the image stage may run (module 1.9). Every one of them either loads a model, encodes
 * the text prompt, starts from an empty random latent or saves the output. There is deliberately no node that
 * loads an image (LoadImage, ...) and none that encodes one into a latent (VAEEncode, ...), so a real
 * photograph cannot be sent through the generator: output is built from text and noise alone.
 */
export const TEXT_ONLY_NODE_TYPES: readonly string[] = [
  'UNETLoader',
  'CLIPLoader',
  'VAELoader',
  'CLIPTextEncode',
  'ConditioningZeroOut',
  'ModelSamplingAuraFlow',
  'EmptySD3LatentImage',
  'KSampler',
  'VAEDecode',
  'SaveImage',
];

export class WorkflowNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowNotAllowedError';
  }
}

/**
 * Refuses any workflow that could take an existing picture as input: a node type outside the allowlist, a
 * sampler that does not start from the empty latent, or a denoise strength below 1 (which would keep part of
 * its input). Throws `WorkflowNotAllowedError`.
 */
export function assertTextOnlyWorkflow(wf: Workflow): void {
  for (const [id, node] of Object.entries(wf)) {
    if (!TEXT_ONLY_NODE_TYPES.includes(node.class_type)) {
      throw new WorkflowNotAllowedError(
        `node ${id} is a ${node.class_type}; only text-to-image nodes are allowed, so a photograph can never be an input`,
      );
    }
  }
  const samplers = Object.entries(wf).filter(([, n]) => n.class_type === 'KSampler');
  if (samplers.length === 0) throw new WorkflowNotAllowedError('the workflow has no sampler');
  for (const [id, sampler] of samplers) {
    const source = sampler.inputs.latent_image;
    const sourceId = Array.isArray(source) ? String(source[0]) : undefined;
    if (!sourceId || wf[sourceId]?.class_type !== 'EmptySD3LatentImage') {
      throw new WorkflowNotAllowedError(`sampler ${id} must start from an empty latent image`);
    }
    if (sampler.inputs.denoise !== undefined && sampler.inputs.denoise !== 1) {
      throw new WorkflowNotAllowedError(`sampler ${id} must use full denoise (1)`);
    }
  }
}

/** A stable fingerprint of a workflow, stored with every generated asset. */
export function workflowFingerprint(wf: Workflow): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canon(wf)))
    .digest('hex');
}

export interface ImageParams {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  /** Output files are named `<prefix>_00001_.png`. */
  filenamePrefix: string;
}

function nodeByTitle(wf: Workflow, title: string): Workflow[string] {
  const found = Object.values(wf).find((n) => n._meta?.title === title);
  if (!found) throw new Error(`workflow has no node titled "${title}"`);
  return found;
}

/**
 * Fills the repo's versioned workflow template (`workflows/z-image-turbo.json`) with one job's settings.
 * Nodes are found by title, so the template can be re-exported from ComfyUI without renumbering.
 * Returns a copy; the template is never modified.
 */
export function buildWorkflow(template: Workflow, params: ImageParams): Workflow {
  if (!params.prompt.trim()) throw new Error('image prompt is empty');
  if (!Number.isInteger(params.width) || !Number.isInteger(params.height)) {
    throw new Error('image width and height must be whole numbers');
  }
  if (params.width % 16 !== 0 || params.height % 16 !== 0) {
    throw new Error('image width and height must be multiples of 16');
  }
  if (params.width < 256 || params.height < 256 || params.width > 2048 || params.height > 2048) {
    throw new Error('image size must be between 256 and 2048 pixels');
  }
  assertTextOnlyWorkflow(template);
  const wf = structuredClone(template);
  nodeByTitle(wf, 'positive_prompt').inputs.text = params.prompt;
  nodeByTitle(wf, 'sampler').inputs.seed = params.seed;
  const latent = nodeByTitle(wf, 'latent');
  latent.inputs.width = params.width;
  latent.inputs.height = params.height;
  latent.inputs.batch_size = 1;
  nodeByTitle(wf, 'save').inputs.filename_prefix = params.filenamePrefix;
  return wf;
}

/** The model files a workflow expects; the self-test checks they exist before starting ComfyUI. */
export function requiredModelFiles(wf: Workflow): { folder: string; file: string }[] {
  const out: { folder: string; file: string }[] = [];
  for (const node of Object.values(wf)) {
    const i = node.inputs;
    if (node.class_type === 'UNETLoader')
      out.push({ folder: 'diffusion_models', file: String(i.unet_name) });
    if (node.class_type === 'CLIPLoader')
      out.push({ folder: 'text_encoders', file: String(i.clip_name) });
    if (node.class_type === 'VAELoader') out.push({ folder: 'vae', file: String(i.vae_name) });
  }
  return out;
}
