# XLChess SMB

Backend for the XLChess Social Media Bot: REST API, scheduler, job queue, and the home-PC AI worker. The reviewer/admin UI lives in the XLChess codebase and calls this API.

Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Module specs: [docs/README.md](docs/README.md)

## Layout

| Path              | What                                                  |
| ----------------- | ----------------------------------------------------- |
| `apps/api`        | Express 5 API, scheduler, server-side job runner      |
| `apps/worker`     | Home-PC agent (claims GPU jobs, runs Ollama locally)  |
| `packages/shared` | Zod contracts shared by API and worker                |
| `config/`         | Versioned post-type, source and channel JSON          |
| `supabase/`       | SQL migrations (source of truth for the `smb` schema) |
| `installer/`      | PowerShell worker installer (Phase 3)                 |

## Getting started

```bash
npm install
cp .env.example .env      # then fill in values
npm run build
npm test
npm run dev:api           # http://localhost:4000/health
```

Database (needs Docker for the local Supabase stack):

```bash
npm run db:start          # local Supabase
npm run db:reset          # apply supabase/migrations
npm run db:pull           # prisma db pull + generate (never `prisma migrate`)
```

## Conventions

- Schema changes are SQL migrations in `supabase/migrations`; Prisma is a query client only.
- Publishing defaults to `dry_run`. `live` needs `SMB_ALLOW_LIVE_PUBLISH=true` plus an audited admin toggle.
- Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`.
