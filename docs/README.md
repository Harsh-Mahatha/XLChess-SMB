# SMB sub-modules

Breakdown of **1. Social Media Bot (SMB)** into 23 sub-modules. Owner: Harsh Mahatha (Mon–Fri, 8h/day, from Mon 2 Nov 2026). Total: 875 EWU (L1: 8.75 days).

Each module file holds its scope and done-when, followed by the matching sections of `docs/DEVELOPMENT_GUIDE.md` and `docs/FEATURES.md`, copied unchanged.

| # | Module | Release | Est. hours | EWU | Est. date |
|---|---|---|---|---|---|
| 1.1 | [Architecture & implementation plan](1.01-architecture-and-implementation-plan.md) | V1 core | 4 | 25 | Mon 2 Nov 2026 |
| 1.2 | [Database schema & provenance](1.02-database-schema-and-provenance.md) | V1 core | 3 | 37.5 | Mon 2 Nov 2026 |
| 1.3 | [Post taxonomy & configuration](1.03-post-taxonomy-and-configuration.md) | V1 core | 3 | 25 | Tue 3 Nov 2026 |
| 1.4 | [Approved source registry & adapters](1.04-approved-source-registry-and-adapters.md) | V1 core | 3 | 62.5 | Tue 3 Nov 2026 |
| 1.5 | [Research packages & fact verification](1.05-research-packages-and-fact-verification.md) | V1 core | 3 | 50 | Tue 3 Nov 2026 |
| 1.6 | [Story selection & content deduplication](1.06-story-selection-and-content-deduplication.md) | V1 core | 3 | 25 | Wed 4 Nov 2026 |
| 1.7 | [AI prompts & three candidate posts](1.07-ai-prompts-and-three-candidate-posts.md) | V1 core | 3 | 50 | Wed 4 Nov 2026 |
| 1.8 | [Image discovery & licence checks](1.08-image-discovery-and-licence-checks.md) | V1 core | 3 | 37.5 | Thu 5 Nov 2026 |
| 1.9 | [Original photo integrity & asset storage](1.09-original-photo-integrity-and-asset-storage.md) | V1 core | 3 | 25 | Thu 5 Nov 2026 |
| 1.10 | [Graphics templates & rendering](1.10-graphics-templates-and-rendering.md) | V1 core | 3 | 75 | Thu 5 Nov 2026 |
| 1.11 | [Reviewer interface & approval](1.11-reviewer-interface-and-approval.md) | V1 core | 3 | 62.5 | Fri 6 Nov 2026 |
| 1.12 | [Revisions & feedback learning](1.12-revisions-and-feedback-learning.md) | V1 core | 3 | 25 | Fri 6 Nov 2026 |
| 1.13 | [X publishing & duplicate safeguards](1.13-x-publishing-and-duplicate-safeguards.md) | V1 core | 3 | 62.5 | Fri 6 Nov 2026 |
| 1.14 | [Scheduling & posting opportunities](1.14-scheduling-and-posting-opportunities.md) | V1 core | 3 | 25 | Mon 9 Nov 2026 |
| 1.15 | [World Championship lifecycle](1.15-world-championship-lifecycle.md) | V1 core | 3 | 25 | Mon 9 Nov 2026 |
| 1.16 | [Event detection & trigger ingestion](1.16-event-detection-and-trigger-ingestion.md) | V1 core | 3 | 25 | Tue 10 Nov 2026 |
| 1.17 | [Workflow orchestration & recovery](1.17-workflow-orchestration-and-recovery.md) | V1 core | 3 | 37.5 | Tue 10 Nov 2026 |
| 1.18 | [Security, permissions & dry-run](1.18-security-permissions-and-dry-run.md) | V1 core | 3 | 25 | Tue 10 Nov 2026 |
| 1.19 | [Monitoring, cost & quality KPIs](1.19-monitoring-cost-and-quality-kpis.md) | V1 core | 3 | 25 | Wed 11 Nov 2026 |
| 1.20 | [Unit/integration & failure testing](1.20-unit-integration-and-failure-testing.md) | V1 core | 3 | 50 | Wed 11 Nov 2026 |
| 1.21 | [Deployment & developer handover](1.21-deployment-and-developer-handover.md) | V1 core | 3 | 25 | Wed 11 Nov 2026 |
| 1.22 | [Additional post types (post-V1)](1.22-additional-post-types-post-v1.md) | Post-V1 expansion | 3 | 37.5 | Thu 12 Nov 2026 |
| 1.23 | [Facebook, Instagram & Discord (post-V1)](1.23-facebook-instagram-and-discord-post-v1.md) | Post-V1 expansion | 3 | 37.5 | Thu 12 Nov 2026 |

*Weekend Sat 7 Nov + Sun 8 Nov: 2 days off.*

## Open points

- **Home-PC worker not scoped.** The mandatory local AI worker (PowerShell installer, pairing, job leases, XLChess management screens — Development Guide 2.1) is not named in any module. It is attached to 1.1 ("worker boundaries") and 1.17 for now.
- **Five posts per day (1.22)** conflicts with the Development Guide's "no fixed daily post quota".
- **"15 V1 acceptance conditions" (1.20)** are not listed in either document.
- **FD section numbers** shown in the planning tool are not confirmed and have been left out; modules were mapped to guide sections by scope.
