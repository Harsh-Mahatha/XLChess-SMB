-- Module 1.17: workflow orchestration and recovery.

-- A job can fail for a reason a person can read, report progress and show a heartbeat. `job_scope` tells apart
-- jobs of the same kind for the same opportunity (one render per candidate, one rewrite per request).
alter table smb.jobs
  add column error_code   text,
  add column progress     jsonb,
  add column heartbeat_at timestamptz,
  add column job_scope    text not null default '';

-- At most one waiting or running job per opportunity, kind and scope: asking twice does not queue twice.
create unique index jobs_one_active on smb.jobs (opportunity_id, kind, job_scope)
  where status in ('queued', 'leased') and opportunity_id is not null;
create index jobs_by_status on smb.jobs (status, updated_at desc);

-- Research that runs again for the same job (a retry after a crash) finds the package the first run stored.
create index research_packages_job on smb.research_packages (job_id) where job_id is not null;

-- Where an opportunity stopped and why, so a retry resumes at that step and nowhere earlier.
alter table smb.post_opportunities
  add column failed_step    text,
  add column failure_reason text;
