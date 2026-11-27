# png-squeeze — lossless PNG re-compressor for make.fun

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Herman-234/png-squeeze-compressor-27-nov-2026/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Herman-234/png-squeeze-compressor-27-nov-2026/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Entry for the [make.fun bounty](https://make.fun/bounty/png-squeeze-01-run-20261127)
"Squeeze screenshots into the smallest PNG, 27 November 2026" ($100, 50 places paid).
`main.ts` (Node 22, standard library only) reads each screenshot from
`/input/<id>/image.png` and writes a smaller lossless PNG to
`/output/<id>/image.png` (or the `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`
directories when set).

## How it beats the house baseline (fixed-paeth)

The baseline writes every row as RGBA with the Paeth filter at zlib level 9.
This entry does three things better, all lossless and deterministic:

1. **Colour-type reduction** — palette (≤256 colours, non-grey), grey,
   grey+alpha, or RGB when the alpha channel is fully opaque. Grey images
   deliberately skip the palette: palette indices are in arbitrary order,
   so near-equal grey levels get unrelated indices and filters cannot
   predict them (practice i004: palette 218 KB vs grey 114 KB).
2. **Two filterings, keep the smaller deflate** — an adaptive per-row filter
   (lowest sum of absolute signed byte values over all five PNG filters)
   and all-Paeth; whichever zlib compresses smaller ships.
3. **zlib level 9**, one IDAT stream; output chunks are only
   IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8, no interlace.

## Practice-set results (local, kit practice data)

| instance | baseline (bytes) | this entry (bytes) | saved |
|---|---|---|---|
| i001 | 25,099 | 14,638 | 41.7% |
| i002 | 59,994 | 57,256 | 4.6% |
| i003 | 107,297 | 107,297 | 0.0% |
| i004 | 159,860 | 113,871 | 28.8% |
| i005 | 30,157 | 18,927 | 37.2% |
| i006 | 203,550 | 183,788 | 9.7% |
| i007 | 78,176 | 78,176 | 0.0% |
| i008 | 44,018 | 28,080 | 36.2% |
| **total** | **708,151** | **602,033** | **15.0%** |

All 8 outputs verified pixel-identical against the practice reference with
the kit's own checker decoder; two runs produce byte-identical files
(deterministic, no clock / randomness). Whole set runs in ~5 s locally,
well inside the 60 s wall budget. i003/i007 tie the baseline: transparent
captures with >256 colours, where RGBA + Paeth is already the best this
program's toolbox can do.

## Run

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
```
