# Home-PC worker installer

Sets up the SMB local AI worker on the owner's PC: Ollama + Qwen3.5 9B, ComfyUI + Z-Image-Turbo, the worker as a
Windows service, a watchdog, and pairing with XLChess. Design and decisions: [docs/installer-v1-plan.md](../docs/installer-v1-plan.md).

## For the PC owner

Unzip the package, double-click `install.cmd`, allow the administrator prompt, type the pairing code. If setup
stops, run `install.cmd` again: finished steps are not repeated.

If the worker ever stops, use Start menu > **XLChess Worker** > **Restart XLChess Worker**.

## For developers

```bash
npm run installer:test       # Pester tests (Windows PowerShell 5.1 ships Pester 3.x; that is what they target)
npm run installer:package    # bundles the worker, builds dist/installer/xlchess-worker-<version>.zip (+ .sha256)
```

Safe to run on a development PC (changes nothing, needs no administrator):

```powershell
installer\install.cmd -CheckOnly
```

Useful switches on `setup-xlchess-worker.ps1`: `-ApiUrl`, `-PairingCode`, `-DataPath`, `-ProgramPath`, `-Yes`,
`-AllowPowerChanges`, `-SkipGpuChecks` and `-SkipSelfTest` (the last two are for PCs without the 12 GB GPU).

| File                           | Purpose                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `install.cmd`                  | Entry point: asks for administrator rights, runs setup with the execution policy bypassed |
| `setup-xlchess-worker.ps1`     | The installer: ordered, re-runnable steps                                                 |
| `repair-xlchess-worker.ps1`    | `-Restart`, `-Repair`, `-Verify`, `-NewPairing`                                           |
| `diagnose-xlchess-worker.ps1`  | Health report and support zip (secrets masked)                                            |
| `uninstall-xlchess-worker.ps1` | Removes everything; asks before deleting the models                                       |
| `watchdog-xlchess-worker.ps1`  | Scheduled task that restarts a stopped or hung worker                                     |
| `manifest.json`                | Every download: URL, size and SHA-256. The only place model or runtime versions change    |
| `lib/*.psm1`                   | Shared code: `Common`, `Preflight`, `Download`, `Runtimes`, `Service`, `Pairing`, `Power` |

Rules for editing the scripts: keep them ASCII-only (Windows PowerShell 5.1 misreads UTF-8 without a BOM; a test
enforces it), keep every step safe to run twice, and put decisions in small pure functions so they can be tested.
