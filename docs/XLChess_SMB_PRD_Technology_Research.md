# XLChess Social Media Bot (SMB)

## Product Requirements Document, Technical Research & AI Workflow Strategy

**Document type:** Product + Technical Research Brief for Claude Code\
**Status:** Pre-implementation research; no SMB repository or
implementation exists yet\
**Prepared:** 30 October 2026\
**Primary objective:** Give Claude Code the complete product context,
requirements, constraints, research findings, recommended AI
architecture, and decision-making rules needed to inspect the
environment and propose an appropriate project structure and
implementation plan.

------------------------------------------------------------------------

# 0. Instructions for Claude Code

You are assisting with the implementation planning and eventual
development of the XLChess Social Media Bot (SMB). The system is being
built from scratch. This document combines the manager's original
product specification with the current research on AI models, agents,
and content-generation workflow.

**Do not treat this document as permission to start coding blindly.**
First inspect the actual working directory and available infrastructure,
then propose a project structure and implementation plan that fits the
requirements. The repository has not yet been created or inspected, so
do not assume any existing SMB code, schema, deployment, integrations,
credentials, or hosting setup.

## 0.1 How to interpret this document

-   **Requirements** are behaviours SMB must provide.
-   **Recommendations** are proposed implementation choices that should
    be validated against current provider capabilities, prices, terms,
    and the real deployment context.
-   **Examples** illustrate expected shapes or behaviours; they are not
    necessarily production-ready schemas.
-   **Open decisions** must be identified explicitly rather than
    silently guessed.
-   If two requirements conflict, preserve human approval, factual
    accuracy, legal image use, security, and duplicate prevention as
    hard constraints.
-   Do not implement all post types or all social platforms at once.
    Build a small end-to-end vertical slice first.
-   Prefer the smallest reliable architecture that meets the
    requirements and can be extended through configuration.
-   Do not add a framework, service, database, queue, or provider merely
    because it is popular. Explain the operational value and recurring
    cost of each dependency.
-   Before selecting a model or external service, verify current
    official documentation, API access requirements, data-handling
    terms, limits, and pricing.
-   Never expose secrets, access tokens, or credentials in source code,
    prompts, logs, client-side code, or generated content.
-   Never bypass human approval in V1.

## 0.2 Expected first response from Claude Code

Before implementation, provide:

1.  A concise understanding of the product and its workflows.
2.  A proposed architecture and project structure.
3.  A list of external dependencies and which require paid accounts, API
    approval, or credentials.
4.  A data model and state-transition proposal.
5.  An implementation sequence with testable milestones.
6.  Any material ambiguities or risks that require a decision.
7.  A clear distinction between required functionality and optional
    future enhancements.

Do not claim that integrations work until they have been tested with
real or representative credentials and provider responses.

------------------------------------------------------------------------

# 1. Product overview

## 1.1 Product name

**XLChess Social Media Bot (SMB)**

SMB is an automated social-media content-production system for XLChess.
It is intended to automate the research, selection, creation, visual
composition, review preparation, scheduling, publication, monitoring,
and improvement of social-media posts.

SMB is **not merely a social-media scheduler**. Its goal is to automate
much of the work normally performed by a small content team: researching
chess topics, choosing stories, checking facts, writing captions,
locating usable images, producing graphics, and preparing content for
approval.

## 1.2 Business context

XLChess is an early-stage chess platform. Building an audience before
launch and continuing to grow it after launch are important parts of
customer acquisition.

A conventional content operation can require researchers, writers,
designers, editors, and social-media managers. SMB should automate as
much of that repetitive work as is practical while preserving human
control over publication.

## 1.3 Operating target

The initial operational target is approximately **five complete,
review-ready posts per day**.

The reviewer should receive finished content, not raw ideas or research
tasks. A human should not need to manually research the topic, find the
image, calculate the statistics, or create the graphic before reviewing
it.

The long-term quality milestone is **10 consecutive days in which all
original SMB-generated posts can be approved without modification**.
This is a quality target, not permission to remove the approval gate.
Define the measurement window and required daily volume so that
difficult or rejected posts are not silently excluded from the metric.

## 1.4 Product milestones

-   **V1:** SMB creates complete candidate posts; humans review, edit,
    reject, defer, regenerate, and approve them.
-   **V2:** Generated content consistently requires little or no
    correction.
-   **Long term:** Increase output and supported channels while reducing
    human involvement without weakening accuracy, licensing, security,
    or approval safeguards.

## 1.5 Core principles

1.  Automation first: SMB should not depend on humans supplying every
    topic or doing the research.
2.  Configuration-driven: post types, sources, schedules, channels, and
    content rules should be configurable.
3.  Evidence-based: claims about players, tournaments, ratings,
    rankings, and results must be supported by reliable evidence.
4.  Human approval: V1 must never publish an unapproved post.
5.  Image integrity: original photographs must not be altered by
    generative AI. Deterministic crop, resize, rotation, positioning,
    and compositing are permitted.
6.  Legal image use: each external image must have its own usage rights
    assessed and recorded.
7.  Reusable architecture: adding a post type should mostly require
    configuration and templates, not a new application.
8.  Continuous improvement: record human corrections and use them to
    improve prompts, rules, and templates.
9.  Reliability: scheduling, retries, deduplication, partial publication
    failures, and recovery must be handled explicitly.
10. Traceability: every post must be traceable to its research, claims,
    sources, images, licence evidence, prompt/model versions, revisions,
    approval, and publication attempts.
11. Cost awareness: optimise total cost per accepted post, not only the
    price of one model call.
12. Security by design: external content is untrusted input; production
    credentials and publishing permissions must be tightly controlled.

------------------------------------------------------------------------

# 2. Scope and rollout strategy

## 2.1 First release

The first release should establish a reliable end-to-end vertical slice:

1.  One configured post type.
2.  One research path using approved sources.
3.  Structured, source-linked research data.
4.  AI-assisted story selection.
5.  Three candidate versions.
6.  Fact and schema validation.
7.  Licensed image selection and deterministic graphic rendering.
8.  A human review/approval interface or a minimal review mechanism
    agreed for the first milestone.
9.  Publishing to X only, after approval.
10. Logging, duplicate prevention, failure handling, and tests.

Do not attempt to implement every post type or every social network
before proving this vertical slice.

## 2.2 Explicitly deferred features

These are not prerequisites for the first working version:

-   Autonomous publication without human approval.
-   Implementing all post types at once.
-   Supporting all four channels on day one.
-   Model fine-tuning.
-   Advanced video production or animation.
-   Sophisticated paid-advertising or audience-targeting features.
-   Large-scale analytics and optimisation.
-   An autonomous multi-agent system unless evaluation demonstrates a
    real need.

------------------------------------------------------------------------

# 3. Post types and configuration

## 3.1 Post-type hierarchy

The manager's original material described 23 categories. The
subsequently consolidated working hierarchy contains **18 top-level post
types**. Use the consolidated hierarchy as the working direction, but
obtain the final approved list of identifiers and names before
implementing all configurations. The full list of 18 names and
identifiers was not supplied in the current brief and must not be
invented.

A post type (PT) is a broad content category. A subtype is a specific
stream within that category. The architecture must be one reusable
pipeline, not a separate application per type.

## 3.2 Required configuration fields

Each subtype should support, as applicable:

  -----------------------------------------------------------------------
  Field                               Purpose
  ----------------------------------- -----------------------------------
  `id`                                Stable identifier, e.g. `1.1`

  `name`                              Human-readable name

  `enabled`                           Whether the subtype is active

  `sources`                           Approved information-source
                                      identifiers

  `imageSources`                      Approved image-source identifiers

  `channels`                          Supported targets such as X,
                                      Facebook, Instagram, Discord

  `schedule`                          Fixed time, frequency, or event
                                      trigger

  `timezone`                          Timezone for schedule
                                      interpretation

  `phases`                            Optional lifecycle-specific
                                      behaviour

  `contentRules`                      Required facts, tone, structure,
                                      and restrictions

  `imageRules`                        Image selection, rights, and
                                      composition requirements

  `approvalRequired`                  Must be true for V1

  `priority`                          Priority relative to other post
                                      types

  `deduplication`                     Rules preventing repeated content

  `retryPolicy`                       Failure and retry behaviour
  -----------------------------------------------------------------------

Use version-controlled JSON or an equivalent typed configuration with
schema validation. A database may hold runtime overrides, but
configurations must remain understandable, testable, and auditable.
Validate configurations at startup and when changed.

------------------------------------------------------------------------

# 4. Reference implementation: World Championship (PT 1.1)

The World Championship is the reference post type and should be the
first end-to-end example. It illustrates recurring schedules,
event-driven posting, lifecycle phases, source verification, and
duplicate prevention.

## 4.1 Reference configuration

  -----------------------------------------------------------------------
  Property                            Value
  ----------------------------------- -----------------------------------
  Post type                           `1.1` --- World Championship

  Data sources                        `D1`, `D2`, `D3`, `D4`, `D5`

  Image sources                       `I1`, `I2`, `I3`, `I4`

  Channels                            X, Facebook, Instagram, Discord
                                      (initial rollout remains X only)

  Normal schedule                     Friday at 09:00 UTC

  Tournament schedule                 After each completed game

  Candidate versions                  3

  Approval                            Mandatory
  -----------------------------------------------------------------------

## 4.2 Lifecycle phases

### Phase 1 --- Pre-tournament

Every Friday at 09:00 UTC, research and prepare content about the
upcoming championship. Topics may include participants, qualification,
dates, venue, format, player developments, preparation, relevant
history, and official announcements.

### Phase 2 --- During tournament

Suspend the ordinary weekly schedule for this subtype. After each
completed game, create a posting opportunity covering the result,
updated match score, important moments, championship context, and next
game.

### Phase 3 --- Post-tournament / next cycle

After the championship officially concludes, resume Friday posting.
Initially cover the outcome and implications, then transition to the
next qualification cycle, Candidates Tournament, and future
championship.

Repeat this lifecycle for subsequent championships.

## 4.3 Automatic phase detection

Do not rely on dates alone. Maintain a structured championship record
with:

-   Tournament/cycle identity.
-   Official scheduled start and end dates.
-   Confirmed actual start and official completion status.
-   Current game number and game status.
-   Players and official match score.
-   Next game, where available.
-   Next-cycle information.
-   Source references, retrieval timestamps, and verification status.

Possible states:

-   `PRE_TOURNAMENT`: verified event status indicates that the
    championship has not started.
-   `DURING_TOURNAMENT`: official event status indicates it has started
    and not concluded.
-   `POST_TOURNAMENT`: official event status indicates it has concluded
    and the next cycle is being tracked.

Use official FIDE information as the authority for event identity and
lifecycle. Other sources may support it. If authoritative sources
disagree or state is uncertain, flag the event for review rather than
guessing.

## 4.4 Game-completion trigger

A completed-game event should contain:

-   Championship identifier.
-   Stable game identifier and round/game number.
-   Both players.
-   Official result.
-   Updated match score.
-   Completion timestamp.
-   Source reference.
-   Verification status.

A game is complete only when a reliable source confirms the final
result. A stopped clock, interrupted broadcast, or temporary feed status
must not trigger publication by itself.

Distinguish individual games from rounds. Use an idempotency key such
as:

`world-championship-2026:game-1:result`

The exact key format should be based on stable event and game
identifiers rather than assuming a specific year or game number. It must
prevent duplicate work and publication.

If a result is corrected after a post has been generated or published,
update the internal record and flag the affected content for human
review. Do not silently rewrite already approved content or publish a
correction without the appropriate review.

## 4.5 Avoid repetitive posts

Track prior published topics, angles, and claims. Compare proposed
content against recent posts.

For example, a sequence might cover player introductions, rating
movements, qualification stories, preparation, match format, and
significant new developments. Do not repeatedly publish the same facts
without a meaningful new angle.

If there is insufficient fresh information, select a genuinely different
evergreen angle or report that no worthwhile post is available. Never
invent news to satisfy a schedule.

------------------------------------------------------------------------

# 5. Approved chess information sources

SMB must maintain an explicit registry of sources, their purpose, access
method, reliability, rate limits, and usage terms. Do not use
unrestricted internet search results as automatically verified facts.

## 5.1 Candidate source registry

  -------------------------------------------------------------------------------------
  ID                Source            Intended purpose  Reference
  ----------------- ----------------- ----------------- -------------------------------
  `D1`              FIDE              Official          https://www.fide.com/ and
                                      tournaments,      https://ratings.fide.com/
                                      ratings,          
                                      rankings,         
                                      regulations,      
                                      schedules,        
                                      announcements     

  `D2`              Chess.com News    Player stories,   https://www.chess.com/news
                                      previews, news,   
                                      and game analysis 

  `D3`              Lichess           Structured games, https://lichess.org/broadcast
                    Broadcasts        PGNs, results,    
                                      and broadcasts    

  `D4`              The Week in Chess Tournament        https://theweekinchess.com/
                    (TWIC)            results, games,   
                                      PGN archives      

  `D5`              ChessBase         Chess reporting,  https://en.chessbase.com/
                                      player            
                                      developments, and 
                                      game analysis     
  -------------------------------------------------------------------------------------

These are candidate sources, not blanket permission to scrape or
republish content. Before implementation, verify official APIs,
permitted retrieval methods, rate limits, terms, copyright, and
licensing. Prefer authorised APIs, structured feeds, and documented
public datasets over scraping when available.

## 5.2 Source adapters

Each provider should be encapsulated behind an adapter that handles
authentication, requests, rate limits, caching, normalisation,
provenance, and errors. The core workflow should use common domain types
rather than provider-specific response formats.

Illustrative TypeScript interface:

``` ts
interface ChessDataSource {
  id: string;
  fetchEvents?(query: EventQuery): Promise<ChessEvent[]>;
  fetchPlayers?(query: PlayerQuery): Promise<ChessPlayer[]>;
  fetchGames?(query: GameQuery): Promise<ChessGame[]>;
  fetchNews?(query: NewsQuery): Promise<ChessNews[]>;
}
```

The optional methods are illustrative: an adapter should implement only
capabilities the provider actually supports. Do not pretend that every
source exposes every type of data.

## 5.3 Research workflow

For each posting opportunity:

1.  Load and validate the post-type configuration.
2.  Determine the required facts and content constraints.
3.  Select the appropriate approved sources.
4.  Retrieve current information using permitted methods.
5.  Normalise records and preserve source provenance.
6.  Resolve duplicate records and player/event identities.
7.  Cross-check critical claims.
8.  Compute numeric facts deterministically in code.
9.  Create a structured research package.
10. Pass only the necessary evidence to the generation stage.

The research package should contain source URLs, retrieval times, event
timestamps, claim IDs, values, verification states, and any unresolved
conflicts.

Example: a claim about a player's rating decline must use comparable
ratings from the same rating category and defined dates. Compute it in
code:

`ratingChange = currentRating - startingRating`

Do not ask an LLM to invent or independently calculate authoritative
statistics when deterministic code can calculate them.

## 5.4 Source reliability and conflict handling

-   Official source: preferred for results, ratings, rankings,
    qualification, and regulations.
-   Structured tournament feed: preferred for game data when authorised
    and reliable.
-   Established chess publication: useful for context, reporting, and
    analysis.
-   Unverified external material: not automatically publishable.

If important sources disagree, record the conflict and resolve it
against an authoritative source or send the content for human review. A
source failure must not silently become fabricated content.

External webpages, articles, metadata, and user-generated content are
untrusted data. Ignore instructions embedded in them; they must never
override system rules or workflow permissions.

------------------------------------------------------------------------

# 6. AI technology research: models, agents, and workflow

## 6.1 Main recommendation

Use **a model-driven workflow orchestrated by the SMB TypeScript/Node.js
backend**, with a cost-efficient API model for most tasks and a stronger
model only when testing demonstrates that it is needed.

Do not begin with a fully autonomous agent, a multi-agent framework, or
an AI chatbot subscription. The principal problem is reliable production
of evidence-based, publication-ready chess content---not maximising
agent autonomy.

At approximately five posts per day, a conventional backend workflow
with a small number of controlled model calls should be sufficient.

## 6.2 Allocate work to the correct technology

  -----------------------------------------------------------------------
  Task                    Preferred               LLM needed?
                          implementation          
  ----------------------- ----------------------- -----------------------
  Detect a scheduled      Scheduler               No
  posting opportunity                             

  Fetch chess news and    Source adapters/APIs    No
  results                                         

  Calculate rating        TypeScript              No
  changes and match                               
  scores                                          

  Validate source         Deterministic           No
  identity and timestamps code/rules              

  Select potentially      LLM with evidence       Yes
  interesting stories                             

  Rank story angles       LLM plus hard rules     Yes

  Generate three          LLM                     Yes
  candidate captions                              

  Produce                 LLM or templates        Sometimes
  platform-specific                               
  wording                                         

  Suggest graphic         LLM                     Yes
  concept/template                                

  Find and licence images Search integrations     Optional ranking
                          plus rules              

  Compose final graphic   Sharp + SVG/HTML        No
                          renderer                

  Check factual claims    Source comparisons and  Limited
                          deterministic checks;   
                          LLM for editorial flags 

  Human approval          Review workflow         No

  Publish and retry       Backend + platform APIs No
  failures                                        
  -----------------------------------------------------------------------

The principle is: **use AI for interpretation, judgment, and language;
use ordinary software for facts, calculations, state transitions,
permissions, and external side effects.**

## 6.3 Provider options to benchmark

The research stage identified four plausible provider approaches. Model
identifiers, pricing, availability, limits, and terms must be rechecked
against official documentation before implementation.

### Option A --- OpenAI API

Official references:

-   Pricing: https://developers.openai.com/api/docs/pricing
-   Structured Outputs:
    https://developers.openai.com/api/docs/guides/structured-outputs
-   API documentation: https://developers.openai.com/api/docs/

Relevant capabilities include efficient models at different
cost/capability levels, structured outputs, and tool/function calling.

Advantages: - Structured output is useful for predictable candidate
schemas. - Tool calling can support controlled integrations. - One
provider can cover story selection, generation, and editorial
checking. - SDK integration is straightforward behind a provider
adapter.

Trade-offs: - API usage is billed separately from ChatGPT
subscriptions. - Model identifiers, availability, and prices change. -
The most capable model may not be cost-effective for every task. - A
ChatGPT plan must not be assumed to include API credits.

### Option B --- Google Gemini API

Official references:

-   Pricing: https://ai.google.dev/gemini-api/docs/pricing
-   Structured output:
    https://ai.google.dev/gemini-api/docs/structured-output
-   Function calling:
    https://ai.google.dev/gemini-api/docs/function-calling

Gemini's efficient/Flash-class models are plausible candidates for
low-cost generation. The API supports structured outputs and function
calling.

Advantages: - Potentially low-cost experimentation and generation. -
Structured output and function calling support. - Worth benchmarking for
caption quality, instruction following, and cost.

Trade-offs: - Free-tier eligibility, limits, capacity, and model
availability can change. - Do not treat free-tier access as a production
SLA. - Review current data-use terms. Free and paid tiers can have
different data-handling terms; do not send sensitive or unnecessary data
without checking the applicable terms.

### Option C --- Anthropic Claude API

Official reference:

-   Pricing: https://platform.claude.com/docs/en/about-claude/pricing
-   API documentation: https://docs.anthropic.com/

Claude's lower-cost model tiers may be worth testing for natural writing
and nuanced editorial review.

Advantages: - A useful comparison for writing tone and editorial
quality. - Lower-cost tiers may be appropriate for focused tasks. -
Could serve as an optional alternative if evaluations show a meaningful
advantage.

Trade-offs: - Adds another provider, credential, billing configuration,
and failure mode. - A second model does not automatically improve
factual accuracy. - Do not add it to production unless measured quality
gains justify the added complexity.

### Option D --- OpenRouter

Official references:

-   Pricing: https://openrouter.ai/pricing
-   Free-model catalogue: https://openrouter.ai/collections/free-models/

OpenRouter provides a common API for models from multiple providers and
can be convenient for comparative evaluation. Free models may be useful
for experiments, but availability and restrictions vary. Paid routing
may include a platform fee; verify the current fee and model-specific
costs before using it.

Advantages: - Convenient for testing different models behind a common
API. - Can reduce the effort of early comparative experiments. - Some
models may be available for no-token-cost experimentation.

Trade-offs: - Free-model capacity, latency, availability, and limits may
be unpredictable. - Provider routing adds a dependency and potentially a
fee. - Review data routing, retention, privacy, and provider terms. - Do
not make production generation dependent on free-model availability.

## 6.4 Provider recommendation

Benchmark **one current low-cost OpenAI model and one current Gemini
Flash-class model** using identical research packages and an identical
evaluation rubric. Use Claude as an additional comparison only if the
first two are insufficient or editorial quality warrants it.

Select the lowest-cost model that meets acceptance thresholds. Do not
choose a model solely because its advertised token price is lowest.

The selected model must be configured, not hardcoded throughout the
application. Use a provider abstraction so the model can be changed
without redesigning the domain workflow.

## 6.5 AI agents versus controlled workflows

An AI model generates or evaluates content. An agent uses a model to
select actions, call tools, and potentially repeat steps. A workflow is
a sequence of stages controlled by the application.

Three options were considered:

1.  **Single-model workflow:** One or a small number of model calls
    inside a conventional backend pipeline. Low complexity, predictable
    control, straightforward debugging. Best starting point.
2.  **Specialised model stages:** Separate calls for story selection,
    candidate generation, and editorial critique. Better separation and
    observability, but more calls and failure opportunities. Adopt where
    evaluation shows a quality benefit.
3.  **Autonomous multi-agent system:** Several agents research, debate,
    critique, and choose follow-up actions. More complex orchestration,
    harder debugging, and potentially greater token use. Defer until
    evidence shows fixed stages cannot satisfy requirements.

Do not introduce LangGraph or another agent framework merely because the
project involves AI. A framework is not a substitute for reliable state
management, validation, and permission controls.

Tool/function calling may be used for narrow, controlled operations,
preferably read-only at first---for example, retrieving verified event
data or searching approved candidate stories. Never give the model
unrestricted authority to publish content, alter production
configuration, or bypass approval.

## 6.6 Recommended generation workflow

### Stage 1 --- Build a research package

Backend source adapters retrieve and normalise information. The package
includes event/player identifiers, verified results and ratings, source
URLs, retrieval times, historical records, potential story candidates,
claim IDs, verification states, and unresolved conflicts.

The model must not independently browse and decide that arbitrary claims
are true. Any browsing/search capability added later must still produce
evidence that passes source and claim validation.

### Stage 2 --- Deterministic verification

Before generation, validate source identity, timestamps, result
consistency, arithmetic, required fields, and provenance. If a critical
fact cannot be verified, block or defer the opportunity.

### Stage 3 --- Story selection

Provide a compact evidence package and ask the model to rank potential
angles by: - Relevance to chess enthusiasts. - Timeliness. -
Significance. - Novelty compared with recent XLChess posts. - Strength
of available evidence. - Fit with the configured post type and channel.

The model should explain why an angle was chosen, but hard requirements
such as source availability and deduplication must be enforced in code.

### Stage 4 --- Generate three candidates

Generate three meaningfully different approaches, for example:

-   **A --- Factual/informative:** clear reporting and useful context.
-   **B --- Narrative/headline-led:** compelling framing without
    misleading claims.
-   **C --- Engagement-oriented:** a relevant question, comparison, or
    discussion prompt.

These are different editorial approaches, not merely minor wording
changes. All candidates must use the same verified evidence and meet the
same content rules.

Each candidate should contain: - Headline. - Caption. - Factual claims
with evidence/claim IDs. - Suggested visual template. - Image-selection
instructions. - Channel-specific variants where required. - Any required
attribution or disclaimer.

### Stage 5 --- Editorial verification

First run deterministic checks: - Referenced claim IDs exist. - Rating
values match the source records. - Dates and scores are consistent. -
The topic/angle is not a duplicate. - Captions meet platform
constraints. - Required attribution is present. - The output schema is
valid.

An editorial model may flag misleading framing, unsupported
implications, ambiguous wording, or weak differentiation between
candidates. Treat this as an additional check, not an independent source
of truth. Multiple calls to the same model can make correlated mistakes.

If a critical fact cannot be verified, reject or defer the candidate
rather than retrying indefinitely.

### Stage 6 --- Graphic rendering and human review

Use a deterministic renderer to compose licensed original photos,
typography, flags, statistics, and approved decorative assets. Present
the three candidate packages to a human. Approval is bound to an exact
content revision and asset set.

## 6.7 How many model calls?

Trade-offs:

  -----------------------------------------------------------------------
  Strategy                Benefits                Drawbacks
  ----------------------- ----------------------- -----------------------
  One call generates all  Low complexity and      Candidates may be
  three candidates        potentially lower cost  repetitive;
                                                  regeneration is less
                                                  isolated

  One call selects the    Clear separation        More API calls
  angle, another          between editorial       
  generates candidates    choice and writing      

  Separate call per       Independent generation  Repeats context and may
  candidate               and easy regeneration   cost more

  Separate critique call  Can catch editorial     Adds cost and can
                          weaknesses              create false positives
  -----------------------------------------------------------------------

Recommended baseline: **two main generation calls per posting
opportunity**: 1. Select the story angle from verified research. 2.
Generate all three candidate versions from the selected angle.

Run deterministic validation afterwards. Use an additional critique call
conditionally for high-impact stories, contentious claims, or candidates
that fail initial checks. The exact call strategy should be selected
using measured quality and cost.

Do not create an endless self-critique loop. Set a retry limit and send
unresolved cases to human review.

## 6.8 Structured output and schema validation

Use provider-supported structured outputs or equivalent constrained JSON
generation, then validate the returned data in TypeScript using Zod or
JSON Schema. Valid JSON does not prove factual correctness.

Illustrative output shape:

``` json
{
  "postType": "1.1",
  "angle": "Championship rating comparison",
  "candidates": [
    {
      "version": "A",
      "headline": "Championship Preview",
      "caption": "Example caption...",
      "claims": ["claim-001", "claim-002"],
      "visualTemplate": "player-versus"
    }
  ]
}
```

This is a partial example only. The production schema must require three
candidates per generation cycle and include source/claim references,
channel variants, visual requirements, and validation results.

Reject unknown or malformed fields where appropriate. Do not blindly
trust model-provided source URLs or IDs: resolve all references against
records already stored by the application.

## 6.9 Provider abstraction

Avoid scattering provider-specific SDK calls throughout the codebase.
Keep the model behind a small interface.

Illustrative interface:

``` ts
export interface ContentModel {
  selectStory(input: StorySelectionInput): Promise<StorySelection>;
  generateCandidates(input: CandidateGenerationInput): Promise<CandidateSet>;
  critiqueCandidate(input: CandidateReviewInput): Promise<CandidateReview>;
}
```

Provider configuration may be environment-driven:

``` ts
export const aiConfig = {
  provider: process.env.AI_PROVIDER,
  primaryModel: process.env.AI_PRIMARY_MODEL,
  fallbackModel: process.env.AI_FALLBACK_MODEL,
  maxRetries: 2,
  maxCandidates: 3
};
```

Validate environment variables at application startup. Enforce candidate
count and retry policy in code. A fallback model should not be used
automatically if it fails the task's quality requirements. Record
provider errors, retry according to policy, and hold unresolved work for
review.

## 6.10 Benchmark before committing

Build an evaluation set of approximately 30--50 realistic XLChess
posting opportunities, including: - World Championship previews. -
Completed game results. - Rating changes. - Chess news with conflicting
sources. - Stories with insufficient evidence. - Topics already covered
in recent posts.

Run the same research packages and generation requirements through at
least two candidate models. Score outputs using a consistent rubric:

  -----------------------------------------------------------------------
  Metric                              Measurement
  ----------------------------------- -----------------------------------
  Factual accuracy                    Are factual claims supported by
                                      evidence?

  Editorial quality                   Is writing clear, natural, and
                                      compelling?

  Candidate diversity                 Are the three versions meaningfully
                                      different?

  Instruction adherence               Does output follow post-type rules?

  Regeneration rate                   How often is another call required?

  Cost per accepted post              Total model cost divided by
                                      accepted posting opportunities

  Latency                             Time from request to usable
                                      candidates
  -----------------------------------------------------------------------

Factual accuracy is a pass/fail gate; it must not be compensated for by
a high writing score. Prefer blinded human evaluation where practical.

## 6.11 What not to do in V1

-   No fine-tuning before prompt, evidence, schema, and template
    improvements have been evaluated.
-   No autonomous multi-agent system at the outset.
-   No dependency on free-tier API capacity for production.
-   No LLM-only fact checking.
-   No AI-generated replacements for real player photographs.
-   No model-controlled publication.
-   No unlimited retries or self-critique loops.
-   No assumptions that a ChatGPT subscription includes API credits.
-   No production decision based only on advertised token prices.

------------------------------------------------------------------------

# 7. AI cost model and budget controls

## 7.1 Illustrative workload

Assume: - 5 posting opportunities per day. - 30 days per month. - 150
posting opportunities per month. - 8,000 input tokens and 3,000 output
tokens per opportunity, including candidate generation and an editorial
pass.

Monthly usage under this assumption: - Input: 1.2 million tokens. -
Output: 450,000 tokens.

This is an estimate, not a measured workload. Actual token counts depend
on research-package size, prompt design, candidate count, retries, and
whether context is repeated across calls.

## 7.2 Illustrative pricing arithmetic

Previous research used these example API rates to demonstrate the
calculation:

  ------------------------------------------------------------------------
  Example               Input per 1M      Output per 1M   Approximate cost
  model/version               tokens             tokens    for the assumed
                                                                     month
  --------------- ------------------ ------------------ ------------------
  GPT-5 nano                  \$0.05             \$0.40             \$0.24
  (historical                                           
  pricing                                               
  example)                                              

  GPT-5 mini                  \$0.25             \$2.00             \$1.20
  (historical                                           
  pricing                                               
  example)                                              

  GPT-4.1 mini                \$0.40             \$1.60             \$1.20
  (historical                                           
  pricing                                               
  example)                                              
  ------------------------------------------------------------------------

These model versions were identified as deprecated in the prior
research. **Do not use this table as a current pricing quote or as a
recommendation to deploy those versions.** Recheck current model
availability and official prices before implementation. The purpose of
the table is to show the arithmetic:

`monthly_cost = (input_tokens / 1_000_000 * input_price) + (output_tokens / 1_000_000 * output_price)`

At this workload, text generation may cost only a few dollars per month
with an efficient model, but the actual amount must be measured.
Research/search services, image licensing, hosting, retries, storage,
and social platform access may cost more than text inference.

## 7.3 Cost controls

-   Track input/output tokens and provider-reported costs for every job.
-   Track cost per candidate set and cost per accepted post.
-   Set monthly spend limits and alerts where supported.
-   Cache reusable data and avoid repeating the same research in
    multiple calls.
-   Keep research packages concise but sufficient for evidence.
-   Use lower-cost models for straightforward tasks when evaluation
    supports it.
-   Reserve stronger models for difficult stories or quality failures.
-   Generate graphics deterministically rather than regenerating entire
    posters with AI.
-   Reuse assets only when licence terms allow it.
-   Limit retries and critique calls.
-   Review model usage and cost periodically.

A post that costs little to generate but needs extensive human
correction is not cost-effective. Optimise for **cost per acceptable
post and human review time**, not only token price.

------------------------------------------------------------------------

# 8. Image sourcing, licensing, and graphic generation

This is a core part of SMB, not an optional cosmetic step. The goal is
to find genuine, legally usable photographs and compose professional
graphics.

## 8.1 Candidate image sources

  -----------------------------------------------------------------------------------------------
  ID                Source            Intended use      Reference
  ----------------- ----------------- ----------------- -----------------------------------------
  `I1`              Wikimedia Commons Real players,     https://commons.wikimedia.org/
                                      tournaments, and  
                                      venues            

  `I2`              Flickr Creative   Additional        https://www.flickr.com/creativecommons/
                    Commons           licensed          
                                      player/event      
                                      photos            

  `I3`              Unsplash          Generic chess     https://unsplash.com/
                                      backgrounds and   
                                      supporting        
                                      photography       

  `I4`              Pexels            Generic chess     https://www.pexels.com/
                                      imagery and       
                                      visual elements   
  -----------------------------------------------------------------------------------------------

For real player photographs, prioritise Wikimedia Commons and then
individually verified Flickr photographs. Unsplash and Pexels are
primarily fallbacks for generic imagery. Their presence in this list
does not establish that every image on those sites is suitable for every
commercial use.

## 8.2 Licence verification

Every photograph must be verified individually. Record at least: -
Original image URL and source page. - Photographer/copyright holder
where identified. - Licence type and version. - Whether commercial use
is permitted. - Whether the intended modifications are permitted. -
Attribution requirements. - Licence URL and verification timestamp. -
Share-alike or other obligations. - A copy or durable record of licence
evidence where legally and operationally appropriate.

A photograph being viewable or downloadable from a free site does not
automatically grant XLChess the rights it needs.

Reject images with non-commercial restrictions for promotional use
unless separate permission is obtained. Assess no-derivatives and other
restrictions against the intended transformations. If rights cannot be
established, reject the image and choose another.

The developer must verify current terms and access methods before
implementing automated retrieval. Do not assume an image-search API
grants rights to the returned image.

## 8.3 Preserve original photographs

**Original player photographs must remain visually unchanged by
generative AI.**

Permitted deterministic operations: - Crop. - Resize. - Rotate. -
Position. - Place within a frame. - Arrange with other design elements.

Prohibited transformations: - AI reconstruction or replacement of
faces. - Retouching. - Changing facial expressions. - Changing clothing
or hair. - Recolouring the photograph. - Generatively replacing or
altering portions of a photograph. - Sending the complete finished
poster through a generative model if that could redraw people.

Use the original image as an asset in a deterministic compositor. Keep
the source asset, its hash, and transformation/crop metadata. Do not
claim the final image is pixel-identical after resizing or encoding;
instead, make transformations auditable and restricted to approved
operations.

## 8.4 Separate image discovery from composition

**Image selection** searches, verifies licence evidence, evaluates
resolution and composition, and chooses candidates.

**Graphic composition** combines selected photographs with backgrounds,
typography, flags, ratings, statistics, and other visual elements.

This separation allows real photographs to be used without changing them
and permits a template to be tested independently of image discovery.

## 8.5 Initial templates

Create reusable templates for: 1. Player vs Player. 2. Upcoming
Tournament. 3. Tournament Result. 4. Player Ranking. 5. Rating Movement.
6. Chess Puzzle. 7. Chess News. 8. XLChess Product Update.

Templates should define layout regions, typography, colours, image
placement, and supported aspect ratios. They must adapt to different
text lengths and image dimensions without breaking the design.

## 8.6 World Championship trial reference

The previous trial involved Gukesh and Sindarov. Its design concept used
two real player photographs, a neutral grey background, player names,
national flags, classical ratings, a prominent "VS", a strong headline,
and championship context.

The intended story angle was whether a challenger could defeat the World
Champion after a significant rating decline. Any ratings and decline
figures must be recalculated from comparable, published FIDE classical
rating data at generation time.

The original Gukesh--Sindarov trial artwork and supplied photos are the
design reference if they are available in the project materials. Do not
invent or claim to have access to files that are not present.

## 8.7 Recommended rendering technology

-   HTML/CSS or SVG templates for layout.
-   Sharp for resizing, cropping, and compositing.
-   A server-side renderer such as Playwright for HTML-template
    rendering where useful.
-   AI for concept selection, layout suggestions, and captions.
-   Deterministic rendering for final photographs, flags, factual text,
    and statistics.

This is preferable to asking an image-generation model to produce the
entire poster because it preserves precise control over photographs and
factual text. AI-generated backgrounds or decorative assets can be
considered later, provided they do not alter real photographs or create
misleading evidence.

------------------------------------------------------------------------

# 9. Human review and approval

V1 requires a human approval gate. The reviewer should receive a
complete package rather than an unfinished idea.

## 9.1 Review package

Each package should include: - Three candidate versions. - Preview
graphics. - Channel-specific captions and previews. - Intended channels
and schedule. - Source references and evidence supporting claims. -
Image source and licence information. - Suggested graphic template. -
Validation status and any warnings. - Revision history. - Estimated
publication time.

## 9.2 Review actions

  Action             Expected behaviour
  ------------------ -------------------------------------------------------
  Approve            Approve a specific candidate revision for publication
  Edit               Change text, layout, or selected imagery
  Regenerate         Create new candidates using feedback
  Reject             Reject the posting opportunity
  Defer              Hold it until later
  Request research   Return it for additional verification

Approval must bind to an exact content revision and asset set. Any
meaningful caption or image change after approval invalidates the
approval unless it is an explicitly permitted non-content
transformation. The system must not silently publish a different
revision from the one approved.

## 9.3 Review interface

The eventual review UI should provide: - A queue of posts awaiting
review. - Previews for X, Facebook, Instagram, and Discord. - Three
candidates side by side for comparison. - Evidence/source links. - Image
licence and attribution details. - Editing controls. - Regeneration
instructions. - Approve, reject, and defer actions. - Scheduled
publication time. - Publication history.

A minimal review mechanism may be sufficient for the first vertical
slice, but approval state and auditability must be implemented from the
beginning.

## 9.4 Learning from corrections

Record edits and distinguish: - Factual corrections. - Style/tone
changes. - Headline changes. - Image replacements. - Layout changes. -
Formatting changes. - Rejections and reasons. - Regeneration requests.

Initially, use feedback to improve prompts, configuration, and
templates. Model fine-tuning is not required for V1. Measure the
unedited-approval rate, recurring correction types, rejection rate,
regeneration rate, and review time.

------------------------------------------------------------------------

# 10. Publishing and channel integration

Target channels: - **X:** short captions, images, links, event
updates. - **Facebook:** images, longer descriptions, community posts. -
**Instagram:** visual-first posts and captions. - **Discord:** community
announcements, images, discussion.

Verify current official API capabilities, permissions, account
eligibility, rate limits, media constraints, and publishing requirements
for each platform. Do not assume identical capabilities across channels.

## 10.1 Publisher interface

Illustrative TypeScript interface:

``` ts
interface SocialPublisher {
  channel: string;
  validate(post: ApprovedPost): Promise<ValidationResult>;
  publish(post: ApprovedPost): Promise<PublishResult>;
  getStatus(id: string): Promise<PublicationStatus>;
}
```

Each platform adapter should handle its own authentication, media
upload, formatting, rate limits, errors, and status responses.

## 10.2 Publishing safeguards

Before publication, verify: - The post has valid approval. - The
approved content revision and asset set have not changed. - Required
media exists. - Rights and attribution requirements are satisfied. - The
content meets the channel's constraints. - The post has not already been
published. - The scheduled time or approved immediate-publish
instruction is valid.

Persist the platform's returned publication identifier and URL.

A timeout does not prove publication failed. Before retrying, check
whether the platform accepted the first request. A failure on Instagram
must not cause approved content to be regenerated or published again to
X.

## 10.3 Rollout

Start with **X only**. Prove the full workflow, then add Facebook,
Instagram, and Discord using the same core pipeline and channel-specific
adapters.

------------------------------------------------------------------------

# 11. Recommended technical direction

This is a provisional recommendation to evaluate, not an assumption
about existing infrastructure.

  -----------------------------------------------------------------------
  Component               Initial recommendation  Reason
  ----------------------- ----------------------- -----------------------
  Language                TypeScript              Shared types and
                                                  explicit contracts

  Backend                 Node.js; Express or     Fits asynchronous I/O
                          another familiar        and provider SDKs
                          lightweight framework   

  Database                PostgreSQL              Relational workflow
                                                  state, constraints,
                                                  history

  Admin/review UI         React or Next.js        Review and
                                                  configuration interface

  AI integration          Provider-independent    Switch models without
                          model adapter           changing business logic

  Background work         Database-backed jobs    Avoid unnecessary
                          initially               infrastructure at low
                                                  volume

  Scheduling              Cron or managed         Fixed schedules and
                          scheduler               periodic polling

  Event processing        Idempotent event        Reliable
                          handler                 game-completion
                                                  triggers

  Validation              Zod or JSON Schema      Validate config and
                                                  model outputs

  Image processing        Sharp                   Deterministic image
                                                  transformations

  Graphics                SVG/HTML/CSS +          Reusable, exact layouts
                          Playwright where useful 

  Storage                 S3-compatible or        Original images and
                          existing suitable       generated assets
                          object storage          

  Monitoring              Structured logs,        Debugging and
                          metrics, and alerts     operational visibility
  -----------------------------------------------------------------------

Reuse suitable XLChess infrastructure if available, but inspect it
before deciding. If a suitable PostgreSQL/Supabase setup already exists,
it may be reasonable to reuse it. No SMB infrastructure is confirmed in
this brief.

Do not add Redis, a separate broker, multiple microservices, or a
workflow engine unless actual reliability or workload requirements
justify them. Explain both the operational benefit and recurring cost
before adding a service.

## 11.1 Suggested logical architecture

1.  **SMB Admin & Review Interface**
2.  **SMB Backend / Orchestrator**
3.  **Source Adapters**
4.  **Research & Verification**
5.  **AI Content Service**
6.  **Image Search, Licensing & Rendering**
7.  **Scheduler and Background Workers**
8.  **PostgreSQL, Asset Storage, and Job Records**
9.  **Channel Publishing Adapters**
10. **Monitoring and Cost Tracking**

The orchestrator manages workflow state and invokes services. It should
not contain provider-specific scraping, graphic-rendering, or
platform-publishing logic.

## 11.2 Suggested repository layout

The exact project structure is a decision for implementation planning
after inspecting the working directory. A possible logical layout is:

``` text
smb/
  config/
    post-types/
    sources/
    channels/

  src/
    core/
      orchestrator/
      scheduler/
      events/
      workflow/
      validation/

    sources/
      fide/
      chesscom/
      lichess/
      twic/
      chessbase/

    research/
      normalisation/
      verification/
      story-selection/

    generation/
      providers/
      prompts/
      content/
      candidate-generation/

    images/
      search/
      licensing/
      selection/
      composition/
      templates/

    review/
      approvals/
      revisions/
      feedback/

    publishing/
      x/
      facebook/
      instagram/
      discord/

    database/
    workers/
    monitoring/

  tests/
    unit/
    integration/
    end-to-end/
    fixtures/
```

This is a conceptual illustration, not a mandate to use these exact
directories. Adapt it to the project's size and chosen framework. Keep
modules cohesive and avoid premature microservices.

------------------------------------------------------------------------

# 12. Data model requirements

The database must support the full content lifecycle, not merely store
captions.

Recommended logical entities/tables:

  -----------------------------------------------------------------------
  Entity/table                        Purpose
  ----------------------------------- -----------------------------------
  `post_types`                        Post-type identifiers and metadata

  `post_configs`                      Versioned configurations and
                                      schedule rules

  `data_sources`                      Approved information-source
                                      registry

  `source_records`                    Retrieved information and
                                      provenance

  `research_packages`                 Verified evidence for a posting
                                      opportunity

  `claims` or equivalent              Individual factual claims and
                                      supporting evidence

  `post_opportunities`                Scheduled or triggered work

  `post_candidates`                   Generated versions

  `post_revisions`                    Immutable or auditable content
                                      revisions

  `media_assets`                      Original and generated images

  `media_licenses`                    Licence evidence and restrictions

  `review_actions`                    Approvals, edits, rejections,
                                      deferrals, feedback

  `publications`                      Channel-specific attempts and
                                      outcomes

  `jobs`                              Background tasks, retries, and
                                      failures

  `post_metrics`                      Quality and performance
                                      measurements
  -----------------------------------------------------------------------

Expected relationships: - One posting opportunity may have one or more
research packages. - A generation cycle normally creates three
candidates. - A candidate may have multiple revisions. - A specific
approved revision may be published to multiple channels. - Each channel
publication has its own status and provider ID. - Every generated asset
links to its original source, licence record, and transformations. -
Every factual claim links to supporting source records and verification
status. - Every approval links to the exact revision and media asset set
approved.

Use stable identifiers, timestamps, and version numbers. Define
retention and deletion policies for downloaded images, source data, and
generated media.

------------------------------------------------------------------------

# 13. Scheduling and event processing

SMB must support three trigger types:

  Trigger          Example
  ---------------- ----------------------------------------------
  Fixed schedule   Every Friday at 09:00 UTC
  Event-driven     A World Championship game completes
  Manual           An administrator requests an additional post

Every trigger should create a common posting-opportunity record.
Downstream services should not need to know whether the opportunity
originated from a schedule, event, or manual action.

## 13.1 Scheduler requirements

-   Store schedules with explicit timezone information.
-   Calculate next execution correctly.
-   Handle daylight-saving changes where relevant.
-   Prevent duplicate executions.
-   Recover from missed executions after downtime.
-   Respect enabled/disabled status.
-   Support temporary suspension of recurring schedules.
-   Log when and why each job was created.

## 13.2 Event detection

Use provider notifications when available and authorised; otherwise poll
at a configured interval. Respect rate limits and avoid unnecessary
requests.

Normalise detected events and compare them against previously processed
events. Use idempotency keys and database constraints, not just
in-memory checks.

## 13.3 Suggested job states

Possible lifecycle:

`PENDING -> RESEARCHING -> VERIFIED -> GENERATING -> VALIDATING -> RENDERING -> AWAITING_REVIEW -> APPROVED -> SCHEDULED -> PUBLISHING -> PUBLISHED`

Additional states may include `REJECTED`, `DEFERRED`, `FAILED`,
`NEEDS_RESEARCH`, and `CANCELLED`.

Define permitted transitions centrally. A failed stage should not force
unnecessary re-execution of successful stages. For example, an Instagram
failure should not regenerate the research or republish to X.

------------------------------------------------------------------------

# 14. Testing requirements

## 14.1 Unit tests

Cover: - Configuration/schema validation. - Schedule calculations and
timezone handling. - Championship phase detection. - Rating and score
calculations. - Claim/evidence resolution. - Content schema
validation. - Duplicate prevention and idempotency keys. - Approval
invalidation after edits. - Publication-state transitions. - Retry
limits.

## 14.2 Integration tests

Test source adapters with recorded fixtures or provider sandbox data,
research-package construction, database persistence, image rendering,
storage, and publishing adapters with mocked responses. Do not make
routine test suites depend on live APIs.

## 14.3 End-to-end tests

Test the complete path:

`Trigger -> Research -> Verify -> Generate -> Validate -> Render -> Review -> Approve -> Publish`

Also test: - Rejection and regeneration. - Source outages. - Licence
failures. - Invalid or conflicting data. - Provider rate limits and
timeouts. - Partial channel-publication failures. - A timeout where the
first publish may have succeeded. - Recovery after worker or application
downtime. - Result correction after content generation. - Attempts to
publish without approval. - Attempts to publish a revision different
from the approved one.

## 14.4 Image integrity tests

Keep the original image file and hash. Store
crop/resize/rotation/compositing parameters. Ensure no generative image
transformation is applied to player photographs. Test that the pipeline
uses the original asset and only applies the permitted deterministic
operations.

## 14.5 AI evaluation tests

Maintain a regression set of representative research packages and
expected constraints. Evaluate factual support, instruction adherence,
candidate diversity, tone, and schema validity whenever prompts or
models change. Human review remains required for production V1.

------------------------------------------------------------------------

# 15. Security and permissions

-   Store provider credentials in a secret manager or secure environment
    configuration.
-   Use least-privilege credentials and separate
    development/test/production environments.
-   Never place secrets in source control, client bundles, prompts, or
    logs.
-   Restrict approval actions to authorised reviewers.
-   Restrict production social credentials to the publishing service.
-   Treat retrieved pages, article text, image metadata, and model
    output as untrusted input.
-   Validate model output before database writes or external side
    effects.
-   Enforce approval and publication permissions in the backend, not
    only in the UI.
-   Log approval, revision, and publishing actions for audit.
-   Use dry-run/sandbox publishing until the approval and verification
    process is tested.
-   Review each external provider's data retention and training terms
    before sending content.
-   Avoid sending personal or confidential data to a model unless
    required and permitted.

------------------------------------------------------------------------

# 16. Monitoring and performance metrics

## 16.1 Operational metrics

Track: - Posting opportunities created. - Jobs completed and failed. -
Research failures and source freshness. - Generation latency and
failures. - Review queue size and age. - Publishing success by
channel. - Duplicate jobs prevented. - Retries and rate-limit
responses. - Asset/licence failures. - Cost per job and provider.

## 16.2 Quality metrics

Primary quality metric: **unedited approval rate** --- the proportion of
original generated posts approved without edits.

Long-term milestone: **10 consecutive days** with all required original
posts approved without modification, measured against an explicitly
defined daily volume.

Also track: - Average review time. - Regeneration rate. - Factual
correction rate. - Image replacement rate. - Rejection rate. - Cost per
approved post. - Publication success rate. - Quality by post type,
channel, and model.

Do not improve the headline metric by excluding difficult posts,
rejected posts, or days with failures. Define the denominator before
measuring.

------------------------------------------------------------------------

# 17. Development plan

## Phase 1 --- Understand and design

-   Inspect the actual repository/environment.
-   Confirm the final list of post types and identifiers.
-   Define schemas, interfaces, workflow states, and database
    relationships.
-   Compare current provider prices and terms.
-   Define a small end-to-end implementation plan.

**Deliverable:** approved technical design and implementation plan.

## Phase 2 --- Data collection

-   Create source registry.
-   Implement one approved source adapter.
-   Normalise records and preserve provenance.
-   Build verified research packages.
-   Add fixture-based tests.

**Deliverable:** working research pipeline.

## Phase 3 --- AI content generation

-   Implement provider abstraction.
-   Build story selection and three-candidate generation.
-   Add structured output validation.
-   Add claim/evidence references and deterministic checks.
-   Create initial model evaluation set.

**Deliverable:** three factually grounded candidates generated from real
research.

## Phase 4 --- Image pipeline

-   Implement image discovery and licence records.
-   Store source assets and provenance.
-   Build deterministic templates and rendering.
-   Recreate the World Championship trial where source artwork/photos
    are available, without generative alteration of photos.

**Deliverable:** publication-ready graphic with traceable source and
licence records.

## Phase 5 --- Review interface

-   Compare candidates.
-   Edit, regenerate, reject, and defer.
-   Approve a specific revision and asset set.
-   Record feedback and history.

**Deliverable:** a reviewer can move a generated post to an approved
revision.

## Phase 6 --- X publishing

-   Integrate official X publishing capabilities.
-   Handle authentication, media upload, validation, idempotency,
    scheduling, and publication status.
-   Start in dry-run/sandbox mode where possible.

**Deliverable:** first approved post successfully published and
recorded.

## Phase 7 --- Full automation

-   Add recurring scheduling.
-   Add game-completion detection.
-   Implement phase transitions, deduplication, retries, and recovery.
-   Track recent content to avoid repetition.

**Deliverable:** automatic generation without manual topic selection.

## Phase 8 --- Expand and improve

-   Add more post types and templates.
-   Add Facebook, Instagram, and Discord through adapters.
-   Improve prompts and templates using reviewer feedback.
-   Monitor progress toward five review-ready posts daily and the
    unedited-approval target.

**Deliverable:** repeatable, economical content production with measured
quality.

------------------------------------------------------------------------

# 18. Acceptance criteria for V1

V1 is accepted when the following can be demonstrated and tested:

1.  A post-type configuration can be validated and enabled/disabled.
2.  A posting opportunity can be created from a fixed schedule, event,
    or manual trigger.
3.  At least one approved data source can be queried through an adapter.
4.  Retrieved information is normalised and stored with source
    provenance and timestamps.
5.  A research package is produced for the World Championship reference
    post type.
6.  Critical numerical facts are computed in code and traceable to
    evidence.
7.  The AI produces three meaningfully different candidates in a
    validated schema.
8.  Candidate factual claims reference known evidence IDs.
9.  Unsupported critical claims are blocked or flagged for review.
10. An image asset can be selected with recorded source and licence
    evidence.
11. A graphic can be rendered using original photos and deterministic
    operations.
12. The reviewer can inspect, edit, regenerate, reject, defer, and
    approve content.
13. Approval is bound to an exact content revision and asset set.
14. Publishing cannot occur without valid approval.
15. An approved post can be published to X and its provider
    ID/URL/status recorded.
16. Duplicate event processing and duplicate publication are prevented.
17. Retries and partial failures do not cause duplicate posts or repeat
    completed work unnecessarily.
18. Automated tests cover critical logic and the end-to-end workflow.
19. API usage and cost per post can be measured.
20. Setup, configuration, secrets, testing, deployment, and adding new
    post types are documented.

------------------------------------------------------------------------

# 19. Developer handover requirements

The developer handover should include: - Source code. - Database
migrations and schema documentation. - Configuration schemas and
examples. - Source-adapter documentation. - AI provider and prompt
configuration. - Image licensing and rendering documentation. -
Review/approval workflow documentation. - Channel integration
instructions. - Setup and environment-variable instructions. - Automated
tests and how to run them. - Deployment and recovery procedures. -
Monitoring and cost controls. - Administrator guide. - Instructions for
adding a post type, data source, image template, and social channel. - A
list of external services that require paid plans, API approvals, or
ongoing manual account maintenance.

Identify any service requiring payment, special permission, or a paid
API tier before committing to it.

------------------------------------------------------------------------

# 20. Open decisions and risks

These must be resolved through repository/environment inspection or
explicit research; do not invent answers.

1.  **Final post-type catalogue:** The current brief says the
    consolidated hierarchy has 18 top-level types, but does not provide
    all 18 names and IDs.
2.  **Existing XLChess infrastructure:** Determine whether any database,
    hosting, object storage, authentication, or admin UI should be
    reused.
3.  **Source access:** Confirm the actual APIs/feeds and terms available
    for each proposed chess source.
4.  **Image access and rights:** Confirm permitted search/download
    methods and individual licence verification.
5.  **Model choice:** Benchmark current OpenAI and Gemini low-cost
    options using real evaluation cases.
6.  **Current pricing:** Verify model rates, free-tier limits, data
    handling, and model lifecycle status from official documentation.
7.  **Social publishing access:** Confirm X API tier, account
    permissions, current publishing constraints, and any recurring fees.
8.  **Review UI scope:** Decide whether the first vertical slice needs
    the full review UI or a minimal internal interface, while retaining
    proper approval-state enforcement.
9.  **Storage/retention:** Decide where originals, rendered assets, and
    licence evidence will live and how long they are retained.
10. **Metrics definition:** Define the exact denominator for the 10-day
    unedited-approval target.
11. **Human reviewer roles:** Confirm who can approve, edit, and manage
    configurations.
12. **Image design reference:** Confirm whether the original
    Gukesh--Sindarov trial artwork and photographs are available to the
    implementation environment.

------------------------------------------------------------------------

# 21. Final development direction

SMB should be built as an **automated content-production system**, not a
social-media scheduling tool.

The core challenge is coordinating: - Approved information retrieval. -
Reliable fact verification. - Interesting story selection. - Three
high-quality candidate posts. - Legally usable photographs. -
Professional, deterministic graphics. - Human review and revision
tracking. - Safe publishing and recovery. - Continuous quality and cost
measurement.

The first goal is one reliable end-to-end workflow. Extend it through
reusable components and configuration rather than building all
categories at once.

**Definition of success for V1:** A reviewer opens SMB and finds
approximately five complete, researched, visually finished social-media
posts ready for approval, without someone having manually researched the
topics, selected the photographs, calculated the statistics, or created
the graphics.

V2 should make those posts consistently good enough that the reviewer
rarely needs to change them. Keep human approval in place unless a
separate, explicit future requirement authorises a carefully controlled
change.

------------------------------------------------------------------------

# Appendix A --- Official documentation to verify during implementation

These are starting points for current verification. They are not a claim
that every model, price, feature, or endpoint remains unchanged.

## AI providers

-   OpenAI API pricing: https://developers.openai.com/api/docs/pricing
-   OpenAI Structured Outputs:
    https://developers.openai.com/api/docs/guides/structured-outputs
-   OpenAI API documentation: https://developers.openai.com/api/docs/
-   Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
-   Gemini structured output:
    https://ai.google.dev/gemini-api/docs/structured-output
-   Gemini function calling:
    https://ai.google.dev/gemini-api/docs/function-calling
-   Anthropic pricing:
    https://platform.claude.com/docs/en/about-claude/pricing
-   Anthropic API docs: https://docs.anthropic.com/
-   OpenRouter pricing: https://openrouter.ai/pricing
-   OpenRouter free models:
    https://openrouter.ai/collections/free-models/

## Chess information sources

-   FIDE: https://www.fide.com/
-   FIDE Ratings: https://ratings.fide.com/
-   Chess.com News: https://www.chess.com/news
-   Lichess Broadcasts: https://lichess.org/broadcast
-   The Week in Chess: https://theweekinchess.com/
-   ChessBase: https://en.chessbase.com/

## Image sources

-   Wikimedia Commons: https://commons.wikimedia.org/
-   Flickr Creative Commons: https://www.flickr.com/creativecommons/
-   Unsplash: https://unsplash.com/
-   Pexels: https://www.pexels.com/

## Required implementation caution

Before implementation, open the current official documentation and
verify: - The exact model identifier and lifecycle status. -
Input/output token pricing and any extra tool costs. - Structured-output
and tool-calling support for the chosen model. - Free-tier limits and
whether they are appropriate for testing only. - Data-use, retention,
and privacy terms. - Source API access, terms, and rate limits. - Image
licence terms for each asset. - Social publishing API requirements and
fees.

The technology decision should be based on tested quality, reliability,
legal suitability, and total cost---not on an outdated pricing
screenshot or a free-tier headline alone.
