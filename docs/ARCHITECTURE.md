# SMB — Architecture & Implementation Plan (Module 1.1)

Status: **Draft for review** · Author: Harsh Mahatha · Date: 3 Nov 2026

This is the 1.1 deliverable: the data flow, interfaces, worker boundaries, failure paths and infrastructure for SMB. It also walks through the first use case, World Championship (PT 1.1), from start to finish.

---

## 1. Scope and boundaries

| System | Owns | Lives in |
|---|---|---|
| **SMB API** (this repo, `apps/api`) | Configuration, scheduler, event monitor, source adapters, research & verification, job queue, image/licence pipeline, rendering, approval logic, publishing adapters, audit, metrics | This repo, deployed on the same host as the XLChess backend |
| **SMB Worker** (this repo, `apps/worker` + `installer/`) | Runs local AI on the home PC: claims jobs, runs Ollama, returns results. **No social credentials, no inbound ports.** | Home PC (Windows 10, RTX 4070) |
| **XLChess web app** (separate repo) | Reviewer and admin screens. Calls the SMB API only. | XLChess codebase |
| **SMB Supabase project** (separate from XLChess) | Postgres (schema `smb`) and Storage buckets for original and generated media | Supabase |

Fixed by these decisions:
- SMB has **no UI**. Everything a reviewer or admin does is a REST call made by the XLChess app.
- SMB uses its **own Supabase project**. XLChess user ids are stored as plain references, with no cross-project foreign keys.
- Authentication comes from **XLChess's custom auth**: SMB verifies the XLChess-issued JWT and keeps its own role table.
- AI runs **locally on the home-PC worker**. Dev and tests use a deterministic **stub provider**. No paid AI API in V1.

---

## 2. Technology stack

| Concern | Choice | Notes |
|---|---|---|
| Language / runtime | TypeScript, Node.js 22 LTS | Shared types between the API and the worker |
| HTTP framework | **Express 5** | Native async error handling. Zod middleware for validation. |
| Validation and contracts | **Zod** | Config files, request/response DTOs, AI output, worker job payloads. OpenAPI is generated from it (`@asteasolutions/zod-to-openapi`) so XLChess can generate a typed client. |
| Database | Postgres (Supabase, separate project), schema `smb` | The API connects directly over the pooler using a server-only role. The schema is not exposed to PostgREST. |
| Migrations | **Supabase CLI** (`supabase/migrations/*.sql`) | SQL is the source of truth |
| ORM | **Prisma** (client only) | `prisma db pull` → `prisma generate` after each migration. **`prisma migrate` is never used.** Job claiming uses `$queryRaw` with `FOR UPDATE SKIP LOCKED`. |
| Job queue | Postgres `jobs` table | No Redis or broker (per the guide) |
| Scheduler | `node-cron` in the API process, guarded by a Postgres advisory lock | The lock prevents double-firing if two instances run |
| Object storage | Supabase Storage (S3-compatible) | Buckets `originals` (immutable), `renders`, `evidence` |
| Image processing | Sharp | Only crop, resize, rotate and position on originals |
| Graphic rendering | HTML/CSS templates → Playwright screenshot | Deterministic. Fonts are bundled. |
| Local AI | Ollama + Qwen3 8B (quantised) as the first candidate | The model choice is configurable and benchmarked in Phase 3 |
| Logging | pino (JSON) with secret redaction | |
| Tests | Vitest + Supertest; Testcontainers Postgres for integration tests | |
| Repo tooling | npm workspaces | |

---

## 3. Repository layout

```text
XLChess-SMB/
  apps/
    api/                      Express server: REST API, scheduler, server-side job runner
      src/
        http/                 routers, auth middleware, error handler, OpenAPI
          routes/review/      reviewer endpoints (queue, candidates, actions)
          routes/admin/       configs, jobs, workers, prompts, publish mode
          routes/worker/      device-token endpoints for the home PC
        core/
          orchestrator/       opportunity state machine; calls services and holds no domain logic
          workflow/           step definitions, transition guards, retry policy
          scheduler/          cron → opportunities
          events/             trigger ingestion (1.16)
          queue/              enqueue, claim, lease, reaper, idempotency
        config/               loader + validation of /config JSON, runtime overrides
        sources/              SourceAdapter implementations (fide/, chesscom/, lichess/, twic/, …)
        research/             normalisation/, identity/, verification/, package builder
        generation/           prompt templates, output schemas, claim checker
        images/               search/, licensing/, integrity/, composition/, templates/
        review/               approvals/, revisions/, feedback/
        publishing/           PublishingAdapter + x/ (facebook/, instagram/, discord/ later)
        storage/              Supabase Storage wrapper, content hashing
        auth/                 XLChess JWT verification, role checks, device tokens
        monitoring/           metrics, KPIs, alerts
        db/                   Prisma client, raw SQL helpers
      prisma/schema.prisma    introspected and never hand-edited
    worker/                   Home-PC agent (Node, packaged as a Windows service)
      src/
        client/               SMB API client (claim, heartbeat, complete, fail)
        runners/              job handlers by kind (story-select, candidates, …)
        ai/                   Ollama client (localhost only)
        health/               GPU/VRAM/disk probes (nvidia-smi)
  packages/
    shared/                   Zod schemas + TS types shared by api & worker
      src/jobs/               job kinds, payload/result schemas, versions
      src/config/             post-type config schema
      src/api/                DTOs for the XLChess client
  config/
    post-types/1.1-world-championship.json
    sources.json
    channels.json
    templates/                graphic templates (HTML/CSS + manifest)
  supabase/
    migrations/               SQL migrations (source of truth)
    seed.sql
  installer/
    setup-xlchess-worker.ps1  plus update/repair/diagnose/uninstall scripts
  tests/
    unit/ integration/ end-to-end/ fixtures/
  docs/
```

---

## 4. Logical components and their interfaces

The **orchestrator** only moves an opportunity through states and enqueues the next step. All domain work sits behind these interfaces, and new post types, sources and channels are added by **implementing an interface plus configuration**.

```ts
// Source adapters (1.4): retrieve and normalise approved data
interface SourceAdapter {
  id: string;                                   // e.g. "D1" / "fide"
  fetch(req: SourceRequest): Promise<RawRecord[]>;
  normalise(raw: RawRecord): SourceRecord;      // with url, retrievedAt, eventTime
}

// AI provider (1.7): implemented by the worker (Ollama) and by StubProvider
interface AiProvider {
  generate<T>(task: AiTask<T>): Promise<AiResult<T>>; // output is validated with task.schema (Zod)
}

// Image sources (1.8)
interface ImageSource {
  id: string;                                   // "I1".."I4"
  search(q: ImageQuery): Promise<ImageCandidate[]>;
  licence(c: ImageCandidate): Promise<LicenceEvidence>; // rejects when unclear
}

// Renderer (1.10): deterministic, with the same inputs giving the same output hash
interface Renderer {
  render(t: TemplateRef, data: RenderData, assets: AssetRef[]): Promise<RenderedAsset>;
}

// Publishing adapters (1.13, 1.23)
interface PublishingAdapter {
  channel: 'x' | 'facebook' | 'instagram' | 'discord';
  validate(pkg: ApprovedPackage): ChannelCheck;          // length, media, alt text
  publish(pkg: ApprovedPackage, idemKey: string): Promise<PublishResult>;
  lookup(idemKey: string): Promise<PublishResult | null>; // safe recovery after a timeout
}
```

Rules:
- Statistics such as rating changes and scores are **computed in code** inside `research/`. The LLM only writes prose around facts it is given.
- Every generated claim has to map to a `claimId` in the research package. The claim checker removes or flags anything unsupported.
- Source text is passed to the model as **quoted, untrusted data**. Prompts never put source text in the instruction position.

---

## 5. End-to-end data flow

```mermaid
flowchart LR
  subgraph API[SMB API - server]
    SCH[Scheduler / Event monitor] --> OPP[(post_opportunities)]
    OPP --> ORC[Orchestrator]
    ORC -->|server job| RES[Research and verification<br/>source adapters]
    RES --> RP[(research_packages)]
    ORC -->|gpu job| Q[(jobs queue)]
    Q -.result.-> ORC
    ORC -->|server job| IMG[Image search, licence,<br/>Sharp, Playwright render]
    IMG --> CAND[(post_candidates + revisions + media_assets)]
    CAND --> REVQ[Awaiting review]
    REVQ --> APR[Approval manager]
    APR --> PUB[Publishing adapters - X first]
    PUB --> PUBS[(publications)]
  end
  subgraph PC[Home PC worker]
    W[Worker agent] --> OL[Ollama - localhost]
  end
  W <-->|outbound HTTPS: claim, heartbeat, complete| Q
  UI[XLChess web app - reviewer/admin] <-->|REST + XLChess JWT| APR
  UI <--> ORC
```

### Job lanes
One `jobs` table, with two lanes:
- **`server`**: research, image search and licensing, rendering, publishing. Run by an in-process runner in the API, which has network access, storage and credentials.
- **`gpu`**: story selection, candidate writing, revision-from-feedback. Claimed only by paired workers. Start at concurrency 1, then benchmark.

### Opportunity lifecycle (from the guide)

```text
pending → researching → generating → awaiting_review → approved → scheduled → publishing → published
            │              │               │              │            │
            └──> failed    └──> failed     ├──> rejected  └──> deferred└──> partially_published / failed (per channel)
                                           ├──> deferred
                                           └──> researching (request research) / generating (regenerate)
```

- Each transition is a **guarded function** in `core/workflow`, so no code path can jump states.
- Each step is its own job with its own retries. A failed render **does not re-run research**.
- Publishing is tracked **per channel** in `publications`. A failed Instagram post never re-posts to X or re-renders the image.

### Approval binding
- An edit creates a new **immutable `post_revision`** with `content_hash = sha256(caption, channel texts, asset hashes, template version)`.
- Approval records `(revision_id, content_hash, reviewer_id, timestamp)`.
- Publishing re-computes the hash and refuses if it differs, if the reviewer has lost their role, or if licence or attribution checks fail.

---

## 6. Worker boundary and protocol

The home PC only ever makes **outbound HTTPS** calls to `/worker/v1/*`. It authenticates with a **device token**: opaque, stored hashed in `smb.workers`, revocable, and scoped to worker endpoints only.

| Endpoint | Purpose |
|---|---|
| `POST /worker/v1/pair` | Swap a short-lived pairing code (made by an admin in XLChess, 10-minute TTL, single use) for a device token |
| `GET  /worker/v1/config` | Desired state: paused, concurrency, model list, prompt/config versions, target worker version |
| `POST /worker/v1/status` | Device heartbeat: GPU/VRAM/disk, Ollama state, current jobs |
| `POST /worker/v1/jobs/claim` | Atomically claim the highest-priority eligible `gpu` job (`SKIP LOCKED`). Returns the payload, `leaseId` and `leaseExpiresAt`. |
| `POST /worker/v1/jobs/:id/heartbeat` | Extend the lease and report progress. The response can say `cancel`. |
| `POST /worker/v1/jobs/:id/complete` | Submit the result. **Idempotent** on `(jobId, leaseId)`: a duplicate submit returns the first outcome. |
| `POST /worker/v1/jobs/:id/fail` | Report an error and whether it is retryable |
| `POST /worker/v1/logs` | Batched log upload, redacted |

Recovery:
- A **lease reaper** in the API finds expired leases, re-queues the job with `attempts+1`, and marks it `dead` after `maxAttempts` (taken from the post type's `retryPolicy`).
- The worker writes a **local checkpoint** for each job. After a restart it re-claims through the normal flow; it never replays a stale lease.
- Results are stored **only** through `complete`, inside a transaction, so a crash can't leave a half-written candidate set.
- Stale work expires: each job has a `notAfter`, so a game recap that is 2 days old gets reconsidered, not generated.

The **installer** (`setup-xlchess-worker.ps1`) handles: preflight checks (OS, GPU driver, VRAM, RAM, disk, network), installing Ollama and pulling the model, installing the worker as a Windows service (NSSM or a scheduled task with restart-on-fail), checking power and sleep settings, pairing, and running a test job with a GPU check. It ships with `update`, `repair`, `diagnose` and `uninstall` scripts. **Which module builds this is still open** (README open point). This plan puts it in Phase 3, alongside 1.7.

---

## 7. API surface for XLChess (reviewer and admin)

All routes are under `/v1` and need `Authorization: Bearer <XLChess JWT>`.

| Area | Representative endpoints | Role |
|---|---|---|
| Review queue | `GET /v1/review/queue`, `GET /v1/opportunities/:id` (candidates, revisions, research claims with source links, assets, licences, channel previews, publication history) | reviewer |
| Edit | `POST /v1/candidates/:id/revisions` | reviewer |
| Actions | `POST /v1/revisions/:id/approve` (body: `contentHash`, `channels`, `scheduledFor?`), `POST /v1/opportunities/:id/{reject,defer,regenerate,request-research}` | reviewer |
| Publishing | `GET /v1/publications`, `POST /v1/publications/:id/retry` | admin |
| Config | `GET/PUT /v1/admin/post-types/:id/overrides`, `GET /v1/admin/configs/versions` | admin |
| Queue & workers | `GET /v1/admin/jobs`, `POST /v1/admin/jobs/:id/{retry,cancel,reprioritise}`, `GET /v1/admin/workers`, `POST /v1/admin/workers/pairing-codes`, `POST /v1/admin/workers/:id/{pause,resume,revoke}` | admin |
| Prompts / models | `GET/POST /v1/admin/prompts`, `PUT /v1/admin/workers/:id/models` | admin |
| Publish mode | `GET/PUT /v1/admin/publish-mode` | admin (+ env gate) |
| Metrics | `GET /v1/metrics/*` | reviewer |
| Contract | `GET /v1/openapi.json` | public |

Errors use one shape: `{ error: { code, message, details? } }`. Mutating reviewer actions accept an `Idempotency-Key` header.

---

## 8. Security model (detailed in 1.18)

- **User auth**: verify the XLChess JWT. Algorithm and key (HS256 secret or RS256 JWKS URL), issuer and audience all come from env. SMB keeps `smb.user_roles (xlchess_user_id, role)` with the roles `viewer`, `reviewer`, `admin`.
- **Worker auth**: device tokens, as described in §6. A worker token cannot reach `/v1/*`.
- **Social credentials** stay in the API host's secret env only. They are used only by `publishing/`, never sent to the worker, and never returned by any endpoint. Logger redaction is enforced by a test.
- **Publish mode**: `dry_run` (the default; records what *would* be posted), `sandbox`, `live`. Setting `live` needs **both** `SMB_ALLOW_LIVE_PUBLISH=true` in env **and** an admin toggle, which is audited.
- **Audit log**: every privileged action (approve, publish-mode change, pairing, revoke, config override) is written to `smb.audit_log`.
- Separate dev and prod Supabase projects, and separate X apps and credentials.

---

## 9. Failure paths

| Failure | Handling |
|---|---|
| Source down or rate-limited | Adapter retries with backoff. The research step fails alone and is retried. Partial packages are flagged, not passed off as complete. |
| Conflicting facts between sources | The claim is marked `unverified`. A required claim that stays unverified blocks generation and asks for more research. |
| Worker offline | GPU jobs wait in the queue, and the admin UI shows the worker as offline. Time-sensitive jobs past `notAfter` expire. |
| Worker crash mid-job | The lease expires, the reaper re-queues, and bounded retries end in `dead` with an alert |
| AI output invalid (fails schema or has an unsupported claim) | Repaired or retried up to N times, then the step fails. Never shown to a reviewer as valid. |
| No licensable image | The photo is rejected. The pipeline falls back to the template's no-photo variant or flags the opportunity. |
| Render failure | Only the render step is retried |
| Revision edited after approval | The hash mismatch invalidates the approval, and the post goes back to `awaiting_review` |
| X publish timeout | `lookup(idemKey)` runs **before** any retry, so the post is never double-posted |
| One channel fails | Only that `publications` row is retried |
| API restart | All state is in Postgres. Cron is re-derived, server jobs with expired leases are re-queued, and the advisory lock stops duplicate schedulers. |

---

## 10. Reference use case: World Championship (PT 1.1)

Config: `config/post-types/1.1-world-championship.json`. Sources D1–D5, images I1–I4, channels X/FB/IG/Discord (X only in V1), normal schedule Friday 09:00 UTC, tournament phase "after each completed game", 3 candidates, approval mandatory.

Walkthrough (tournament phase):
1. The event monitor sees game N finish (1.16), and the phase resolver says `tournament` (1.15). It creates an opportunity with a dedupe key `1.1:wcc-2026:game-N`.
2. The research job pulls the result, PGN and standings from the approved sources. Code computes the score and standings, cross-checks the result across two sources, and produces a research package with `claimId`s.
3. The story-selection GPU job picks the angle (1.6).
4. The candidate GPU job writes 3 captions, each citing `claimId`s. The claim checker validates them (1.7).
5. The image job finds photos in I1–I4 and records licence evidence. Sharp crops the originals, Playwright renders the game-result template, and hashes are stored (1.8–1.10).
6. The opportunity moves to `awaiting_review`. The XLChess UI shows 3 candidates with previews, sources and licences (1.11).
7. The reviewer edits candidate B (creating revision 2) and approves revision 2 with its hash.
8. The publishing step runs pre-flight checks, then posts to X in dry-run until live is enabled. It stores the tweet id and URL (1.13).

Phase 4 acceptance includes **recreating the Gukesh–Sindarov trial post** from the original photographs. I need that trial post and its assets from the manager.

---

## 11. Phased delivery mapped to modules

| Phase (guide) | Modules | Deliverable |
|---|---|---|
| 1. Design | **1.1**, 1.2, 1.3 | This doc, the `smb` schema with migrations, and post-type config schema + 1.1 config |
| 2. Data | 1.4, 1.5 | Source registry, first adapter, verified research package for PT 1.1 |
| 3. Generation | 1.6, 1.7, **worker + installer** | Story selection, 3 validated candidates via the stub provider, then via the paired home PC |
| 4. Images | 1.8, 1.9, 1.10 | Licensed photos, immutable originals, deterministic render of the trial post |
| 5. Review | 1.11, 1.12 | Reviewer API, revisions, approval binding, feedback capture |
| 6. X | 1.13, 1.18 | Dry-run, then live, X publishing with duplicate safeguards |
| 7. Automation | 1.14, 1.15, 1.16, 1.17 | Scheduling, phases, event triggers, recovery |
| 8. Complete | 1.19, 1.20, 1.21, then 1.22, 1.23 | KPIs, test suite, deployment docs; then more post types and channels |

Immediate next steps after this design is approved:
1. Scaffold the monorepo (npm workspaces, TS config, Express app with health and OpenAPI, shared package, Vitest, lint) and set up the Supabase CLI.
2. 1.2: write the `smb` schema migrations, then `prisma db pull` (done, see section 13).

---

## 13. Database schema and provenance (Module 1.2)

Migrations are in `supabase/migrations/`, dev fixtures in `supabase/seed.sql`, and the tests in `tests/integration/db/` (`npm run test:integration`, needs Docker or `SMB_TEST_DATABASE_URL`).

### Tables

| Area | Tables |
|---|---|
| Configuration and sources | `post_types`, `post_configs` (versioned, immutable, one active per type), `data_sources` (data `D*` and image `I*`), `source_records` |
| Work | `post_opportunities` (pinned to an exact `post_configs` row), `opportunity_events` (status history), `jobs` |
| Research | `research_packages`, `research_claims`, `research_claim_sources` (claim to source record, many to many) |
| Content | `post_candidates` (slots A/B/C per generation cycle), `post_revisions` (immutable, hashed), `revision_claims`, `revision_assets` |
| Media | `media_assets` (original, derived, render, evidence), `media_licenses` |
| Review and publishing | `review_actions`, `publications` (one row per approval and channel), `publication_attempts` |
| Operations | `post_metrics`, `audit_log`, `retention_policies` |

`post_revisions` is not in the guide's table list, but "one candidate can have multiple revisions" needs it.

### Rules enforced by the database
- **Append-only history.** Revisions, review actions, claims, licences, status events, candidates, attempts, metrics and the audit log cannot be updated or deleted (`smb.immutable_except()`). A few columns stay writable: publication status fields, `media_assets.deleted_at`, `source_records.raw_payload`, and `post_configs.is_active`.
- **Approval binding.** An `approve` action must carry the exact `content_hash` of its revision, and a publication must match its approval's revision, hash and approved channel. Changing the text after review therefore cannot be published under the old approval.
- **Image provenance.** An original has a source URL and image source. A derived asset has a parent and a transform. A render has a template version. An accepted licence must allow commercial use and have a licence URL or saved evidence.
- **Status history.** A trigger writes `opportunity_events` on every status change. Set `smb.actor`, `smb.reason` and `smb.job_id` with `set_config(..., true)` inside the transaction to record who and why.
- **No client access.** `anon` and `authenticated` have no privileges on the `smb` schema.

### Tracing a post
`smb.publication_provenance` returns, per publication: the approval and reviewer, the revision (number, author, hash), the generation (provider, model, prompt version, job), the exact config version, the research package, every cited claim with its source URL, retrieval time and payload hash, every asset with its original photo, source URL and licence, and the status history.

### Retention (`smb.apply_retention(now)`)
Defaults live in `smb.retention_policies` and can be edited:

| Subject | Default | Effect |
|---|---|---|
| `source_raw_payload` | 90 days | `raw_payload` is cleared. URL, hash and normalised record stay. |
| `unused_image` | 30 days | Original and derived images that never reached an approved revision get `deleted_at`. |
| `unused_render` | 30 days | Same for rendered graphics. |
| `job_payload` | 30 days | Payload and result of finished jobs are cleared. The row stays. |

Anything used by an approved or published revision, its ancestor originals, and licence evidence are never touched. The function only marks rows. Removing the files from Storage and running it on a schedule belong to 1.9 and 1.17.

### Deferred to later modules
`workers` and `user_roles` (1.18, so `jobs.leased_by` has no foreign key yet), config loading and validation (1.3), Storage buckets (1.9), and the job runner and lease reaper (1.17).

---

## 12. Open items (need answers, none block scaffolding)

1. **XLChess JWT details**: signing algorithm and key/JWKS, issuer, audience, and the user-id claim. Do roles come from token claims or from SMB's own role table?
2. **Host**: which host and OS run the XLChess backend? This matters because Playwright needs Chromium. Is there a public HTTPS URL the worker can reach?
3. **Who builds the worker and installer?** It isn't in any module's scope. This plan puts it in Phase 3.
4. **X API tier**: posting with media needs a paid X API tier. Per the guide, paid services must be approved before implementation.
5. **Data source access** (D1–D5, I1–I4): which ones need API keys or a paid plan, and what do their terms of use allow?
6. **Windows 10 end of support**: a security assessment and an OS migration path go in the 1.21 docs.
7. **Gukesh–Sindarov trial post**: I need the post and its original assets for the Phase 4 acceptance test.
8. **Known doc conflicts** (README): "5 posts/day" in 1.22 against the guide's "no fixed quota", and the undefined "15 V1 acceptance conditions" in 1.20.
