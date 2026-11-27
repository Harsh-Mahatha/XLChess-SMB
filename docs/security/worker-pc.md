# Home-PC Worker Security Assessment & Windows 11 Migration Path

Audience: XLChess administrators and the home-PC owner.

## 1. What the PC holds

- **Device token:** Stored encrypted with Windows DPAPI (machine scope) in `C:\ProgramData\XLChessWorker\secrets\device-token.bin`. Readable only by the worker service account and local administrators.
- **Models, prompts, and outputs:** Local Ollama weights, ComfyUI workflows/checkpoints, job checkpoints, and temporary render outputs.
- **No social-media credentials, ever:** X OAuth keys and tokens remain exclusively on the SMB API host and never leave it.
- **No database or Storage keys:** The PC has no `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_SERVICE_ROLE_KEY`, or JWT signing secrets.

## 2. What the PC exposes

- **Nothing inbound:** The worker opens zero listening ports for external traffic.
- **Local-only model servers:** Ollama and ComfyUI bind to `127.0.0.1` only, and the installer creates Windows Firewall rules blocking inbound connections to their ports.
- **Outbound HTTPS only:** The worker makes outbound HTTPS calls exclusively to the SMB API (`/worker/v1/*`).
- **Least-privilege service account:** The Windows service runs under a virtual service account (`NT SERVICE\XLChessWorker`), not as `LocalSystem` or an interactive user.

## 3. If the PC is lost or compromised

1. Revoke the worker immediately in XLChess (`POST /v1/admin/workers/:id/revoke` with a reason). Any jobs currently leased to that PC are returned to the queue at once.
2. The stolen device token becomes useless immediately — every `/worker/v1/*` request returns `401 worker_revoked`.
3. **Worst-case impact before revocation:** An attacker holding a valid token could claim `gpu` lane jobs and submit generated or revised text. Every submission is still re-parsed and re-checked by the server against the verified research package (`recheckGeneration` / `recheckRevision`), cannot alter images or licences, and still requires human reviewer approval in XLChess before anything can be published.

## 4. Windows 10 end-of-support risk

- **Lifecycle facts:** Windows 10 reached end of support on **14 October 2025**, and the consumer Extended Security Updates (ESU) year ended on **13 October 2026**. A Windows 10 PC no longer receives OS security fixes (confirmable on Microsoft's Windows lifecycle page).
- **Risk:** Unpatched OS vulnerabilities on a machine that runs downloaded AI models and has outbound internet access.
- **Mitigations already in place:** No inbound exposure, localhost-only model servers with firewall blocks, `NT SERVICE\XLChessWorker` least-privilege account, zero social-media or database credentials on the PC, server-side content re-checking, and mandatory human approval before publishing.

## 5. Recommended migration path (in order)

1. **Check Windows 11 eligibility** using Microsoft's PC Health Check app (TPM 2.0, supported CPU, Secure Boot — an RTX 4070 PC from 2023 or later normally qualifies).
2. **Upgrade in place** through Windows Update to the current supported Windows 11 release. The worker installation and DPAPI machine-scoped secrets survive an in-place upgrade; afterwards run `repair-xlchess-worker.ps1 -Verify`.
3. **If the hardware is not eligible:** Perform a clean install of Windows 11 on supported hardware, run the worker installer again, and pair with a fresh pairing code. Unsupported Windows 11 bypass workarounds are not recommended.
4. **Until migrated:** Keep Windows Defender enabled, apply all final available Windows 10 updates, and do not use the worker PC for web browsing or installing unrelated software.

## 6. How the admin sees it

`GET /v1/admin/workers` exposes `osSupported: false` whenever a worker's reported OS string contains `Windows 10`, allowing XLChess admins to track migration status without making manual OS work part of ordinary SMB administration.
