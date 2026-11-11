# Home-PC Worker Installer — V1 Plan

Status: **Draft for review** · Date: 11 Nov 2026

This plan covers V1 of `installer/`: the scripts that turn the owner's home PC into a paired SMB worker. It is based on:
- the installer requirements in [1.21](devphases/1.21-deployment-and-developer-handover.md) (Development Guide 2.1)
- the worker boundary in [ARCHITECTURE.md §6](ARCHITECTURE.md)
- the model and execution choices in [SMB_Local_AI_Models_and_Sequential_Execution.md](../SMB_Local_AI_Models_and_Sequential_Execution.md) (the "models guide")

The models (Qwen3.5 9B, Z-Image-Turbo) and their file sizes are **confirmed**. Where ARCHITECTURE.md still says otherwise (Windows 10 only, Qwen3 8B, no image model), **this plan and the models guide take precedence**. ARCHITECTURE.md will be brought in line later (§9).

---

## 1. Goal and acceptance

The owner runs **one installer once**, types a pairing code, and the PC becomes a 24/7 worker. They never edit config, install Python or Docker, download models by hand, or open ports.

V1 is accepted when this sequence works on the real PC (the 1.21 demonstration):

> run one installer → pair the PC → receive a queued XLChess job → generate on the RTX 4070 (text with Qwen3.5 9B, then images with Z-Image-Turbo, one at a time) → return a complete result → review it in XLChess → recover after an interrupted job and after a PC restart

…and when the fallback in §7 restarts a stopped worker without a developer.

---

## 2. Decisions

| Area | Decision | Why |
|---|---|---|
| Installer language | **Windows PowerShell 5.1** (built into Windows), started by `install.cmd`. The wrapper bypasses the execution policy and asks for elevation. | Nothing to install first. PowerShell 7 isn't on a fresh PC. |
| OS | Windows 11, or Windows 10 22H2 (build 19045+) with a warning about end of support. 64-bit only. | The models guide says Windows 11; the architecture doc says Windows 10. Supporting both costs nothing. |
| Docker | **Not used.** Native install. | 1.21 makes Docker optional, and native is simpler for one GPU. |
| LLM runtime | **Ollama**, from the standalone `ollama-windows-amd64.zip`, not `OllamaSetup.exe` | The setup exe installs a per-user tray app that only starts at login. The zip lets the worker run `ollama serve` with no login. |
| LLM model | **`qwen3.5:9b`** at Ollama's default quantisation (Q4_K_M, roughly 6–7 GB) | Confirmed. Fits in 12 GB VRAM with a 16K context. Q8 (about 10 GB) leaves too little room for context. Pinned by digest in the manifest. |
| Image runtime | **ComfyUI Windows portable, NVIDIA build** (pinned release), with embedded Python. **No custom nodes and no ComfyUI-Manager.** | The owner never sees Python. Leaving out custom nodes avoids running third-party code on the PC. |
| Image model | **Z-Image-Turbo**: the Comfy-Org repackaged files used by ComfyUI's official Z-Image example. That's the diffusion model, the Qwen3-4B text encoder and the VAE, about 21 GB in total at bf16. | Confirmed. It is a trusted source that the pinned ComfyUI release supports without custom nodes. bf16 weights don't fully fit in 12 GB, so ComfyUI moves part of them to RAM (§10 checks the speed). |
| Image workflow | One API-format workflow file in the repo (`apps/worker/workflows/z-image-turbo.json`): 8 steps, CFG 1, 1024×1024. Prompt, seed and size are filled in by the worker. | The workflow is versioned with the code and doesn't depend on hand edits in a UI. |
| Composition (Sharp + SVG) | **Stays on the server**, as ARCHITECTURE §5 has it. The worker returns raw images. | Composition needs brand assets, licensed photos from Storage and exact text, all of which are server-side. It needs no GPU. The PC therefore doesn't need Sharp or Playwright. |
| Node.js | **Portable Node 22 LTS** (pinned zip) inside the install folder, not a system-wide install | Can't conflict with anything else on the PC. Updates are under our control. |
| Worker delivery | Shipped **inside the installer package** as one bundled `worker.js` (esbuild). It isn't fetched separately. | One download, and the worker can be installed and tested before pairing. |
| Process model | **One Windows service, `XLChessWorker`**, wrapped by **WinSW** (MIT, single exe). The worker **supervises Ollama and ComfyUI as child processes**. | One thing to keep alive. The worker controls exactly when each runtime runs, which the one-model-at-a-time rule needs. |
| Service account | Virtual account `NT SERVICE\XLChessWorker`. Fall back to `LocalSystem` only if CUDA fails under it in testing (§10). | Lowest privilege that should work. It needs checking on the real PC. |
| Sequential GPU use | Ollama stays running (it uses no VRAM with no model loaded). At the end of the LLM stage the worker unloads explicitly (`keep_alive: 0`) and checks `/api/ps` and `nvidia-smi`. **ComfyUI is started for the image stage and stopped afterwards**, so its VRAM is released by the process exiting. | Follows the models guide's §7 rules: don't assume a finished request has released VRAM. |
| Ollama settings | `OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=2m` (a safety net; the explicit unload is the main mechanism), `OLLAMA_MODELS=<data>\models\ollama` | Localhost only, one model, one request at a time. |
| ComfyUI settings | `--listen 127.0.0.1 --port 8188 --disable-auto-launch`, with output and temp folders under the data folder | Localhost only and headless. |
| Secrets | Device token encrypted with **DPAPI (LocalMachine scope)** in a file whose ACL allows only the service account and Administrators | No env file to edit. Revocable from XLChess. |
| Integrity | Every download is listed in **`manifest.json`** with URL, version and **SHA-256**. Hugging Face files are pinned to a commit. Ollama models are pinned to a digest. The installer refuses any file that doesn't match. | Protects against changed or tampered downloads. The manifest is the single place to change model versions. |
| Updates (V1) | Re-running a newer installer package **is** the update: every step is idempotent and data and models are kept. Self-update through `/worker/v1/config` "target version" comes later. | Keeps V1 small without blocking updates. |

---

## 3. Package and folders

**Installer package** (`xlchess-worker-<version>.zip`, built by `npm run installer:package`):

```text
install.cmd                    double-click entry: elevate, then run setup with -ExecutionPolicy Bypass
setup-xlchess-worker.ps1       the installer
diagnose-xlchess-worker.ps1    health report + support bundle
repair-xlchess-worker.ps1      restart / re-verify / re-download / re-pair
uninstall-xlchess-worker.ps1   remove everything (asks before deleting models)
lib/*.psm1                     shared functions (checks, downloads, service, power, pairing)
manifest.json                  pinned versions, URLs, SHA-256 of every download
worker/worker.js               bundled worker + workflows/z-image-turbo.json
tools/winsw.exe                service wrapper (pinned, hash-checked)
```

**On the PC:**

```text
C:\Program Files\XLChessWorker\          binaries (replaced on update)
  node\  worker\  ollama\  scripts\  winsw\
C:\ProgramData\XLChessWorker\            data (kept on update)
  config.json                            API URL, worker id, settings: no secrets
  secrets\device-token.bin               DPAPI-encrypted, restricted ACL
  state\install-state.json               step progress, for resume
  state\health.json                      written by the worker every 30 s, read by the watchdog
  checkpoints\                           per-job local checkpoints (ARCHITECTURE §6)
  comfyui\                               ComfyUI portable, models in comfyui\models\
  models\ollama\
  outputs\  logs\                        logs rotated, kept 14 days
```

`-DataPath D:\XLChessWorker` moves the data folder (and the models) to another drive, if the owner prefers.

---

## 4. Setup steps

Each step reads and writes `install-state.json`. It is skipped if already done and verified, and is safe to run again. Re-running the installer **is** the resume path. If a reboot is needed, the installer registers a `RunOnce` entry so setup continues after the next login.

| # | Step | Detail | On failure |
|---|---|---|---|
| 1 | **Preflight** | All checks in §5. Prints a pass/warn/fail table. `-CheckOnly` stops here. | Stop with the failing check and what to do about it. Nothing has been changed yet. |
| 2 | **Consent** | Lists what will be installed, the download and disk size (totals from the manifest) and the power changes. Owner confirms. | — |
| 3 | **Folders and ACLs** | Create §3 folders. Grant the service account the data folder. | Stop. |
| 4 | **Node + worker** | Unpack portable Node and `worker.js`. Run `node worker.js --version`. | Stop. |
| 5 | **Ollama** | Download the zip, check its hash, unpack. Start `ollama serve` temporarily with the §2 settings. | Retry the download 3 times, then stop. |
| 6 | **Qwen3.5 9B** | `ollama pull`, then compare the digest with the manifest. | Retry (a pull resumes), then stop. |
| 7 | **ComfyUI** | Download the portable release, check its hash, extract to `data\comfyui`. | Retry, then stop. |
| 8 | **Z-Image-Turbo** | Download the three model files into `comfyui\models\{diffusion_models,text_encoders,vae}`, resumable, with hash checks. | Retry, then stop. |
| 9 | **Local GPU self-test** | §6, part A. Works without the server. | Stop with the diagnostic. The models are kept, so a re-run only re-tests. |
| 10 | **Firewall** | Add inbound **block** rules for TCP 11434 and 8188. Add no allow rules. | Warn. |
| 11 | **Power** | §7, power settings. Only with consent; the old values are saved for uninstall. | Warn. |
| 12 | **Pairing** | Ask for the pairing code (admin creates it in XLChess, 10-minute TTL). `POST /worker/v1/pair`, then store the token (§2). The code is never logged. | Re-ask on a wrong or expired code. A network error stops with instructions. |
| 13 | **Service + watchdog** | Register `XLChessWorker` with WinSW, set failure actions, create the watchdog task and the Start menu shortcuts (§7). Start the service. | Stop. |
| 14 | **End-to-end test** | §6, part B, through the server. | Stop with the diagnostic. The service stays installed. |
| 15 | **Report** | Short summary on screen and in `logs\install-<date>.txt`: versions, timings, VRAM peaks, test results. | — |

---

## 5. Preflight checks

| Check | Pass | Warn | Fail |
|---|---|---|---|
| Elevation | Running as admin | — | Not admin (`install.cmd` normally prevents this) |
| OS | Windows 11, 64-bit | Windows 10 22H2 (end of support, see 1.21) | Older, or 32-bit |
| GPU | NVIDIA, ≥ 12 GB VRAM (`nvidia-smi --query-gpu=name,memory.total,driver_version`) | — | No NVIDIA GPU, `nvidia-smi` missing, or < 12 GB |
| Driver | ≥ the minimum for the pinned ComfyUI build's CUDA version (in the manifest; about R570 for CUDA 12.8) | — | Older: link to the NVIDIA driver download. The installer doesn't update drivers itself. |
| RAM | ≥ 64 GB | 16–63 GB (slower image stage, because of RAM offload) | < 16 GB |
| Disk (data drive) | Free space ≥ the manifest's total size + 10 GB. This is a sanity check only, since disk space isn't expected to be a constraint on this PC. | — | Less: suggest `-DataPath` |
| Network | Reaches the SMB API `/health`, and the download hosts in the manifest (ollama.com, github.com, huggingface.co, nodejs.org) over HTTPS | — | A host that can't be reached is named |
| Existing install | None, or an older version (becomes an update) | A partial install (resumes) | A newer version is installed |
| Ports | 11434 and 8188 free, or used by our own processes | — | Used by another program (for example, the owner's own Ollama): this program is named |
| Power | — | Sleep or hibernate on AC is enabled (fixed in step 11 with consent) | — |

---

## 6. Self-test

**Part A — local, before pairing** (proves the GPU path, and the one-model-at-a-time rule, on this PC):
1. Record VRAM used (`nvidia-smi`).
2. Ollama: one small prompt with a JSON-schema `format`. The output must parse. `/api/ps` must show the model with `size_vram > 0`, which proves the GPU was used rather than the CPU.
3. Unload (`keep_alive: 0`). Within 30 s, `/api/ps` must be empty and VRAM must be back within 500 MB of step 1.
4. ComfyUI: start it, wait for `/system_stats` (which must report the CUDA device), queue the workflow at 512×512, poll `/history`, and check that a PNG was written.
5. Stop ComfyUI. VRAM must be back within 500 MB of step 1.
6. Record load time, run time and peak VRAM for each model.

**Part B — end to end, after pairing.** Pairing queues one `worker_selftest` GPU job for the new worker. The service claims it like any job: it runs a short text stage, unloads, runs a short image stage, unloads, and completes the job with the result and metrics. The installer waits up to 10 minutes for the job to reach `done`. This tests claim → lease → heartbeat → complete through the real API.

---

## 7. Always-on operation and the restart fallback

The PC is meant to be on all the time. Four layers each catch what the layer before misses:

| Layer | What | Catches |
|---|---|---|
| 1. Service start | `XLChessWorker` starts automatically at boot, before anyone logs in | Reboots, Windows Update restarts, power cuts (if the BIOS powers back on, below) |
| 2. Service recovery | Failure actions: restart after 10 s, 30 s, then 60 s; the counter resets after 1 day. The worker also restarts Ollama or ComfyUI itself if they crash. | Worker or runtime crashes |
| 3. Watchdog task | A scheduled task runs as SYSTEM every 5 minutes. If the service isn't running, or `health.json` is older than 3 minutes (the worker is hung), it kills the worker's child processes, restarts the service and logs why. | Hangs, and a service that ran out of recovery restarts |
| 4. Manual fallback | A Start menu shortcut, **"Restart XLChess Worker"**, runs `repair-xlchess-worker.ps1 -Restart` elevated: stop everything, clear stuck processes, restart, then wait for a healthy heartbeat and say "Worker running" or what's wrong. A second shortcut, **"XLChess Worker Status"**, runs `diagnose`. The same commands work from a remote-control session. | Anything the automatic layers couldn't fix: the worst-case "start it again" button |

Restarting is always safe. Any job running at the time has its lease expire. The server re-queues it, and the worker never replays a stale lease (ARCHITECTURE §6).

**Power settings** (step 11, with consent, AC only): sleep and hibernate on AC set to never, hybrid sleep off, display may turn off. Setup also prints one manual recommendation, because a script can't change it: set the BIOS option *"Restore on AC power loss = Power On"*, so the PC comes back by itself after a power cut.

**Offline visibility:** when heartbeats stop, the XLChess admin screen shows the worker as offline (ARCHITECTURE §9). GPU jobs wait in the queue meanwhile, and time-sensitive ones expire at `notAfter`.

---

## 8. Other scripts

| Script | V1 behaviour |
|---|---|
| `diagnose` | Versions, `nvidia-smi`, service and watchdog status, last heartbeat age, API reachability, disk, power settings and the last 200 log lines, in a support zip **with the token and pairing codes redacted**. `-Upload` sends a summary through `/worker/v1/logs`. |
| `repair` | `-Restart` (§7), `-Verify` (re-run preflight, hash-check every file, re-download anything that fails, then self-test part A), `-Repair` (re-register the service and watchdog) and `-RePair` (new pairing code; replaces the token). |
| `uninstall` | Stop and remove the service, watchdog, shortcuts and firewall rules. Restore the saved power settings. Remove Program Files. **Ask** whether to keep the data folder, which holds the models, so a reinstall doesn't download them again. Say that the admin should also revoke the worker in XLChess. |
| update | Run the newer package's `install.cmd` (§2). The service stops, binaries are replaced, data and models are kept, then preflight and self-test run again. |

---

## 9. What the installer needs from the rest of the system

The installer can't be finished until these exist. Milestones 1–3 (§11) don't need them.

| Needed | Where | Notes |
|---|---|---|
| `POST /worker/v1/pair`, `workers` table, device tokens | API (1.18) | Already designed in ARCHITECTURE §6 and §8 |
| `POST /v1/admin/workers/pairing-codes` | API, plus an XLChess admin screen | The admin creates the code the owner types |
| `worker_selftest` GPU job kind, queued on pairing | `packages/shared` jobs, API | New: not in the current job kinds |
| Image-generation GPU job kind, plus an upload path for images (a signed Storage upload URL from the API, not base64 in `complete`) | Shared, API, worker | New. Text-only generation exists (1.7). |
| Worker: runtime supervisor (start/stop Ollama and ComfyUI, VRAM checks), `health.json`, ComfyUI client, `--version`, `--selftest-local` | `apps/worker` | The worker is a placeholder today |
| A public HTTPS URL for the SMB API | Deployment | ARCHITECTURE open item 2 |

**Docs to update later** (the conflict is accepted for now; until then this plan wins): ARCHITECTURE §1 (Windows 10/11, ComfyUI added), §2 (Qwen3.5 9B and Z-Image-Turbo, replacing Qwen3 8B), §3 (`apps/worker/src/ai/comfyui`, `workflows/`), §6 (installer paragraph), and the `--model qwen3:8b` example in §1.7.

---

## 10. To verify on the real PC

These are decisions with a planned fallback. Each needs checking once on the RTX 4070.
1. **CUDA under the virtual service account.** Both runtimes must see the GPU from the service (session 0). If they don't, fall back to `LocalSystem` and record the result in 1.21.
2. **The VRAM release thresholds** (500 MB, 30 s), tuned from real readings.
3. **Z-Image-Turbo speed with RAM offload**: time per image and peak VRAM at 1024×1024. This is a benchmark, not a model change.
4. **Qwen3.5 9B at a 16K context**: peak VRAM, and that the JSON output stays valid (the models guide's §9 benchmark).

---

## 11. Build order

| Milestone | Delivers | Needs §9? |
|---|---|---|
| 1 | `install.cmd`, preflight, `-CheckOnly`, `manifest.json`, hash-checked resumable downloads, state file | No |
| 2 | Ollama, Qwen3.5 9B, ComfyUI, Z-Image-Turbo installed, plus self-test part A (the worker's `--selftest-local`) | Worker supervisor only |
| 3 | Service (WinSW), watchdog, shortcuts, power, firewall, `repair -Restart`, `diagnose`, `uninstall` | No |
| 4 | Pairing, token storage, self-test part B, the full 1.21 demonstration | Yes |
| 5 | Run on the real PC, the §10 checks, 1.21 handover notes (including the Windows 10 assessment) | Yes |

**Testing:** Pester unit tests for the pure functions (version and threshold checks, manifest parsing, state transitions). Dev flags `-SkipGpuChecks` and `-ApiUrl` let the flow be tested on a PC without a GPU against a local API. A clean Windows VM checks that every failing preflight gives a clear message. The last check is the real PC.
