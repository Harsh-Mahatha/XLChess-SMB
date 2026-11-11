/** A ComfyUI API-format workflow: node id -> node. */
export type Workflow = Record<
  string,
  { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
>;

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
