import { GPU_JOB_KINDS } from '@smb/shared';

/**
 * Home-PC worker entrypoint (placeholder). Real behaviour lands in Phase 3:
 * pair -> poll /worker/v1/jobs/claim over outbound HTTPS -> run Ollama (localhost only)
 * -> heartbeat -> complete. See docs/ARCHITECTURE.md section 6.
 */
process.stdout.write(`smb-worker skeleton; handles gpu job kinds: ${GPU_JOB_KINDS.join(', ')}\n`);
