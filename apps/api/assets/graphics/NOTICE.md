# Bundled graphics assets (module 1.10)

| Folder | What | Source | Licence |
|---|---|---|---|
| `fonts/oswald-*.woff` | Oswald (display) | @fontsource/oswald 5 | SIL Open Font License 1.1 |
| `fonts/inter-*.woff` | Inter (body) | @fontsource/inter 5 | SIL Open Font License 1.1 |
| `flags/*.svg` | Country flags, 4x3 | flag-icons 7 (Panayiotis Lipiridis) | MIT |
| `pieces/standard.svg` | Chess pieces (Cburnett, Rfc1394; sprite prepared for cm-chessboard by shaack) | cm-chessboard | CC BY-SA 3.0 (the share-alike licence is already accepted in the image policy; a render containing the pieces credits them) |

Fonts are bundled so rendering never depends on fonts installed on the host. Text is drawn as outlines from these files.
