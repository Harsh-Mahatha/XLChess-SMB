# XLChess Social Media Bot (SMB) — Build PRD for Claude Code

**Document purpose:** The single source of truth Claude Code uses to plan and build the **first working output** of SMB.
**Status:** Greenfield. The repository exists and is empty apart from this document and reference material.
**Version:** 1.0 — 30 October 2026
**Location in repo:** `docs/PRD.md`

---

## 0. How Claude Code must use this document

### 0.1 Ground rules

1. **Plan before code.** Phase 0 (Section 12) produces a written plan. Do not write application code until the human approves it.
2. **Build one vertical slice.** One post type, one source path, one template, one channel (X), end to end. Never build all post types or channels at once.
3. **Hard constraints win every conflict:** human approval before publishing, factual accuracy, legal image use, security, duplicate prevention.
4. **Smallest reliable architecture.** Don't add a framework, service, queue, cache, or provider because it is popular. For each dependency, state its operational value and recurring cost.
5. **Verify, don't assume.** Before integrating any external service, check its current official docs: API access, terms, rate limits, pricing. Record what you checked and when in `docs/DECISIONS.md`.
6. **Never invent.** Not post-type names, not source capabilities, not credentials, not files that aren't in the repo. If information is missing, list it as an open question.
7. **Never claim an integration works** until it has been tested against real or recorded provider responses.
8. **Secrets** never go in source code, prompts, logs, fixtures, client bundles, or generated content.
9. **Stop at each phase boundary.** At the end of every phase, summarise what was built, how it was tested, and what's next, then wait for approval.

### 0.2 Meaning of terms in this document

- **MUST** — a requirement.
- **SHOULD** — a recommendation; deviate only with a recorded reason.
- **Example** — illustrative only, not a production schema.
- **Open decision** — must be raised with the human, not silently decided.

---

## 1. Product summary

**SMB is an automated content-production system for XLChess, not a social-media scheduler.**

It does the work of a small content team:
- researching chess topics from approved sources;
- choosing stories;
- verifying facts;
- writing three candidate posts;
- finding legally usable photos;
- rendering finished graphics;
- preparing everything for human approval;
- publishing approved posts.

**Operating target:** about **5 complete, review-ready posts per day**. The reviewer receives finished posts, not ideas or research tasks.

**Long-term quality target:** 10 consecutive days in which every original generated post is approved without modification, measured against a defined daily volume. This is a quality metric. It is **never** a reason to remove the approval gate.

### 1.1 Core principles

| # | Principle | Meaning |
|---|---|---|
| 1 | Automation first | SMB finds its own topics and does its own research. |
| 2 | Configuration-driven | Post types, sources, schedules, channels, and rules live in validated config, not code. |
| 3 | Evidence-based | Every factual claim links to stored source evidence. |
| 4 | Human approval | V1 never publishes an unapproved post. |
| 5 | Image integrity | Real photographs are never altered by generative AI. Only deterministic crop, resize, rotate, position, and composite are allowed. |
| 6 | Legal image use | Every external image has its own licence assessed and recorded. |
| 7 | Reusable pipeline | A new post type needs config and templates, not a new application. |
| 8 | Continuous improvement | Reviewer corrections are recorded and used to improve prompts and templates. |
| 9 | Reliability | Retries, deduplication, partial failures, and recovery are explicit. |
| 10 | Traceability | Every post traces to its research, claims, sources, images, licences, prompt/model versions, revisions, approval, and publication attempts. |
| 11 | Cost awareness | Optimise cost per **accepted** post and reviewer time, not just token price. |
| 12 | Security by design | External content is untrusted. Credentials and publishing rights are tightly controlled. |

---

## 2. Environment facts (confirmed)

| Item | Fact | Implication |
|---|---|---|
| Developer OS | **Windows** | All scripts, paths, and tooling must work on Windows. Use cross-platform npm scripts (no bash-only scripts). Add `.gitattributes` to normalise line endings. Docker Desktop is used for local services. |
| Production hosting | **AWS Lightsail** | Plan for a single Linux instance. Prefer Docker / Docker Compose for parity between Windows dev and Linux prod. Headless Chromium (Playwright) needs adequate RAM; state the minimum instance size. |
| Database | **PostgreSQL**. XLChess already runs PostgreSQL, but **SMB will most likely use its own separate database.** | SMB owns its schema and migrations. It must not depend on or write to XLChess tables. Local dev uses PostgreSQL in Docker. Whether production is a separate instance or a separate database on the existing server is an open decision. |
| Repository | Created; empty apart from `docs/` | No existing code, schema, or conventions to inherit. |
| AI model provider | **Not yet decided** (deliberately deferred) | Build behind a provider interface. Use a deterministic fixture/stub provider until the human selects a real one. Do not pick a provider. |
| Social channel for V1 | **X only** | The X developer account application is in progress. Build the X publisher with a **dry-run mode first**. |
| Reference artwork | **One reference photo** is available in `docs/reference/` | Use it as the visual reference and as a development test asset. Its licence status is unknown until recorded (see 8.4). |

---

## 3. Scope

### 3.1 The first output (what this PRD builds)

**Definition of the first output:** a human runs one command or clicks one button to trigger a World Championship (PT 1.1) posting opportunity. SMB then:

1. builds a source-linked research package;
2. verifies the critical facts in code;
3. selects a story angle;
4. generates **three** different candidate posts in a validated schema;
5. renders a **Player vs Player** graphic deterministically from real, licence-recorded photos;
6. presents the three candidates for review;
7. records an approval bound to an exact revision and asset set;
8. "publishes" to X in **dry-run mode**, recording the result. Real X publishing is switched on once credentials exist.

Everything is persisted, traceable, idempotent, and covered by tests.

### 3.2 Out of scope for the first output

- Publishing without human approval (never in V1).
- Post types other than PT 1.1.
- Facebook, Instagram, Discord (designed for, not built).
- A polished review UI. A minimal review mechanism is enough, **but approval state and audit must be real.**
- Choosing the AI provider.
- Fine-tuning, multi-agent systems, agent frameworks (e.g. LangGraph).
- Video, animation, paid ads, advanced analytics.
- Automatic game-completion detection and live tournament mode (designed for, built after the first output).

---

## 4. Post types and configuration

### 4.1 Hierarchy

The working hierarchy has **18 top-level post types** with subtypes. **The full list of names and IDs has not been supplied. Do not invent it.** Only PT `1.1` World Championship is defined. Design the config system so the other types can be added later as data.

### 4.2 Subtype configuration fields

Configs MUST be version-controlled typed files (JSON or TypeScript) validated with a schema (Zod or JSON Schema) at startup and on change.

| Field | Purpose |
|---|---|
| `id` | Stable identifier, e.g. `1.1` |
| `name` | Human-readable name |
| `enabled` | Whether the subtype is active |
| `sources` | Approved information-source IDs |
| `imageSources` | Approved image-source IDs |
| `channels` | Target channels (X, Facebook, Instagram, Discord) |
| `schedule` | Fixed time, frequency, or event trigger |
| `timezone` | Timezone for interpreting the schedule |
| `phases` | Optional lifecycle-specific behaviour |
| `contentRules` | Required facts, tone, structure, restrictions |
| `imageRules` | Image selection, rights, and composition requirements |
| `approvalRequired` | MUST be `true` in V1; reject config otherwise |
| `priority` | Priority relative to other types |
| `deduplication` | Rules preventing repeated content |
| `retryPolicy` | Failure and retry behaviour |
| `candidateCount` | MUST be `3` in V1 |

### 4.3 Reference config — PT 1.1 World Championship

| Property | Value |
|---|---|
| ID | `1.1` — World Championship |
| Data sources | `D1`–`D5` (Section 5) |
| Image sources | `I1`–`I4` (Section 8) |
| Channels (designed) | X, Facebook, Instagram, Discord |
| Channels (enabled now) | X only |
| Normal schedule | Friday 09:00 UTC |
| Tournament schedule | After each completed game |
| Candidates | 3 |
| Approval | Mandatory |

### 4.4 PT 1.1 lifecycle phases

| Phase | Behaviour |
|---|---|
| `PRE_TOURNAMENT` | Every Friday 09:00 UTC. Topics: participants, qualification, dates, venue, format, player form, preparation, history, official announcements. |
| `DURING_TOURNAMENT` | Suspend the Friday schedule. After each completed game: result, updated match score, key moments, context, next game. |
| `POST_TOURNAMENT` | Resume Friday posting. Cover the outcome and implications, then move on to the next cycle (qualification, Candidates, next championship). |

**Phase detection** MUST NOT rely on dates alone. Keep a structured championship record:
- cycle identity;
- official scheduled and actual dates;
- completion status;
- current game number and status;
- players and official score;
- next game;
- next-cycle info;
- source references, retrieval timestamps, and verification status.

**FIDE is the authority** on event identity and lifecycle. If sources disagree or the state is uncertain, flag the event for human review. Never guess.

For the first output, phase detection logic and tests MUST exist. Live game-completion polling comes after the first output.

### 4.5 Game-completion events (design now, build later)

A completed-game event contains:
- championship ID;
- stable game ID and game number;
- both players;
- official result;
- updated match score;
- completion timestamp;
- source reference;
- verification status.

Rules:
- A game is complete **only** when a reliable source confirms the final result. A stopped clock or broken feed is not completion.
- Idempotency keys are built from stable IDs, e.g. `{championshipId}:{gameId}:result`. Enforce them with **database unique constraints**, not in-memory checks.
- If a result is corrected after content was generated or published, update the record and flag the affected content for review. Never silently rewrite approved content.

### 4.6 Avoiding repetitive posts

Store each post's topic, angle, and claim set. Compare new opportunities against recent posts. If nothing genuinely new exists, either choose a different evergreen angle or report "no worthwhile post". **Never invent news to fill a schedule.**

---

## 5. Chess information sources

### 5.1 Candidate registry

| ID | Source | Purpose | Reference |
|---|---|---|---|
| `D1` | FIDE | Official events, ratings, rankings, regulations, schedules | https://www.fide.com/ , https://ratings.fide.com/ |
| `D2` | Chess.com News | Stories, previews, analysis | https://www.chess.com/news |
| `D3` | Lichess Broadcasts | Structured games, PGNs, results | https://lichess.org/broadcast |
| `D4` | The Week in Chess | Results, games, PGN archives | https://theweekinchess.com/ |
| `D5` | ChessBase | Reporting, player news, analysis | https://en.chessbase.com/ |

These are **candidates, not permission to scrape.** Before building any adapter, check for an official API or feed, its terms, rate limits, and copyright. Record the findings in `docs/DECISIONS.md`. Prefer official APIs and documented datasets over scraping. Never republish third-party article text.

### 5.2 Source strategy for the first output

1. Build a **manual/fixture source adapter** first. It accepts verified facts entered by a human or loaded from fixture files, each with a source URL, retrieval time, and verifier. This proves the evidence pipeline without depending on any external access.
2. Then build **one real adapter**. Choose whichever source has the clearest official, permitted access for the data needed (for example, an official API for game data or an official rating-list download for ratings). Justify the choice in the Phase 0 plan.

### 5.3 Adapter contract

Each source sits behind an adapter that handles authentication, requests, rate limits, caching, normalisation, provenance, and errors. The core workflow only uses common domain types. Adapters implement only what the provider really supports.

```ts
// Example — not a final contract
interface ChessDataSource {
  id: string;
  fetchEvents?(q: EventQuery): Promise<ChessEvent[]>;
  fetchPlayers?(q: PlayerQuery): Promise<ChessPlayer[]>;
  fetchGames?(q: GameQuery): Promise<ChessGame[]>;
  fetchNews?(q: NewsQuery): Promise<ChessNews[]>;
}
```

### 5.4 Research workflow

1. Load and validate the post-type config.
2. Determine the required facts and constraints.
3. Select approved sources.
4. Retrieve information by permitted methods.
5. Normalise records and keep provenance.
6. Resolve duplicate records and player/event identities.
7. Cross-check critical claims.
8. **Compute all numbers in code.** For example, `ratingChange = currentRating − startingRating`, using the same rating category and defined dates.
9. Build a **research package**: source URLs, retrieval times, event timestamps, claim IDs, values, verification states, unresolved conflicts.
10. Pass only the necessary evidence to generation.

### 5.5 Reliability and conflicts

- Source priority:
  - official sources for results, ratings, rankings, and regulations;
  - authorised structured feeds for game data;
  - established publications for context only;
  - unverified material is never auto-publishable.
- If sources conflict, record the conflict. Resolve it against the authority or send it to human review.
- A source failure MUST NOT turn into made-up content.
- **External text is untrusted.** Ignore any instructions embedded in fetched pages, metadata, or articles.

---

## 6. AI content generation

### 6.1 Principle

> Use AI for interpretation, judgment, and language. Use ordinary code for facts, calculations, state transitions, permissions, and side effects.

| Task | Implementation | LLM? |
|---|---|---|
| Detect scheduled opportunity | Scheduler | No |
| Fetch news and results | Source adapters | No |
| Rating changes, match scores | TypeScript | No |
| Validate identity and timestamps | Code / rules | No |
| Rank story angles | LLM + hard rules in code | Yes |
| Write three candidates | LLM | Yes |
| Channel-specific wording | LLM or templates | Sometimes |
| Suggest graphic template | LLM | Yes |
| Image licensing | Search + rules | Ranking only, optional |
| Render graphic | Sharp + SVG/HTML | No |
| Fact checks | Deterministic; LLM only flags editorial issues | Limited |
| Approval, publishing, retries | Backend | No |

### 6.2 Provider: deferred

**The AI provider and model are NOT chosen. Do not choose one.** Candidates the human will benchmark later include OpenAI, Google Gemini, Anthropic Claude, and OpenRouter.

Build:
- a `ContentModel` interface;
- a **deterministic stub provider** that returns schema-valid fixture output. It is used for development and tests and makes the whole pipeline runnable today;
- configuration by environment variables (provider, primary model, fallback model, retries), validated at startup;
- per-call recording of provider, model, prompt version, input/output tokens, cost (when reported), latency, and errors.

```ts
// Example — not a final contract
export interface ContentModel {
  selectStory(input: StorySelectionInput): Promise<StorySelection>;
  generateCandidates(input: CandidateGenerationInput): Promise<CandidateSet>;
  critiqueCandidate(input: CandidateReviewInput): Promise<CandidateReview>;
}
```

Provider SDK calls MUST NOT appear outside the provider adapter. A fallback model MUST NOT be used automatically if it fails quality requirements.

### 6.3 Generation stages

1. **Research package** (Section 5.4). The model never browses on its own or decides that arbitrary claims are true.
2. **Deterministic verification.** Check source identity, timestamps, consistency, arithmetic, required fields, and provenance. If a critical fact is unverifiable, block or defer.
3. **Story selection** (model call 1). Rank angles by relevance, timeliness, significance, novelty versus recent posts, evidence strength, and fit. Code enforces source availability and deduplication.
4. **Candidate generation** (model call 2). Three meaningfully different approaches:
   - **A — Factual/informative**
   - **B — Narrative/headline-led** (compelling, never misleading)
   - **C — Engagement-oriented** (question, comparison, or prompt)

   Each candidate has: headline, caption, claim IDs used, visual template, image-selection instructions, channel variants, and required attribution/disclaimers.
5. **Validation.**
   - Deterministic: claim IDs exist, values match records, dates/scores are consistent, not a duplicate, platform limits met, attribution present, schema valid.
   - Optional critique call only for high-impact or failing cases. It flags; it is not a source of truth.
6. **Rendering and review** (Sections 8–9).

**Retries are capped** (default 2). Unresolved cases go to human review. No self-critique loops.

### 6.4 Structured output

Use provider structured output when a provider is chosen. **Always** validate in TypeScript with Zod. Reject unknown fields. Resolve every claim ID and source reference against stored records. Never trust model-provided URLs or IDs. Valid JSON is not proof of correctness.

```json
{
  "postType": "1.1",
  "angle": "Championship rating comparison",
  "candidates": [
    { "version": "A", "headline": "…", "caption": "…", "claims": ["claim-001"], "visualTemplate": "player-versus" }
  ]
}
```

The production schema MUST require exactly 3 candidates and include claim references, channel variants, visual requirements, and validation results.

### 6.5 Evaluation (prepare, don't run)

Create the folder structure and fixture format for a future evaluation set of 30–50 realistic opportunities:
- previews;
- results;
- rating changes;
- conflicting sources;
- insufficient evidence;
- already-covered topics.

Scoring rubric:
- factual accuracy (**pass/fail gate**);
- editorial quality;
- candidate diversity;
- instruction adherence;
- regeneration rate;
- cost per accepted post;
- latency.

Running the benchmark happens after the provider shortlist is decided.

### 6.6 Not in V1

No fine-tuning, no autonomous multi-agent system, no LLM-only fact checking, no AI-generated player photos, no model-controlled publishing, no unlimited retries, no reliance on free-tier capacity in production, no decisions based only on advertised token prices.

---

## 7. Cost tracking

- Record tokens and cost per model call, per candidate set, and per **accepted** post.
- Record per-post publishing cost. **X currently charges per post created, and posts containing links cost much more than plain posts.** Make "include link" a configurable per-channel rule that defaults to **no link on X**. Verify current rates in the official X docs.
- Support a monthly spend limit setting with a warning or stop when it is exceeded.
- Cache reusable research. Keep research packages concise.

---

## 8. Images, licensing, and rendering

### 8.1 Candidate image sources

| ID | Source | Use |
|---|---|---|
| `I1` | Wikimedia Commons | Real players, tournaments, venues (preferred for players) |
| `I2` | Flickr Creative Commons | Additional player/event photos, individually verified |
| `I3` | Unsplash | Generic chess backgrounds (fallback) |
| `I4` | Pexels | Generic chess imagery (fallback) |

Being downloadable is not permission. Check each provider's API, terms, and licence model before automating retrieval.

### 8.2 Licence record (per image)

- original URL and source page;
- creator/rights holder;
- licence type and version, and licence URL;
- whether commercial use is permitted;
- whether the planned modifications are permitted;
- attribution text;
- share-alike or other obligations;
- verification timestamp and verifier;
- durable licence evidence where appropriate.

Rules:
- Reject non-commercial licences for promotional use unless separate permission exists.
- Assess no-derivatives terms against cropping and compositing.
- If rights can't be established, the image is **not publishable**.

### 8.3 Image integrity

- **Allowed:** crop, resize, rotate, position, frame, composite with other elements.
- **Prohibited:** any generative change to a real photo (faces, expression, retouching, clothing, hair, recolouring, inpainting), or passing the finished poster through an image model.
- Store the original file, its SHA-256 hash, and every transformation parameter. Tests MUST prove that only permitted operations touch player photos.

### 8.4 First-output image path

- Build **manual asset intake** first: register a local image plus its licence record.
- The reference photo in `docs/reference/` may be used for development. If its licence is not documented, mark it `UNVERIFIED`. The publish gate MUST then block it for real publishing (dry-run is allowed).
- Automated search for `I1` (Wikimedia Commons) comes after the first output, once its API and terms are checked.

### 8.5 Templates

Build **Player vs Player** first, using the reference photo as the design reference:
- two real player photos;
- neutral grey background;
- names and national flags;
- classical ratings;
- a prominent "VS";
- a strong headline;
- championship context.

All ratings and decline figures are computed from comparable published FIDE classical data at generation time.

Later templates: Upcoming Tournament, Tournament Result, Player Ranking, Rating Movement, Chess Puzzle, Chess News, XLChess Product Update.

Templates define layout regions, typography, colours, image placement, and aspect ratios. They MUST handle varying text lengths and image sizes without breaking.

Rendering: HTML/CSS or SVG templates, **Sharp** for image operations, **Playwright** (headless Chromium) for HTML rendering where useful. Flags and fonts must be licensed assets stored in the repo or object storage.

---

## 9. Human review and approval

### 9.1 Review package

- the three candidates;
- rendered graphics;
- channel previews;
- intended channel and time;
- evidence and source links per claim;
- image source and licence;
- template;
- validation warnings;
- revision history.

### 9.2 Actions

| Action | Behaviour |
|---|---|
| Approve | Approves a **specific candidate revision + asset set** |
| Edit | Creates a new revision (text, layout, image) |
| Regenerate | New candidates using reviewer feedback |
| Reject | Rejects the opportunity, with a reason |
| Defer | Holds for later |
| Request research | Returns for more verification |

**Approval binding:**
- Approval is stored against a content hash of the exact revision and asset set.
- Any meaningful change after approval invalidates it.
- The publisher re-checks the hash before publishing.
- Enforced in the backend, not only in the UI.

### 9.3 First-output review mechanism

A **minimal** interface is acceptable: a CLI or a simple local web page that shows the three candidates with graphics and evidence and supports all six actions. Phase 0 proposes which, with reasons. The full review UI (React/Next.js) is a later phase and must reuse the same backend approval logic.

Reviewer identity MUST be recorded on every action. For the first output, a configured single reviewer is acceptable; roles come later.

### 9.4 Learning from corrections

Classify each edit: factual, style/tone, headline, image, layout, formatting, rejection reason, regeneration request.

Track:
- unedited-approval rate;
- correction types;
- rejection rate;
- regeneration rate;
- review time.

---

## 10. Publishing

### 10.1 Channels and what each requires (verify before building)

| Channel | Access model (as researched Oct 2026, re-verify) |
|---|---|
| **X** | Official X API, pay-per-use credits. Posting has a per-request fee; posts with links cost more. Requires an approved developer app with write permission. |
| **Facebook** | Pages API, publishing to a Facebook Page via `pages_manage_posts`. Requires a Meta developer app; production use generally needs Business Verification and App Review. |
| **Instagram** | Instagram Graph API content publishing. Requires an Instagram **Professional** (Business/Creator) account, Meta app review, images at a **publicly reachable URL**, and JPEG format. Daily per-account publishing cap. |
| **Discord** | Channel webhook or bot on XLChess's own server. Supports images and embeds. No platform review for own-server posting. |

### 10.2 Publisher contract

```ts
// Example — not a final contract
interface SocialPublisher {
  channel: string;
  validate(post: ApprovedPost): Promise<ValidationResult>;
  publish(post: ApprovedPost): Promise<PublishResult>;
  getStatus(id: string): Promise<PublicationStatus>;
}
```

### 10.3 Safeguards (checked in code before every publish)

- valid approval exists;
- the content hash matches the approved revision and assets;
- media exists;
- licences are verified and attribution is present;
- channel constraints are met;
- not already published (unique constraint);
- schedule is valid.

Persist the provider post ID and URL.

**A timeout is not a failure.** Check whether the first request succeeded before retrying.

A failure on one channel never regenerates content or republishes to another channel.

### 10.4 First-output publishing

- **Dry-run mode is the default.** It validates everything and records a simulated publication without calling X.
- Real X publishing is a config switch, used only once credentials exist and the human explicitly enables it.
- Upload media through the official media endpoint.

---

## 11. Architecture

### 11.1 Recommended stack (validate in Phase 0)

| Component | Recommendation |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Node.js current LTS |
| Package manager | pnpm (workspace) |
| Backend | Lightweight Node HTTP framework (e.g. Fastify or Express); choose and justify |
| Database | PostgreSQL, SMB's own database; SQL migrations via a typed tool (choose and justify) |
| Background work | **Database-backed jobs** (no Redis or broker at this volume) |
| Scheduling | In-process scheduler or cron reading schedules from config/DB; timezone-aware; missed-run recovery |
| Validation | Zod |
| Images | Sharp + SVG/HTML templates + Playwright |
| Storage | Local filesystem in dev behind a storage interface; S3-compatible later (Lightsail object storage or S3) |
| Logging | Structured JSON logs |
| Tests | Vitest (or equivalent), fixture-based; no live APIs in routine tests |
| Local services | Docker Compose (PostgreSQL) |
| Review UI (later) | React or Next.js, added as a separate workspace app |

**No microservices, Redis, message brokers, or workflow engines** unless measured need justifies them.

### 11.2 Logical modules

1. Admin & review interface
2. Orchestrator (workflow state only; no scraping, rendering, or publishing logic inside it)
3. Source adapters
4. Research & verification
5. AI content service (provider adapters)
6. Image search, licensing & rendering
7. Scheduler & workers
8. Database, asset storage, job records
9. Channel publishers
10. Monitoring & cost tracking

### 11.3 Repository layout

Claude Code proposes the final layout in Phase 0. The suggestion below is illustrative and should be scaled to the first output's size.

```text
xlchess-smb/
  docs/            PRD.md, DECISIONS.md, IMPLEMENTATION_PLAN.md, reference/
  config/          post-types/, sources/, channels/
  apps/
    server/        API + orchestrator + workers + CLI
    review/        (later) review UI
  packages/        (only if genuinely shared code emerges)
  src/ or modules: core, sources, research, generation, images, review, publishing, db, monitoring
  tests/           unit/, integration/, e2e/, fixtures/
  docker-compose.yml
```

---

## 12. Data model

Required logical entities (final names and columns proposed in Phase 0):

| Entity | Purpose |
|---|---|
| `post_types` / `post_configs` | Types and versioned configs |
| `data_sources` | Source registry |
| `source_records` | Retrieved data with provenance |
| `research_packages` | Verified evidence per opportunity |
| `claims` | Individual claims → supporting source records, verification state |
| `post_opportunities` | Scheduled, event, or manual work (common record for all triggers) |
| `generation_runs` | Model calls: provider, model, prompt version, tokens, cost, latency |
| `post_candidates` | Generated versions |
| `post_revisions` | Immutable revisions with content hash |
| `media_assets` | Originals and renders (hash, transforms) |
| `media_licenses` | Licence evidence |
| `review_actions` | Approvals, edits, rejections, deferrals, feedback, reviewer |
| `publications` | Per-channel attempts, status, provider ID/URL |
| `jobs` | Background tasks, attempts, errors |
| `processed_events` | Idempotency keys (unique) |
| `post_metrics` | Quality and performance measurements |

Relationships:
- An opportunity has one or more research packages and normally one generation cycle of 3 candidates.
- A candidate has many revisions.
- An approval references exactly one revision and asset set.
- An approved revision can have many channel publications.
- Every asset links to its source, licence, and transforms.
- Every claim links to source records.

Use stable IDs, timestamps, and version numbers. Propose a retention policy.

### 12.1 Opportunity states

`PENDING → RESEARCHING → VERIFIED → GENERATING → VALIDATING → RENDERING → AWAITING_REVIEW → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED`

Plus `NEEDS_RESEARCH`, `DEFERRED`, `REJECTED`, `FAILED`, `CANCELLED`.

- Transitions are defined in one central place and enforced; illegal transitions throw.
- A failed stage resumes without re-running stages that already succeeded.
- Per-channel publication status is tracked separately from opportunity state.

### 12.2 Triggers

| Trigger | Example | First output? |
|---|---|---|
| Manual | Admin requests a PT 1.1 post | **Yes** |
| Fixed schedule | Friday 09:00 UTC | **Yes** (with missed-run recovery and duplicate-run prevention) |
| Event | Game completed | Designed; built after the first output |

All triggers create the same `post_opportunities` record.

---

## 13. Development phases to the first output

Each phase ends with a demo, passing tests, a short summary, and a stop for human approval.

### Phase 0 — Plan (no application code)
- Read this PRD fully. Inspect the repo and local environment (Node, pnpm, Docker, Git availability on Windows).
- Check current official docs for: the chosen first real chess source, Wikimedia Commons API/terms, the X API (write access, media upload, current pricing), Sharp and Playwright on Windows and Linux.
- **Deliverables:**
  - `docs/IMPLEMENTATION_PLAN.md`: architecture, final repo layout, dependencies with value/cost, data model draft, state machine, phase milestones, test plan.
  - `docs/DECISIONS.md`: decisions, sources checked with dates, open questions.
  - A proposed `CLAUDE.md` with project conventions.
- **Exit:** human approves the plan.

### Phase 1 — Foundation
- pnpm workspace, strict TypeScript, lint/format, test runner, `.gitattributes`, `.gitignore`, `.env.example`.
- Env validation at startup (fails fast).
- Docker Compose PostgreSQL. Migration tooling. Structured logging.
- Config loader with Zod schema and the PT 1.1 config file (rejects `approvalRequired: false` and `candidateCount ≠ 3`).
- **Exit:** `pnpm test` passes on Windows; DB starts and migrates; invalid configs are rejected with clear errors.

### Phase 2 — Domain model & workflow core
- Migrations for the Section 12 entities needed by the first output.
- Central state machine with tests for legal and illegal transitions.
- DB-backed job runner with retries, attempt counts, and idempotency via unique constraints.
- Manual trigger command creating a PT 1.1 opportunity.
- **Exit:** a manual trigger creates an opportunity and moves it through stub stages; duplicate triggers are prevented; restarts resume correctly.

### Phase 3 — Research & verification
- Source registry. **Manual/fixture adapter** with full provenance.
- One real adapter (choice justified in Phase 0), tested with recorded fixtures.
- Normalisation, identity resolution, deterministic calculations (rating changes, scores), conflict recording, research package builder.
- Championship phase-detection logic with tests.
- **Exit:** a PT 1.1 research package with claim IDs, sources, timestamps, and computed facts is stored; unverifiable critical facts block progress.

### Phase 4 — Content generation (provider-agnostic)
- `ContentModel` interface, **stub provider**, env-driven provider config, prompt files with versions.
- Story selection and three-candidate generation. Zod output schema (exactly 3).
- Claim-reference resolution and deterministic validators. Deduplication against recent posts.
- Generation-run recording (tokens, cost, latency).
- Evaluation-set folder and fixture format (no benchmark run).
- **Exit:** three schema-valid candidates referencing real claim IDs are produced from the research package; tampered or unknown claim IDs are rejected.

### Phase 5 — Images & rendering
- Storage interface (local implementation). Manual asset intake with licence record and SHA-256.
- Licence rules (commercial use, derivatives, attribution, `UNVERIFIED` blocks real publishing).
- **Player vs Player** template (HTML/SVG + Sharp/Playwright), built from the reference photo's design.
- Transform logging. Image-integrity tests.
- **Exit:** a finished graphic is rendered for each candidate with full asset and licence traceability.

### Phase 6 — Minimal review
- The review mechanism chosen in Phase 0 (CLI or simple local page).
- All six actions. Revisions with content hashes. Approval bound to revision + assets. Edit invalidates approval. Reviewer recorded. Correction classification.
- **Exit:** a reviewer can view the three candidates with graphics and evidence and approve one; editing after approval invalidates it (tested).

### Phase 7 — X publisher (dry-run first)
- `SocialPublisher` interface and X adapter. Media upload path. Dry-run mode as default.
- All Section 10.3 safeguards. Timeout-safe retry logic. Provider ID/URL persistence. Publish cost recording. "No link on X" default.
- **Exit:** an approved post goes through a full dry-run publish and is recorded. Publishing without approval, with a changed revision, or twice is blocked (tested). Real publishing is ready to enable once credentials exist.

### Phase 8 — Schedule & end-to-end
- Friday 09:00 UTC schedule with timezone handling, duplicate-run prevention, and missed-run recovery.
- End-to-end test: `Trigger → Research → Verify → Generate → Validate → Render → Review → Approve → Publish (dry-run)`.
- Failure tests: source outage, licence failure, conflicting data, provider timeout, restart mid-pipeline.
- Docs: setup on Windows, env vars, running tests, adding a post type, deploying to Lightsail (draft).
- **Exit: the first output (Section 3.1) is demonstrated.**

### After the first output (not now)
Real AI provider and benchmark; real X publishing; Wikimedia Commons search adapter; game-completion detection and live tournament mode; full review UI; more templates and post types; Facebook, Instagram, Discord; Lightsail production deployment and monitoring.

---

## 14. Testing requirements

- **Unit:** config validation, schedules/timezones/DST, phase detection, rating/score calculations, claim resolution, schema validation, idempotency keys, approval invalidation, state transitions, retry limits.
- **Integration:** adapters with recorded fixtures, research package construction, DB persistence, rendering, storage, publisher with mocked X responses.
- **End-to-end:** the full path, plus rejection/regeneration, source outages, licence failures, conflicting data, rate limits/timeouts, "timeout but actually published", restart recovery, result correction after generation, publish without approval, publish of a different revision.
- **Image integrity:** original hash retained; only permitted transforms applied.
- **AI regression (later):** fixture research packages checked for factual support, adherence, diversity, and schema validity whenever prompts or models change.
- Routine test runs MUST NOT call live external APIs.

---

## 15. Security

- Secrets via environment variables locally and a secure store in production. `.env` is git-ignored; `.env.example` contains no real values.
- Separate dev and prod credentials. Least privilege. Social credentials are used only by the publishing module.
- Approval and publish permissions are enforced in the backend.
- External content and model output are untrusted. Validate before DB writes or side effects.
- Audit log for approvals, revisions, and publications.
- Dry-run until approval and verification are proven.
- Check each provider's data-retention and training terms before sending content; send no personal or confidential data unnecessarily.

---

## 16. Metrics

- **Operational:** opportunities created, jobs succeeded/failed, source freshness and failures, generation latency/failures, review queue size/age, publish success, duplicates prevented, retries/rate limits, licence failures, cost per job/provider.
- **Quality:** unedited-approval rate (primary), review time, regeneration rate, factual-correction rate, image-replacement rate, rejection rate, cost per approved post, by post type, channel, and model.
- The denominator for the 10-day target is defined before measuring. Difficult, rejected, or failed posts are never excluded.

---

## 17. Acceptance criteria — first output

1. PT 1.1 config validates; invalid configs and `approvalRequired: false` are rejected.
2. Manual and fixed-schedule triggers create opportunities; duplicates are prevented.
3. The manual/fixture adapter and one real adapter work (real adapter tested with recorded fixtures).
4. Source data is stored with provenance and timestamps.
5. A PT 1.1 research package is produced; critical numbers are computed in code and traceable.
6. Unverifiable critical claims block progress or flag for review.
7. Three meaningfully different, schema-valid candidates are generated through the provider interface (stub provider).
8. Every candidate claim resolves to stored evidence.
9. A Player vs Player graphic is rendered from original photos using only deterministic operations, with licence records.
10. A reviewer can view, edit, regenerate, reject, defer, request research, and approve.
11. Approval is bound to an exact revision and asset set; edits invalidate it.
12. Publishing without valid approval is impossible.
13. A dry-run X publication is recorded with status; real publishing is one config switch away.
14. Retries and partial failures never cause duplicate posts or unnecessary re-work.
15. Cost and token usage per run are recorded.
16. Automated tests cover the critical logic and the end-to-end path, and pass on Windows.
17. Setup, configuration, testing, and adding a post type are documented.

---

## 18. Open decisions (raise, don't guess)

1. Full list of the 18 post types and their IDs.
2. AI provider and model (deferred; stub until decided).
3. Which chess source is the first real adapter (Claude Code recommends; human approves).
4. Production database: separate Postgres instance vs a separate database on the existing XLChess server.
5. Asset storage in production (Lightsail object storage vs S3) and retention periods.
6. Review mechanism for the first output (CLI vs minimal web page).
7. Reviewer identities and roles.
8. Licence status and source of the reference photo in `docs/reference/`.
9. X developer account: timing, credit budget, posting policy (links or not).
10. Definition of the daily volume and denominator for the 10-day quality target.
11. Lightsail instance size for Playwright rendering.

---

## Appendix A — Official documentation to verify

**AI providers (for the later benchmark):**
- OpenAI: https://developers.openai.com/api/docs/
- Gemini: https://ai.google.dev/gemini-api/docs
- Anthropic: https://docs.claude.com/
- OpenRouter: https://openrouter.ai/docs

**Chess sources:**
- FIDE: https://www.fide.com/
- FIDE Ratings: https://ratings.fide.com/
- Chess.com News: https://www.chess.com/news
- Lichess: https://lichess.org/api
- TWIC: https://theweekinchess.com/
- ChessBase: https://en.chessbase.com/

**Images:**
- Wikimedia Commons: https://commons.wikimedia.org/
- Flickr CC: https://www.flickr.com/creativecommons/
- Unsplash: https://unsplash.com/
- Pexels: https://www.pexels.com/

**Social:**
- X API: https://docs.x.com/
- Meta Pages API: https://developers.facebook.com/docs/pages-api/
- Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
- Discord webhooks: https://discord.com/developers/docs/resources/webhook

Base every technology decision on tested quality, reliability, legal suitability, and total cost, not on outdated pricing or free-tier headlines.
