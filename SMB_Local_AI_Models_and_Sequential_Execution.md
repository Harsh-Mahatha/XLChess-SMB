# SMB Local AI Models & Sequential Execution Architecture

**Project:** SMB (Social Media Bot)\
**Document purpose:** Record the selected local AI models and the
intended execution strategy on the Home Worker PC.\
**Status:** Model selection proposal; hardware compatibility and quality
still need to be benchmarked on the actual machine.

------------------------------------------------------------------------

## 1. Objective

SMB needs local AI capabilities for creating social-media content around
chess, news, tournaments, events, and related topics.

The architecture will use two specialist models hosted on the Home
Worker PC:

1.  A **Large Language Model (LLM)** for text, reasoning, structured
    content, and prompt generation.
2.  An **image-generation model** for producing visual assets such as
    backgrounds, illustrations, and creative image candidates.

Both models will use the same computer and GPU. To stay within the
available hardware resources, SMB will execute them **sequentially**,
not keep both models loaded in GPU memory at the same time.

The priority is to minimise recurring operating costs while keeping
output quality suitable for production use.

## 2. Home Worker PC: Assumed Hardware

The current hardware target is:

  Component          Planning assumption
  ------------------ ------------------------------------------------
  Operating system   Windows 11
  GPU                NVIDIA RTX 4070 / RTX 4070 Ti
  GPU memory         12 GB VRAM
  System memory      64 GB or more
  Role               Local AI inference and image-generation worker

The exact GPU variant should be confirmed before final performance
expectations are set. This document assumes a 12 GB VRAM limit.

System RAM is useful for the operating system, application processes,
model loading, and CPU offloading where supported. It does **not**
replace GPU VRAM for workloads that require GPU memory.

## 3. Selected Models

### 3.1 LLM: Qwen3.5 9B

**Proposed role:** Primary language and content-generation model.

**Runtime:** Ollama.

**Model:** Qwen3.5 9B.

The LLM will handle text-oriented work throughout the SMB content
workflow.

#### Expected responsibilities

-   Summarise verified chess news and event information.
-   Draft social-media captions and post descriptions.
-   Generate event announcements from supplied event data.
-   Create headline and short-copy variations.
-   Suggest relevant hashtags and content categories.
-   Turn approved content into image-generation prompts.
-   Classify content and select an appropriate post format.
-   Produce structured JSON for the SMB backend.
-   Review generated copy for clarity, tone, completeness, and
    consistency.

#### Why this model is the initial choice

Qwen3.5 9B is the proposed balance between capability and local resource
requirements. It is intended to be capable enough for SMB's
summarisation, writing, prompt-generation, and structured-output tasks
without starting with a much larger model.

This is a selection to benchmark, not a claim that it has already been
proven best for every SMB task. Its factual accuracy, JSON reliability,
speed, and memory usage must be evaluated using representative SMB
inputs.

#### Important operating principles

-   Use verified source data for dates, venues, player names, results,
    rankings, and other factual details.
-   The model may rewrite and summarise supplied facts, but must not
    invent missing facts.
-   Prefer schema-constrained structured output wherever the backend
    expects predictable fields.
-   Keep the context length appropriate to the task; unnecessarily large
    contexts increase memory use.
-   Use lower-variance generation settings for factual summaries and
    structured content, and more creative settings for brainstorming and
    stylistic variations.

### 3.2 Image generation: Z-Image-Turbo

**Proposed role:** Primary image-generation model.

**Runtime:** ComfyUI.

**Model:** Z-Image-Turbo.

The image model will generate visual material for SMB posts. It is not
responsible for producing the final branded poster or accurately
rendering all poster text.

#### Expected responsibilities

-   Generate chess-themed backgrounds and illustrations.
-   Create visual concepts for tournament and event announcements.
-   Generate editorial-style visuals for chess news.
-   Produce multiple visual directions or candidates for a post.
-   Create supporting imagery that can be combined with approved text
    and real assets.

#### Why this model is the initial choice

SMB primarily needs social-media visuals for chess, news, events, and
educational content. A fast image-generation workflow with useful visual
quality is more important initially than maximising photorealism.

Z-Image-Turbo is the proposed starting point for this role. Its actual
generation speed, output quality, VRAM use, and compatibility with the
chosen ComfyUI workflow must be tested on the Home Worker PC.

#### Important operating principles

-   Generate backgrounds, illustrations, and visual elements rather than
    relying on the image model to render exact headlines, dates, scores,
    or logos.
-   Do not trust generated text for factual or branded content.
-   Preserve supplied licensed photographs and other approved real-world
    assets.
-   Do not let the image model alter a real person's identity or
    fabricate a real event photograph.
-   Use deterministic composition for the final post.

## 4. Why the Models Must Execute Sequentially

Both models use the same physical GPU and therefore draw from the same
12 GB VRAM pool.

When a model is loaded for inference, it occupies GPU memory. If the LLM
and image model are both loaded at once, their memory requirements can
overlap. They also compete for GPU compute resources.

With a 12 GB GPU, keeping both models resident simultaneously creates
avoidable memory pressure and increases the risk of:

-   CUDA out-of-memory errors.
-   Model loading failures.
-   Slower inference and image generation.
-   Unpredictable latency.
-   Reduced room for image dimensions, batch sizes, or context length.

The design should therefore avoid depending on simultaneous GPU
residency.

**Key distinction:** Both models can be installed and available on the
same PC. Sequential execution means only the model needed for the
current stage should be actively loaded into GPU memory. The other model
should be unloaded or allowed to release its GPU allocation before the
next stage begins.

## 5. Proposed Sequential Execution Flow

The Home Worker PC will act as the local AI worker for SMB. The SMB
backend will coordinate a content job and request each stage in order.

### Stage 0 --- Receive and validate the job

The worker receives a job containing the approved source material and
task requirements.

The job should include, as applicable:

-   Content type and target platform.
-   Verified facts and source references.
-   Approved names, dates, venues, scores, and event details.
-   Brand and layout requirements.
-   Required output format and dimensions.
-   Any licensed photographs or supplied reference assets.

The worker should validate required fields before invoking either model.

### Stage 1 --- LLM execution

**Active model:** Qwen3.5 9B.

The worker sends the task and verified source data to the LLM.

The LLM returns the required text content and structured visual brief,
for example:

-   Caption and headline.
-   Summary and supporting copy.
-   Hashtag suggestions.
-   Content classification.
-   Image-generation prompt and negative constraints.
-   Structured data needed by the composition stage.

The backend validates the response against the expected schema. Invalid
or incomplete output should be rejected or sent through a controlled
retry path.

### Stage 2 --- Release LLM GPU memory

After the LLM stage completes:

1.  Persist its validated output with the job.
2.  End the LLM inference request.
3.  Unload the LLM from GPU memory, or otherwise ensure its GPU
    allocation is released.
4.  Confirm that sufficient GPU memory is available before starting
    image generation.

Do not assume that finishing a request automatically unloads the model.
Model-server residency and keep-alive behaviour must be configured and
verified as part of implementation.

### Stage 3 --- Image-generation execution

**Active model:** Z-Image-Turbo.

The worker passes the approved visual brief and generation settings to
ComfyUI.

The image model generates one or more visual candidates. A practical
initial target is a small number of candidates (for example, three) so
that users can choose a direction without creating unnecessary GPU load.

The worker records the generated files and their job metadata.

### Stage 4 --- Release image-model GPU memory

After image generation:

1.  Save the candidate images and generation metadata.
2.  Release or unload the image model from GPU memory when the job no
    longer needs it.
3.  Return the worker to an idle state or prepare it for the next job.

The system should not reload the LLM merely to complete image generation
or composition.

### Stage 5 --- Deterministic final composition

**Primary tools:** Sharp and SVG (or an equivalent deterministic
rendering layer).

This stage combines generated visual assets with trusted content.

The composition layer is responsible for:

-   Exact headlines and body text.
-   Dates, times, venues, scores, and other factual fields.
-   XLChess/SMB logos and brand assets.
-   Fonts, colours, spacing, alignment, and layout.
-   Cropping, resizing, and platform-specific dimensions.
-   Placement of supplied licensed photographs.

This keeps important text and brand elements accurate and reproducible.
The final poster should not depend on an image model correctly spelling
or positioning text.

### Stage 6 --- Review and approval

The completed candidates are returned to the SMB backend for preview and
human review.

The workflow should support:

-   Selecting a candidate.
-   Rejecting all candidates and requesting another generation.
-   Editing approved text or layout fields.
-   Approving the final asset.
-   Retaining job inputs and output metadata for traceability.

A model-generated asset should not be treated as approved or published
automatically unless a separate, explicit product rule authorises that
behaviour.

## 6. Execution Sequence Diagram

``` mermaid
flowchart TD
    A[SMB backend creates content job] --> B[Home Worker receives and validates job]
    B --> C[Load Qwen3.5 9B]
    C --> D[Generate copy, structured data and visual brief]
    D --> E[Validate and persist LLM output]
    E --> F[Unload LLM and release GPU memory]
    F --> G[Load Z-Image-Turbo in ComfyUI]
    G --> H[Generate visual candidates]
    H --> I[Save candidates and metadata]
    I --> J[Unload image model and release GPU memory]
    J --> K[Sharp + SVG deterministic composition]
    K --> L[Return previews to SMB backend]
    L --> M[Human review and approval]
```

## 7. Resource-Management Rules

The worker orchestrator should enforce these rules:

1.  **One GPU-heavy model at a time.** Do not start image generation
    while the LLM is still resident in GPU memory, or vice versa, unless
    later hardware testing explicitly proves simultaneous residency is
    safe.
2.  **Explicit model lifecycle.** Track whether each model is unloaded,
    loading, ready, running, or unloading.
3.  **Verify memory release.** Do not rely only on a completed API
    response as proof that VRAM has been released.
4.  **Serialize GPU jobs.** Use a queue or lock so two incoming jobs
    cannot independently load different GPU-heavy models at the same
    time.
5.  **Persist intermediate results.** Save validated LLM output before
    unloading it, so a later image-generation failure does not require
    repeating the text stage.
6.  **Handle failures by stage.** A failed image-generation stage should
    be retryable without unnecessarily rerunning the LLM.
7.  **Apply bounded retries.** Prevent repeated failures from creating
    an endless queue or repeated GPU loading.
8.  **Record resource and timing metrics.** Capture model load time,
    inference time, generation time, peak VRAM usage, and failures.
9.  **Keep services private.** Local model APIs should not be exposed
    directly to the public internet. The SMB-to-worker connection needs
    an authenticated, secure design.
10. **Account for worker availability.** The Home Worker PC must be
    powered on, connected, and reachable for local inference jobs. The
    backend should handle an unavailable worker gracefully.

## 8. Suggested Initial Runtime Configuration

These are starting design choices, not final performance guarantees.

  -----------------------------------------------------------------------
  Area                                Initial direction
  ----------------------------------- -----------------------------------
  LLM serving                         Ollama

  LLM model                           Qwen3.5 9B

  Image serving                       ComfyUI

  Image model                         Z-Image-Turbo

  LLM context                         Start around 16K; increase only
                                      when tasks require it

  LLM factual-task creativity         Low temperature

  LLM creative-task creativity        Higher temperature, tested against
                                      output quality

  Image candidate count               Start with approximately 3
                                      candidates per job

  GPU execution                       Sequential, with explicit
                                      unload/release between models

  Final composition                   Sharp + SVG

  Job coordination                    Node.js worker/orchestrator
  -----------------------------------------------------------------------

Exact quantisation, model variants, ComfyUI workflows, image dimensions,
sampling settings, and unload behaviour remain implementation and
benchmarking decisions. They should be selected only after validating
the exact model files and workflow against the actual 12 GB GPU.

## 9. Benchmark and Acceptance Plan

Before treating the model choices as final, benchmark them on
representative SMB jobs.

### Qwen3.5 9B benchmark

Test at least:

-   Chess-news summarisation from supplied source material.
-   Event announcement generation from structured event data.
-   Caption and headline variations.
-   Image-prompt generation for different post types.
-   Structured JSON generation against the backend schema.
-   Refusal to invent missing dates, scores, rankings, or other facts.

Measure:

-   Factual correctness.
-   Completeness and writing quality.
-   JSON/schema validity.
-   Response latency.
-   Model load time.
-   Peak VRAM and system RAM usage.

### Z-Image-Turbo benchmark

Test at least:

-   Chess tournament announcement backgrounds.
-   Editorial visuals for chess news.
-   Educational chess-post illustrations.
-   Visual variations from the same brief.
-   Output suitability for deterministic text and logo overlays.

Measure:

-   Visual quality and relevance.
-   Consistency with the supplied brief.
-   Generation time per candidate.
-   Peak VRAM usage.
-   Failure rate and repeatability.
-   Compatibility with the intended output dimensions.

### End-to-end benchmark

Run complete jobs through the sequential flow and verify:

-   The LLM output is saved before its model is unloaded.
-   The LLM's GPU allocation is released before image generation starts.
-   The image model can load and generate successfully afterward.
-   Image-model memory is released after generation.
-   Final composition uses the exact approved text and brand assets.
-   Failures can be retried from the failed stage.
-   Multiple queued jobs do not cause competing model loads.

The model selection should be revisited if the 9B LLM or image workflow
proves too slow or unreliable. A smaller LLM variant can be benchmarked
as a fallback if needed.

## 10. Scope Boundaries and Non-Goals

This document records the model choices and execution architecture. It
does not prescribe installation commands or perform setup.

The following are deliberately outside the scope of this selection
document:

-   Installing Ollama, ComfyUI, or model files.
-   Finalising Windows service configuration.
-   Choosing exact quantisation or sampling parameters.
-   Implementing the Node.js worker.
-   Designing the secure backend-to-worker transport in detail.
-   Selecting final image templates and brand layouts.
-   Defining the complete human-approval UI.

These can be handled in their respective implementation documents.

## 11. Final Decision Summary

  -----------------------------------------------------------------------
  Decision                            Selected direction
  ----------------------------------- -----------------------------------
  Local text model                    Qwen3.5 9B

  Local image model                   Z-Image-Turbo

  LLM runtime                         Ollama

  Image runtime                       ComfyUI

  Execution strategy                  Sequential model execution

  GPU planning limit                  12 GB VRAM

  Final image composition             Sharp + SVG

  Primary cost strategy               Local inference on the Home Worker
                                      PC

  Validation status                   Proposed selections; benchmark
                                      before production sign-off
  -----------------------------------------------------------------------

**Core architecture principle:** Qwen3.5 9B prepares and validates the
content brief. Its GPU allocation is released. Z-Image-Turbo then
generates visual candidates. Its GPU allocation is released. Finally,
deterministic composition combines the selected visuals with exact,
trusted text and brand assets.

This allows SMB to use two specialist local models on one 12 GB GPU
without making simultaneous model residency a requirement.
