# TORCHLIGHT DEPTHS

A self-playing 3D isometric dungeon explorer in three.js. One self-contained HTML file.
A lone adventurer with a torch and a sword explores a gritty stone dungeon, room by room,
fighting skeletons, giant rats and slimes by flickering torchlight — forever, descending
ever deeper. Hands-free spectacle that any player can take over at any time.

**Play: https://newstex-sparky.github.io/torchlight-depths/**

Full design brief: [BRIEF.md](BRIEF.md)

## Controls

None required — the hero plays itself from page load.
- WASD / Arrow keys — move (takes over from the AI hero)
- Space — attack
- Gamepad — supported
- After a few seconds without input, the hero resumes playing itself
- Click the "🔊 sound" hint once to enable audio

## Stack

- three.js (importmap, single-file build)
- Custom post-process chain: half-resolution render target → subtle Bayer ordered dither →
  depth-aware tilt-shift blur → vignette + film grain
- Web Audio synthesized SFX (no audio files)
- No build step, no bundler. `index.html` is the whole game.

## Repo layout

```
index.html    ← the entire game (self-contained)
BRIEF.md      ← full design brief
```
