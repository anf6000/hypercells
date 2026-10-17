# hypercells — documentation

GPU particle-life shows (Fluoddity-style physarum) written as self-contained, single-file
WebGL2 apps. Hundreds of thousands of particles deposit 2D velocity into a decaying flow
field, sense it with two mirrored sensors, and steer through an evolvable 80-float Fourier
rule ("the organism"). This file explains the folder layout after the 2026-10-16 sort, the
differences between the shader/pipeline versions, every control in every build's UI, and
the LLM-evolution tooling. `docs/index.html` is an older, illustrated deep-dive site on the
two autopilot builds; see §9 for its stale filename mapping.

---

## 1. Project layout

```
hypercells/
├── readme.md                   ← this file
├── .gitignore                  ← keeps the ~35 GB of recordings out of git
├── simple/                     ← baseline interactive build (simple/index.html)
├── avoid/                      ← simple + particle-density avoidance (avoid/index.html)
├── fight/                      ← avoid + cohort battles and rule evolution (fight/index.html)
├── color/                      ← gallery build: colour textures, presets, config auto-cycling
├── hypercells-4k/              ← 4K autopilot build (standalone, everything inlined)
├── evolve/                     ← autopilot show + LLM evolution tooling
│   ├── hypercells-evolve.html  ← the page (shown on the big screen; served by the bridge)
│   ├── bridge.mjs              ← localhost server that runs the Pi agent (port 8787)
│   ├── system.md               ← the agent's system prompt
│   ├── behavior.glsl           ← the live behaviour shader the agent edits
│   ├── versions/NNNN.glsl      ← every accepted shader version (0000 = seed/v0)
│   ├── candidates/             ← every proposed shader, accepted or not (+ .json outcome)
│   ├── sessions/, shots/       ← Pi agent session history, latest screenshot
│   └── package.json            ← `npm start` → `node bridge.mjs`
├── config/                     ← tuned configurations consumed by color/
│   ├── configs.js              ← window.HYPERCELLS_CONFIGS: 14 entries, generated from the .json files
│   ├── hypercells-*.json       ← 14 raw saved-state snapshots (save json button)
│   └── textures.js             ← window.HYPERCELLS_TEXTURES: 12 texture palettes (64 KB-ish data URIs)
├── docs/                       ← illustrated documentation site (index.html, assets/, media/)
└── recordings/                 ← raw captures; segments/ holds crop/cut exports
```

### How to run

| Version | How |
|---|---|
| simple | open `simple/index.html` in a browser (fully self-contained) |
| avoid | open `avoid/index.html` (simple + particle avoidance, fully self-contained) |
| fight | open `fight/index.html` (avoid + cohort battles and rule evolution, fully self-contained) |
| color | open `color/index.html` (loads `../config/configs.js` + `../config/textures.js`) |
| autopilot | open `hypercells-4k/hypercells-4k.html` — or `evolve/hypercells-evolve.html` for the no-bridge show |
| evolve | `cd evolve && npm install && node bridge.mjs`, then open `http://localhost:8787/hypercells-evolve.html` and switch **evolve: on** |
| docs site | open `docs/index.html` |

All six apps render full-screen; press `h` to reveal the control panel. Everything is
offline and free — there are no network calls (the bridge only talks to localhost).

---

## 2. The shared engine

All builds are the same engine with different settings-space and features:

1. **move** — a fragment shader advances one particle per texel of an `RGBA32F` entity
   texture (pos.xy, vel.zw), ping-ponged between two textures.
2. **deposit** — 600k+ instanced gaussians (σ 0.163 texels) splat each particle's velocity
   into a brush texture.
3. **diffuse/decay** (CANVAS_FS) — the field blurs (5-tap) and decays by trail persistence
   while taking the deposit; equilibrium is persistence-independent (*Fluoddity mix*).
4. **paint** — a second, slower field layer ("paint") feeds the field view.

Physics per particle: sensor taps at `±sensor_angle·π` rotated off the heading at
`sensor_distance` scaled by field size; the sensed vectors are amplified by
`sensor_gain`, passed through the behaviour function `black_box(L, R, rule)` (a
10-centre Fourier feature map, 80 floats), mirrored (`y_reflect`) and summed so the
behaviour is left/right symmetric, then decomposed into a **force** (changes velocity:
`vel = vel·drag + force`) and a **strafe** (moves position directly). `cohorts` partitions
the particles into colour groups, each running its own mutation of the shared rule.

---

## 3. The versions

| Version | File | Title | Role |
|---|---|---|---|
| **simple** | `simple/index.html` | hypercells — fluoddity-style physarum | stripped-back *interactive* build: draw mode, manual control, auto-mutates every 90 s |
| **avoid** | `avoid/index.html` | hypercells — particle avoidance | simple + a decaying particle-density field and a clamped repulsion force, with strength/radius/memory controls |
| **fight** | `fight/index.html` | hypercells — cohort fight | avoid + mutable per-particle cohorts: local strength keys, colour-blended conversions, population readback, and rounds that mutate the winner's rule into a new cohort set |
| **color** | `color/index.html` | hypercells — fluoddity-style physarum | *gallery* build: image-derived colour palettes, presets, config auto-cycling, blend/tonemap paths, no draw mode |
| **autopilot** | `evolve/hypercells-evolve.html` | hypercells — autopilot | *self-animating* build + LLM evolution: glide-morphs between 17 anchors, health-monitored, bridgeable to an LLM that rewrites the behaviour shader |
| **4K** | `hypercells-4k/hypercells-4k.html` | hypercells — autopilot 4K | exactly the autopilot build with 7 constants changed for 4K output (§3.4) |

`hypercells-auto/hypercells-auto.html` was a byte-identical duplicate of
`evolve/hypercells-evolve.html` and was removed in the sort — the evolve page is the one
file for both roles (standalone or bridge-driven; without the bridge it runs the normal
autopilot show, seeded and offline).

### 3.1 simple — shader/pipeline differences

- **Cohort rule lives in uniforms** (`config_rule`), generated in-shader on demand and
  **mutated in-shader every frame** (`mutate_rule`, seeded per cohort) — constant
  per-particle trickery that the later builds replaced with a stable CPU-uploaded texture.
- **Particle view**: solid `source-over` sprites as **1:3 dashes aligned with the direction
  of travel**, per-particle hue jitter (3 % of the hue circle), and the two halves of the
  cohort list drift their hue in *opposite* directions (rate fixed 0.005 hue units/s).
- **Extra sliders** the later builds dropped: `opacity` (0.5), `particle size` (1–8 px).
- **Draw mode**: dragging pushes the flow field with a gaussian kernel
  (`DRAW_RADIUS 0.05`, `DRAW_POWER 0.3`); crosshair cursor.
- **Auto-mutate** every 90 s of runtime (in addition to the mutate button).
- Fixed: `PAINT_GAIN 0.016`, `PAINT_PERSISTENCE 0.995`, canvas diffusion `K = 1`, no tonemap.
- 600 000 particles, 1024×1024 field, cohorts default 7, accumulation default 0.

### 3.1b avoid — shader/pipeline differences

The avoidance build is `simple` plus one extra offscreen stage (an instanced density deposit,
a separable blur and a decay/combine draw) and one extra force term:

- A separate **R32F density field at half the flow-field edge** (256² at 128k, 362² at
  256k, 512² at 512k, 724² at 1024k) is ping-ponged independently of the flow field. Each
  step the moved particles are bilinear-splatted (4 fragments each) into a scratch layer,
  blurred with a separable 7-tap gaussian (together equivalent to a σ 1.32-texel splat),
  and added to the previous field decayed by `avoid_fade` (memory). The blur wraps like
  the world.
- **Performance structure** (measured on an Intel UHD 630: 128k 81.5 → 11.9 ms/frame,
  1024k 417 → 84 ms/frame):
  - instanced splats/sprites draw **one covering triangle** per particle (fragments outside
    the quad are discarded) instead of a `TRIANGLE_FAN` quad, which ANGLE/D3D11 emulates;
  - the per-cohort mutated rule is computed by a tiny **rule pass** into a 40×24 texture
    (frequency, amplitude, sin/cos of the phase offsets) only when the rule, seed or
    mutation scale change; the entity pass evaluates base and mirrored signals in one loop
    with two transcendentals per center (angle addition) — bit-identical on the first step;
  - layers allocate only the channels they read: flow/paint/brush **RG32F**, avoidance
    **R32F**, display/accumulation **RGBA16F**; the brush writes `vel·k²` with a ONE/ONE
    blend (same values as before);
  - invisible work is skipped: the paint layer updates only in field view (reseeded from
    the flow field × 3.2, its equilibrium ratio, on entry), the accumulation composite is
    skipped at 0, the hazard hash is skipped at rate 0, and the HUD updates at 4 Hz.
- **Size dropdown** (Organism section): `128k` (512² field, default), `256k` (724²),
  `512k` (1024²), `1024k` (1448²). Particle count and field edge scale together so density
  per texel is constant. Changing size recreates the textures, resets the simulation, and
  scales `avoid_radius` by the edge ratio so the avoidance pattern keeps its visual size.
  The present pass uses integer nearest-neighbour scaling when it nearly fills the window,
  otherwise a filtered fractional fit, so every grid fills the display.
- `ENTITY_FS` samples the density at four axial offsets (`avoid_radius` in current-field
  texels), divides the central difference by `1 + center_density`, and adds
  `-gradient * avoid_strength * 0.002` to the velocity update. The result is clamped to
  ±0.004 per step so extreme settings cannot explode the simulation.
- The avoidance field is deposited **after** the move, so particles read the previous
  step's density and the flow field keeps its original one-frame lag.
- New controls: `avoid: on/off` button + `a` key; **strength** (0–1.5, default 0.35),
  **radius** (2–20 field px, default 6 at 128k and scaled with size), **memory**
  (0.8–0.995, default 0.97). Disabling avoidance skips both passes; enabling it clears
  stale density. Reset clears it too.
- **Hue drift** is now a *Field & render* slider (0–0.01, step 0.001, **default 0**); at 0
  the cohorts keep their colours indefinitely, so particles stay aligned with cohort
  colours. **Persistence** was moved from *Field & render* to *Physics*.
- This is soft repulsion: it creates lanes and strongly reduces crossings, but does not
  mathematically guarantee that two particle trajectories never intersect.

### 3.1c fight — shader/pipeline differences

The fight build is `avoid` plus a mutable cohort state texture, three fight passes and a
population readback. Simulation, avoidance, rendering and the size dropdown are unchanged.

- **Per-particle state.** Two `RGBA32F` textures the size of the entity texture hold
  `(cohort, prevCohort, convertFrame, 0)`. `ENTITY_FS` reads its cohort from the state
  texture instead of deriving it from the index; `STATE_INIT_FS` writes the old
  `floor(cohorts·index/count)` assignment on reset/new organism/size change/cohort-slider
  changes.
- **Dominance pass.** A new **R32F grid at the avoidance resolution** is cleared to zero each
  step, then every particle draws one tiny covering triangle at its position (`~1 texel` of
  area). The fragment writes `floor(roll·65536)·32 + cohort`, where
  `roll = hash(index, frame) · trait` and `trait = (0.9 + 0.2·hash(rule_seed, cohort)) ·
  (1 + share)`. The grid uses **`gl.MAX` blending**, so each cell keeps the strongest key;
  a cohort with more particles in a cell is proportionally more likely to own it (Lanchester's
  local majority). `share` is the cohort's population fraction from the last readback, which
  gives a large cohort a mild tie-break.
- **Fight pass.** A fullscreen pass reads the state and position, samples the dominance cell
  at the particle's position, and if `key > 0`, `key mod 32 ≠ cohort` and
  `hash(index, frame) < aggression`, rewrites the state to `(winner, own, frame)`. During the
  next `blend_seconds·60` steps the particle is **immune**, so boundaries cannot flicker. If
  no local enemy is present, a particle may still defect to the **global leader** once that
  leader holds more than 50%: `aggression · 0.5 · (leaderShare − 0.5)` per step. This is the
  closure mechanism for isolated pockets; without it the 99% test can stall forever on a
  dense clump that never meets an opponent.
- **Population readback.** Every 30 rendered frames (`~0.5 s` at 60 fps) an instanced
  **1-point splat per particle** additively fills a `24×1` R32F histogram; `readPixels`
  returns one float per cohort. The HUD bar shows the shares as a stacked strip in cohort
  hues. The same readback updates `share`, the leader and the win test.
- **Rounds.** When the leader holds **≥ 99%** of the particles, `nextRound(winner)` reads the
  winner's row (40 texels) from the per-cohort rule texture, rebuilds the 80-float rule,
  generates a **new `rule_seed`** (so the next cohort set is a fresh mutation), and
  `ROUND_FS` re-deals the map into contiguous **angular sectors** around the centre. Every
  particle starts with `prev = winner` and blends its hue to the new sector hue over the
  blend time (shortest arc; the two-half hue drift and per-particle noise keep keying off the
  current cohort). The round counter increments and the HUD shows it.
- **Auto-mutate is disabled** in this build: rounds take over that role. The **mutate**
  button (key `m`) still works. Changing `cohorts` restarts the round immediately; size
  changes, reset and new organism reinitialise the state and reset the round to 1.
- **Controls.** `battle: on/off` button + key `b` (off = dominance, fights, readback and
  rounds are skipped; colours and behaviour freeze); **aggression** 0–0.3, default 0.05
  (0 = no conversions); **blend** 0.25–4 s, default 1.0 (converted to frames at 60 fps);
  **hue drift** 0–0.01, default **0**, in *Field & render*, so particle hues and the cohort
  bar stay aligned by default. **Persistence** is in *Physics*.
- **Performance.** The fight build adds one MAX-blended instanced splat, one fullscreen state
  pass, and a 24×1 histogram + readback every 30 frames. There is no per-particle CPU work
  and no extra per-frame texture upload. On the 128k default the extra cost is a few
  milliseconds per frame; sizes scale like `avoid`.

### 3.2 color — shader/pipeline differences

- **Colour comes from `config/textures.js`**: three modes (button `color: …`, key `c`):
  - **palette** — a particle's heading samples the image's 256×1 hue-sorted palette strip
    (directional colour bands).
  - **paint** — each particle keeps the texture coordinate of its spawn position (a
    once-per-reset `UVASSIGN` pass) and therefore paints the source *image* in strokes.
  - **hue** — a built-in 12-entry neon hue strip (`ARTIFICIAL_HUES`).
  A `next texture` button / `t` key picks the next texture, crossfaded over 2.5 s.
- **Blend modes** (button `blend: …`, key `b`): *solid* (source-over, premultiplied) and
  *additive* (`src-alpha, one`) with an **asinh tonemap pass** ring in front of accumulation
  — the additive path is the only one that is tone-mapped.
- **Field layers became sliders**: `paint gain` (0…0.2) and `paint fade` (0…1) replace the
  baseline's fixed constants; a `diffusion` slider (0…1) drives the blur weight;
  `steps/frame` (1…8) is auto-calibrated to hold ~15 ms/frame at boot.
- **World size select** (tiny 0.08 / small 0.25 / medium 0.5 / large 1): particle count =
  `600 000 × size`, field edge = `1024 × √size` (289/512/724/1024 texels) — distances stay
  tuned because everything scales with the field.
- **Start select**: `random` / `grid` / `ring` initial conditions (grid = one spot per cohort).
- **Presets**: 3 embedded organisms (HungryHungryHippos, Corners, 9LeafClovers).
- **State sharing**: `copy state link` (URL hash `#c=<base64>`), `save json` /
  `load json` buttons.
- Removed vs simple: draw mode, per-cohort hue drift, particle-size/opacity sliders.

### 3.3 autopilot (`evolve/hypercells-evolve.html`) — shader/pipeline differences

- **Cohort rules became stable**: computed on the CPU (`mutateRuleStable`, seeded
  `rule_seed + cohort`) and uploaded once as a **24×20 RGBA32F rule texture** that the
  move shader `texelFetch`es — the in-shader per-frame `mutate_rule` (the fizz source in
  simple) and the in-shader rule generation are gone.
- **Autopilot** (§5.5): glides between 17 inlined anchor organisms or generated "family"
  candidates with rate-limited, smootherstep-eased morphs; guards keep the show alive
  (speed cap 3 texels/step, force clamp ±0.5 that may never *settle* at 0, persistence
  0.95…0.998, drag 0…0.95, rule slew 3.0/s).
- **Health monitor**: every 30 sim steps a 32×32 GPU box-average of the field is read back
  through ping-ponged pixel-pack buffers (never stalls the frame). `fizz` = mean
  frame-to-frame change over mean magnitude (fizzy above 0.55); `dead` below 12 % of a
  decaying reference. Bad for > 5 s → the autopilot abandons its target (morphs to the
  nearest anchor at 35 % of the morph time); inside an LLM trial the trial is rejected.
- **Evolve bridge** (§5.6, §7): optional localhost LLM that proposes parameter targets
  (ordinary autopilot morphs) and/or rewritten GLSL behaviour functions; candidates run as
  side-by-side dual programs crossfaded with `u_blend`, judged by the same health monitor,
  kept (rebuilt single program) or blended back out and archived.
- **Reproducibility**: mulberry32-seeded PRNG, `?seed=<int>` URL param, `#c=` state links;
  the clock counts sim steps, so a seed fully reproduces a show.
- **Mutate is an event**: amount `0.55 + 0.65·mutation_scale` glided over 5 s, not a nudge.
- No draw mode, no auto-mutate loop, no opacity slider; axial/lateral/strafe still exist
  (morphed by the autopilot/LLM) but have no user sliders.

### 3.4 4K — the seven changed constants

`hypercells-4k.html` states it outright: *"Same engine as autopilot.html — these settings
differ, and nothing else"*, and lists them verbatim:

| Constant | autopilot | 4K | why |
|---|---|---|---|
| `CANVAS_DIM` | 1024 | **2160** | full-bleed 3840×2160, presented 1:1 |
| `PARTICLE_BASE` | 600k | **1M** | density for the bigger field (×2/×½ selectable) |
| `FILL_SCREEN` | off | **on** | the field widens with the window's aspect (`texScale` keeps texels square so deposits stay round) |
| `SCALE_FIELD_WITH_WORLD` | on | **off** | world size must not retune the distances |
| `PARTICLE_PX` | 0 (soft) | **1** | hard one-pixel particles |
| `NORMALISE_DEPOSIT` | off | **on** | deposit weight `min(1, 600k/count)` keeps field strength at 0.5M/1M/2M |
| `WORLD_SIZES` | tiny…large | **0.5M / 1M / 2M** | particle-count-only density knob |

Performance notes from the source: the paint layer is **not updated while the particle view
is showing** (removes one full-field pass per step), the health readback is asynchronous
(PBO ping-pong), the field is 3840×2160 so every field-sized pass is ~133 MB in RGBA32F
(~1.1 GB of texture memory budget), `FIXED_STEPS = 2` physics steps per frame, and
`FIELD_FMT_HALF` (off) would switch the field to RGBA16F for half the traffic at ~0.05 %
relative precision — turning it on gives a subtly different, not merely faster, simulation.
At 3840×2160 the present pass runs 1:1 with no scaling at all.

### 3.5 Shader programs per build

| Program (pass) | simple | color | autopilot | 4K | fight |
|---|---|---|---|---|---|
| `QUAD_VS` — shared fullscreen quad | ✔ | ✔ | ✔ | ✔ | ✔ |
| `ENTITY_FS` — particle move | ✔ (rule in uniforms, in-shader mutate) | ✔ (same) | ✔ (fixed head + behaviour + main; rule texture) | ✔ (same + speed cap, aspect-aware wrap) | ✔ (rule texture; cohort read from state) |
| `BRUSH` — instanced gaussian deposit | ✔ | ✔ | ✔ | ✔ (+ deposit normalisation) | ✔ |
| `CANVAS_FS` — diffuse + decay (both layers) | ✔ (fixed paint constants) | ✔ (paint gain/fade/diffusion sliders) | ✔ (paint gain derived from persistence) | ✔ (paint pass skipped in particle view) | ✔ (paint skipped outside field view) |
| `FIELD_FS` — field view (hue-map of paint) | ✔ | ✔ | ✔ | ✔ | ✔ |
| `SPRITE` — particle view | 1:3 velocity dashes, per-particle jitter, opacity | texture-coloured, crossfading textures, blend modes | golden-angle palette, two-tier vividness, soft/hard px | same | dashes + state-driven cohort/previous hue blend |
| `COMP_FS` — accumulation composite | ✔ | ✔ (+ solid fade / additive branches) | ✔ | ✔ | ✔ |
| `TONEMAP_FS` — asinh tonemap (additive) | – | ✔ | – | – | – |
| `UVASSIGN_FS` — spawn→texture coords (paint mode) | – | ✔ | – | – | – |
| `PRESENT_FS` — integer-scaled letterboxed blit | ✔ | ✔ | ✔ | ✔ (per-axis float fit fallback) | ✔ |
| `REDUCE_FS` — 32×32 health readback | – | – | ✔ | ✔ | – |
| `STATE_INIT_FS` — per-particle cohort init | – | – | – | – | ✔ |
| `ROUND_FS` — re-deal angular sectors | – | – | – | – | ✔ |
| `DOMINANCE_VS/FS` — MAX-blended strength keys | – | – | – | – | ✔ |
| `FIGHT_FS` — conversion + blend immunity | – | – | – | – | ✔ |
| `HISTOGRAM_VS/FS` — 24×1 population splat | – | – | – | – | ✔ |

### 3.6 The behaviour function and its versioning

The default behaviour (v0, `evolve/behavior.glsl`, identical to simple/color's
inlined function) is:

```glsl
void behavior(vec2 L, vec2 R, vec2 axis, Rule rule, out vec2 force, out vec2 strafe){
  vec2 forward = safenorm(axis);
  vec2 left = vec2(forward.y, -forward.x);
  L = vec2(dot(L, forward), dot(L, left));
  R = vec2(dot(R, forward), dot(R, left));
  vec4 baseterm  = black_box(L, R, rule);
  vec4 mirrorterm = black_box(y_reflect(R), y_reflect(L), rule);
  force  = baseterm.xy  + y_reflect(mirrorterm.xy);
  strafe = baseterm.zw  + y_reflect(mirrorterm.zw);
  // axial/lateral scale the LOCAL frame components (scaling world x/y caused the vertical bias)
  force  = forward * (force.x  * config_c.y) + left * (force.y  * config_c.z);
  strafe = forward * (strafe.x * config_c.y) + left * (strafe.y * config_c.z);
}
```

`black_box(L, R, rule)` = `fourier_noise(rule.centers, vec4(L, R))`: ten Fourier centres,
each `phase = dot(signals, frequency)`, a four-component phased sin/cos basis
(`amplitude.w` doubles as a phase), output `Σ amplitude·basis` → (force.x, force.y,
strafe.x, strafe.y). The mirror term mixes in the same box evaluated on the y-reflected
inputs, so the rule need only be one-sided.

In **simple/color** this function is baked into the entity shader.
In **autopilot/4K** the shader is split into `ENTITY_HEAD` (helpers) + a replaceable
behaviour function + `ENTITY_MAIN`; the replaceable part is versioned by the evolve system:

- `evolve/behavior.glsl` — the live file the LLM edits; version 0 is the seed above
  (`versions/0000.glsl`).
- `evolve/versions/NNNN.glsl` (+ `.json` rationale) — every proposal the health monitor
  *kept*, archived and selectable in the UI (the **version** dropdown reverts).
- `evolve/candidates/<id>.glsl` (+ `.json` outcome) — every proposal ever made, kept or not.
- A candidate is never compiled directly: the page names every function/const `_a`/`_b`,
  compiles old and new behaviour **side by side** into one dual program, and crossfades
  `u_blend` 0→1 over ≥ 3 s; sanitising (`evo_san`) zeroes NaN/Inf outputs. Accepted
  candidates are rebuilt as a single program (async compile, `KHR_parallel_shader_compile`);
  rejected ones blend back out over ~35 % of the blend time and — if the field ended dead —
  the simulation respawns, because a dead field has no velocity left to sense.
- **Static validator** before anything compiles: ≤ 6 KB, exactly one `void behavior(vec2
  vec2 vec2 Rule out vec2 out vec2)` signature, no `uniform`/`main`/`#` directives/
  `while`/`do`/`struct`/`discard`/texture sampling/`gl_*`, for-loops only as
  `for (int i = N; i < M; i++)` with M ≤ 16, ≤ 3 loops and trip-count product ≤ 32.

Simple/color **do not** have this machinery — their entity shader is fixed.

---

## 4. Settings reference

Limits are slider ranges; "default" is what the app boots with. Values shared by all builds
are written once in the shared column.

### 4.1 Physics sliders (all builds unless noted)

| Slider | Key | Range (default) | What it does |
|---|---|---|---|
| sensor angle | `sensor_angle` | −1…1, step 0.001 (simple −0.778; others −0.729) | Half-angle of the two sensor taps, in π units (0.5 = 90°). Shown as degrees. |
| sensor dist | `sensor_distance` | −2…3, step 0.01 (simple −1.22; others −1.05) | Tap distance from the particle: `0.005 × value` in field units. **Negative looks behind** the particle. |
| sensor gain | `sensor_gain` | 0…10, step 0.01 (simple 1.01; others 0.908) | Amplification of both sensed vectors (`38.855 × gain × √world`). The main "sensitivity" of the organism. |
| force | `global_force_mult` | simple/color −1…2; autopilot/4K −0.5…0.5 (≈ −0.34) | Scales the behaviour's force (÷400) and strafe (÷20) output. Its sign flips the sense of attraction: negative values are in the tuned anchors. |
| drag | `drag` | simple/color −1…1; autopilot/4K 0…1 (≈ 0.561) | Velocity retention per step: `vel = vel·drag + force`. Lower drag = twitchier, higher = smoother momentum. |
| mutation | `mutation_scale` | 0…1, step 0.005 (simple 0.405; others 0.14) | How far each cohort's rule drifts from the shared rule. simple mutates continuously in-shader; later builds compute per-cohort variants from it. |
| hazard | `hazard_rate` | 0…0.05, step 0.0005 (0) | Per-particle-per-step chance to respawn instantly at a random position (fronts refresh, other builds respawn randomly). |
| axial | `axial_force` | simple/color −1…1 (≈ 0.359) | Scales the *forward* component of both force and strafe in the particle's local frame. simple/color only. autopilot/4K keep the parameter (clamped ±1.2) but give it no slider — the autopilot and LLM morph it. |
| lateral | `lateral_force` | simple/color −2…1 (≈ −1.294; autopilot/4K runs 0.303) | Scales the *sideways* components, same as above. simple/color only. |
| strafe | `strafe_power` | simple/color 0…0.5 (≈ 0.076) | Multiplies the direct position offset `pos += strafe` (not a force). simple/color only. |
| persistence | `trail_persistence` | simple/color 0…1 (0.975 / 0.982); avoid/fight 0…1 (0.975); autopilot/4K 0.95…0.998 (0.982) | How much of the flow field survives each step — trail length. simple/color sit it in *Field & render*; avoid/fight and autopilot/4K put it in *Physics*. |

### 4.2 Field & render sliders

| Slider | Key | Range (default) | What it does |
|---|---|---|---|
| paint gain | `paint_gain` | color 0…0.2 (0.016) | How much velocity gets brushed into the separate "paint" display layer. color only; the other builds derive it as `1 − trail_persistence`. |
| paint fade | `paint_persistence` | color 0…1 (0.995; presets force 1.0) | Decay of the paint layer (only read by the field view). |
| diffusion | `trail_diffusion` | color 0…1 (1) | 5-tap blur weight of the field layers. Slider in color; autopilot/4K keep the parameter morphable (default 1) but give it no slider. |
| steps/frame | `app.stepsPerFrame` | color 1…8 (auto-calibrated at boot: `floor(15 / frame-ms)`, so faster GPUs run more steps) | Physics iterations per displayed frame. |
| brightness | `app.brightness` (`__brightness`) | 0.2…3, step 0.01 (0.74 everywhere) | Multiplies sprite and field-view output before tonemapping. |
| accumulation | `app.accum` (`__accum`) | 0…1, step 0.01 (simple **0**; color/autopilot/4K **0.93**) | Trail persistence of the display buffer: 0 shows only the live frame, 1 never clears it. The live frame is always drawn at full strength, so the picture never dims or freezes. Pauses skip the pass. |
| solid fade | `app.solidFade` (`__solidFade`) | color 0.9…1 (1) | Bounded memory of the solid blend so overlaps build up but stop short of smearing. |
| opacity | `app.opacity` | simple 0…1 (0.5) | Scales sprite coverage after the kernel, so overlaps accumulate instead of clamping. simple only. |
| particle size | `app.particlePx` (`__particlePx`) | simple 1…8 px (1); autopilot 0…4 (**0 = soft**); 4K 0…4 (**1 = hard**) | 0 = soft gaussian sprite (1.152 texels); 1…4 = hard, texel-grid-snapped squares of N field texels. A 1-px hard particle lands on exactly one pixel. |
| hue drift | `hue_drift` (avoid/fight); `app.hueDrift` (`__hueDrift`, autopilot/4K) | avoid/fight 0…0.01, step 0.001 (**0**); autopilot/4K 0…0.01, step 0.001 (0.010) | Rate at which the whole cohort palette travels (hue units/s). avoid/fight default to **0** so particles keep their cohort colours (the old fixed rate was 0.005). simple drifts a fixed 0.005 with a two-half scheme; color replaces hue with textures. |
| hue wobble | `app.hueWobble` (`__hueWobble`) | autopilot/4K 0…0.05, step 0.005 (0.04) | Bounded per-cohort hue breathing (amplitude of a sine on the group's phase), so the palette inhales/exhales but never drifts away. |

### 4.2b Avoidance sliders (avoid, fight)

| Slider | Key | Range (default) | What it does |
|---|---|---|---|
| strength | `avoid_strength` | 0…1.5, step 0.01 (0.35) | Multiplies the density-gradient repulsion. Higher values open wider gaps but can overpower the organism's own flow. |
| radius | `avoid_radius` | 2…20 field texels, step 0.5 (6 at 128k; scales with world size) | Distance of the four density taps around each particle. Larger radii sense broader crowds and produce wider lanes. |
| memory | `avoid_fade` | 0.8…0.995, step 0.001 (0.97) | Per-step persistence of the density field. Higher values make recently occupied paths repel for longer. |

The `avoid: on/off` button (key `a`) toggles the two avoidance passes; enabling it clears stale density. Reset clears the density field as well.

### 4.2c Battle sliders (fight only)

| Slider | Key | Range (default) | What it does |
|---|---|---|---|
| aggression | `aggression` | 0…0.3, step 0.001 (0.05) | Per-step chance that a beaten particle converts to the winner of its dominance cell (and, once a leader is above 50%, chance scale for isolated defections). 0 = no conversions; cohorts stay fixed. |
| blend | `blend_seconds` | 0.25…4 s, step 0.05 (1.0) | Colour crossfade from the old cohort hue to the new one, converted to frames at 60 fps. The particle is immune to further conversion for the whole blend. |

The `battle: on/off` button (key `b`) pauses fights and rounds; the state textures and the bar stay where they are. The HUD shows the round number and a thin stacked bar with one segment per cohort in its hue. Auto-mutate is disabled in this build; the rounds mutate the rule instead. `mutate` (`m`) and `new organism` (`n`) still work.

### 4.3 Organism & world

| Control | Builds | Values (default) | What it does |
|---|---|---|---|
| cohorts | all | 1…24 (simple/avoid/fight 7; others 12) | Number of colour groups. Each group runs its own mutation of the shared rule (rule texture columns); color/autopilot reset the sim on change, fight restarts the battle round (positions stay). Particles start in a **ring** in every build. |
| size | avoid, fight | 128k (512²) / 256k (724²) / 512k (1024²) / 1024k (1448²); default **128k** | Particle count and flow-field edge scale together (constant density per texel). Changing size recreates the textures, resets the sim, and scales `avoid_radius` by the edge ratio; fight also resets the round to 1. The present pass fits every size to the window. |
| world size | color, autopilot | tiny 0.08 / small 0.25 / medium 0.5 / **large 1.0** | Scales everything: particles 48k/150k/300k/600k and field 289/512/724/1024 texels (the field edge is `1024×√size` so tuned distances hold). |
| world size | 4K | **0.5M / 1M / 2M** | Particle count only (density knob): 500k/1M/2M particles, the 3840×2160 field is fixed, and deposits are normalised so strength is unchanged. |
| start | color | random / grid / **ring** | Initial layout. grid = one spawn spot per cohort; ring = cohorts evenly on a circle. Other builds: ring only (hazard respawns are always random). |
| presets | color | 3 embedded organisms | Applies a complete known-good look (physics + rule, ring start, paint_persistence 1.0). |
| seed | autopilot, 4K | text field (random int, or `?seed=`) | Reproducibility seed for the whole show (rule generation, autopilot picks, mutations). Changing it reseeds and resets. |

### 4.4 Autopilot section (autopilot build + 4K)

| Control | Range (default) | What it does |
|---|---|---|
| `autopilot: on/off` | on | Self-animating glide loop. Off = manual. |
| `clear locks` | – | Releases every parameter the autopilot is holding (see locks below). |
| morph time | 5…180 s (**45**) | Duration of one smooth glide between organisms (smootherstep over sim steps) — or an LLM/mutate morph. |
| hold time | 5…120 s (**25**) | Dwell at each organism before morphing (also the trial hold length an LLM proposal is judged over, and mutate's crossfade). |
| exploration | 0…1 (**0.35**) | Chance that a new target is a freshly *generated* candidate rather than one of the 17 anchors; it also raises the probability (0.25 + 0.5·exploration) that a candidate gets its rule mutated. |
| seed | text (random) | Same reproducibility seed as §4.3. |
| lock/label UI | – | Clicking a physics **label** locks/unlocks that parameter against the autopilot (blue + `[L]`); dragging a slider locks it automatically. Locked keys are ignored by the autopilot, the LLM and the guards. Status: `seed <n> · morph #1 → #5 · fizz 0.12 · 2 locked` |

Candidate generation blends 2–3 anchors in log-parameter space with typed Gaussian noise,
flips them into family A (gain < 2.2) or B bands, and cross-mutates rules; a blacklisted
(dead/fizzy) target is never repeated and is abandoned to the nearest anchor.

### 4.5 Evolve section (autopilot build + 4K)

| Control | Default | What it does |
|---|---|---|
| `evolve: on/off` | **off** ("bridge offline" when not launched via bridge.mjs) | Enables the LLM loop: every `interval` minutes it posts telemetry (screenshot, params, rule, GLSL, health) to the bridge, applies its proposal as a trial morph/shader candidate, then keeps or rolls it back by health. |
| `evolve now` | – | Runs one step immediately. |
| `shader edits: on/off` | on | Whether the LLM may rewrite GLSL (off = params only; the bridge is told and won't offer shaders). |
| interval | 1…15 min (**3**) | Minutes between automatic evolve steps. |
| version | v0 (seed) | Select an accepted shader version and revert to it (blended in like a trial, no judging). The current version is marked `← now`. |
| status line | `v0 · bridge offline` | `idle` / `watching` / `asking the agent…` / `compiling candidate…` / `trial: <kind> — <rationale>` / `trial kept` / `trial rolled back` / `agent error: …` plus the last verdict line. |

### 4.6 Buttons and keys

| Control | simple | color | autopilot / 4K |
|---|---|---|---|
| pause / resume (`space`) | ✔ | ✔ | ✔ (skips the sim, still renders) |
| reset (`r`) | ✔ | ✔ | ✔ (new reset seed; clears accumulation; keeps the health reference) |
| new (`n`) | ✔ | ✔ | ✔ (fresh 80-float rule from a new seed; autopilot restarts its hold) |
| mutate (`m`) | ✔ (nudge, `0.15·(0.5+mutation_scale)`) | ✔ (same) | ✔ (big 5 s glide, amount `0.55+0.65·mutation scale`) |
| draw (`d`) | ✔ + key `d` | – | – |
| view: particles/field (`f`) | ✔ | ✔ | ✔ (field view accumulates from the moment you switch to it) |
| hard px (`p`) | ✔ | ✔ | – (both builds removed the button; the 4K build boots hard 1 px, the autopilot build boots soft) |
| blend mode (`b`) | – | ✔ (solid ⇄ additive, + tonemap path) | – |
| color mode (`c`) | – | ✔ (palette / paint / hue) | – |
| next texture (`t`) | – | ✔ | – |
| auto (`a`) | – | ✔ (config auto-cycle, §4.7) | – |
| autopilot / clear locks | – | – | ✔ |
| evolve / evolve now / shader edits / version | – | – | ✔ (bridge only) |
| copy state link / save json / load json | – | ✔ | – (state lives in the URL `#c=` / `?seed=` instead) |
| hide panel (`h`) | panel | panel | panel **and** HUD |

**fight** shares every avoid button/key (`space`, `r`, `n`, `m`, `d`, `f`, `p`, `a`, `h`) and adds `battle: on/off` (`b`); see §4.2c. The battle bar sits directly under the HUD.

Panel visibility: every build ships with the panel hidden on boot; `h` reveals it.

### 4.7 color's auto-mode (config cycling)

`auto: on` cycles the 14 configurations of `config/configs.js` in a shuffled, non-repeating
bag: each holds for `AUTO_DWELL` (120 s, URL `?dwell=<s>`) then crossfades physics, the
80-float rule, brightness, accumulation and solid fade over `AUTO_FADE` (10 s,
`?fade=<s>`); `view`/`blend`/`hard` snap to the target at fade start and a fresh texture is
picked each switch. The rule seed stays fixed across configs, so physics and colour morph
continuously rather than restarting. The HUD appends `auto i/N → j · <seconds left>`.

---

## 5. The evolve bridge

`evolve/bridge.mjs` (`node bridge.mjs [--port 8787] [--model provider/id]
[--thinking medium]`) serves the app pages from localhost:8787 and exposes:

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | bridge + model info |
| `POST /api/telemetry` | page → latest params/rule/GLSL/health/screenshot (< 120 s old accepted) |
| `POST /api/evolve` | runs one Pi agent step on the telemetry, returns a proposal (10-min step timeout) |
| `POST /api/verdict` | page's keep/roll-back decision — written to `history.jsonl` |
| `GET /api/versions[/:n]` | accepted shader versions |

The agent has **no** bash/edit/write tools — only `submit_params` (new params and/or an
80-float rule), `read_shader` / `edit_shader` / `write_shader` /
`submit_shader` (on `evolve/behavior.glsl`), and `skip`. Its prompt lives in
`system.md`: it is told the parameter ranges, the GLSL contract (§3.6), typical windows
(sensor_gain 0.5…6), and the health rules (fizzy > 0.55, dead < 12 % of reference), and it
sees a screenshot plus its own past verdicts. Every few minutes the page morphs to its
param proposals over the morph time; shader candidates compile into the dual-B program
(§3.6). Without the bridge, evolve UI stays disabled and the page behaves as a plain
autopilot.

---

## 6. config/ details

- **`configs.js`** — `window.HYPERCELLS_CONFIGS`, generated (*"keep in sync when you add
  configs"*) from the 14 `hypercells-*.json` snapshots. Each entry is `{c: {...16 physics
  keys + rule}, a: {view, blend, brightness, glow, simWorldSize, stepsPerFrame, hard,
  accum, solidFade, drawRadius, drawPower, seed}}`. Entries are anonymous; the color app's
  auto-mode shuffles through them.
- **`textures.js`** — `window.HYPERCELLS_TEXTURES`: 12 records `{name, img, pal}` where
  `img` is a 256-px JPEG preview (generated from ComfyUI outputs, `zimg-i2i-V5[-SQUARE]`
  batches) and `pal` is a 256×1 hue-sorted palette strip. These feed all three colour
  modes of the color build.
- The 4K/autopilot builds inline their 17 anchors (= these **14 configs + the 3 presets**
  HungryHungryHippos, Corners, 9LeafClovers) and ignore this folder.

---

## 7. Constants appendix

Shared (autopilot/4K unless noted): `FIXED_STEPS 2` (steps per frame), `DEPOSIT_SIGMA
0.163`, `SPEED_CAP_TEXELS 3.0`, `FORCE_MAX 0.5` — force may never *settle* at zero
(`FORCE_ZERO 0.02`, 1 s backstop; glides only pass through zero), `PERS_MIN/MAX
0.95/0.998`, `DRAG_MAX 0.95`, `RULE_SLEW_PER_SEC 3.0`, `HAZARD_MAX 0.05`, `HEALTH_N 32`
(health grid), family threshold gain < 2.2 with 15 % band padding, `RULE_COLS 24 / RULE_ROWS 20`
(cohort rule texture), good/bad health floor 12 % of a reference decaying 0.05 %/tick,
fizz ratio threshold 0.55, `MUTATE_SECONDS 5`, `EVO_BLEND_MIN_SEC 3`,
`GLSL_MAX_BYTES 6144`, `GLSL_LOOP_MAX 16`, `GLSL_LOOP_PRODUCT_MAX 32`,
`HUE_DRIFT_MAX 0.01`, `HUE_WOBBLE_MAX 0.05`, `PARTICLE_PX_MAX 4`,
`SPRITE_DIM_FRACTION 0.001125` (soft sprite = 1.152 texels), `BRUSH_REF_PARTICLES 600000`,
`SEC_PER_STEP = 1/120 s`.

simple-only: `PAINT_GAIN 0.016`, `PAINT_PERSISTENCE 0.995`, `DRAW_RADIUS 0.05`,
`DRAW_POWER 0.3`, `MUTATE_INTERVAL_MS 90000`, `HUE_DRIFT_PER_SEC 0.005`, `COLOR_NOISE
0.03`, `SPRITE_ASPECT 3.0` (velocity-aligned dashes). avoid/fight replace the fixed drift
with the `hue_drift` slider (0…0.01, default 0, old value 0.005).

color-only: `SPRITE_SIZE 1.5`, `TONEMAP_SOFTNESS 3.9`, `BRIGHTNESS_CONSTANT 2.0`,
`AUTO_DWELL 120`, `AUTO_FADE 10`, `TEX_FADE_MS 2500`, `ARTIFICIAL_HUES` (12 values).

fight-only: `POP_INTERVAL 30` frames between population readbacks, `WIN_SHARE 0.99`, blend
frames = `blend_seconds·60`, dominance key `floor(roll·65536)·32 + cohort`, local trait
`(0.9 + 0.2·hash(seed, cohort))·(1 + share)`, global defection rate
`aggression·0.5·(leaderShare − 0.5)` above 50%, `RULE_COLS 40 / RULE_ROWS 24`. Auto-mutate
is off (the rounds mutate). `STATE_INIT_FS`, `ROUND_FS`, `DOMINANCE_VS/FS`, `FIGHT_FS` and
`HISTOGRAM_VS/FS` are the added programs.

---

## 8. recordings/

Raw full captures (`.mp4`, from 2026-10-15/16 sessions) plus `segments/` (cut/crop
exports from a condensing script). The masters and the named segments are the project's
only output — do not treat them as disposable. The sort deleted ≈ 3.4 GB of finished
script leftovers (`segments/tmp_cleanx/`, `segments/tmp_clipsx/` re-encode duplicates and
`segments/condense_log.txt`); note the condense pipeline **recreates** its `tmp_*` 
working folders on every run, so clean them only while no condense run is active (check 
that `condense_log.txt` has stopped growing first) — and `.gitignore`d the whole folder
so it can never reach git.

---

## 9. Files & history hygiene

- `.gitignore`: added at the root (`recordings/`, OS noise). `evolve/.gitignore` already
  covers `node_modules/ sessions/ shots/ history.jsonl state.json`.
- The git index still reflects the **flat layout** (tracking `simple.html`,
  `autopilot.html`, `autopilot-4k.html`, `index.html`, `hypercells-evolve.html` at root).
  The working tree moved them into folders and this reorganisation is **not committed** —
  `git status` will list the deletions and the new folders; commit the sort when you are
  happy with it.
- S: is on a filesystem git calls "dubious ownership"; `git -c
  safe.directory=S:/PROJECTS/hypercells …` works without changing config.
- Old filename → new: `index.html` (rich interactive build) → `color/index.html`;
  `simple.html` → `simple/index.html`; `autopilot.html` →
  `evolve/hypercells-evolve.html` (the `hypercells-auto/` duplicate removed);
  `autopilot-4k.html` → `hypercells-4k/hypercells-4k.html`.
