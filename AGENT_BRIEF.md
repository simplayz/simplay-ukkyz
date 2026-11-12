# AGENT_BRIEF

Copy-paste prompts for starting a **new chat** in this repository without having the agent re-scan the codebase.

`README.md` is the knowledge base (architecture, conventions, recipes). This file is the prompt library: pick the
task that matches what you want to build, paste it, fill the `<…>` placeholders, delete anything that doesn't apply.

> **Why this works:** the prompts name the exact files, the exact order to touch them, the invariants that must not
> break, and the commands that prove the work is done. An agent that follows them opens 3–6 files instead of 15.

---

## 0. Universal preamble (put this first, always)

```text
Repo: simplayz/simplayz-ukkyz — Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4, three.js,
zustand, Drizzle ORM + PostgreSQL. Read README.md first: §4 (repo map), §9 (conventions + recipes), §7 (rules/numbers).

Rules for this task:
- Start from the repo map and the recipe matching my task; read only the files that recipe names.
  Do NOT scan the whole repository or read unrelated files "for context".
- Keep src/engine/** pure: no React/DOM/Drizzle/@/lib/server imports, no Date.now(), no Math.random().
- All client data flows through the zustand store (src/app/world/store.ts) using its api() helper — no fetch in components.
- All DB rows are mapped to DTOs declared in src/lib/types.ts, produced in src/lib/server.ts. Never send raw rows to the client.
- Keep the "degrade without a database" invariant: new DB reads/writes are wrapped so an outage falls back instead of throwing a 500.
- Reuse the existing design tokens and CSS utilities (panel, label, btn, chip, Modal, Bar) — no new colors unless I ask.
- Match local style: banner comments, why-not-what comments.

When done, run and report the result of:
  npm run typecheck
  npm run lint            (no NEW problems; baseline is listed in README §9)
  POSTGRES_URL=postgres://x:y@127.0.0.1:5432/x npm run build
Then summarise changed files and how you smoke-tested.
```

---

## 1. New UI/UX component (HUD panel, modal, overlay)

```text
Task: add a new <panel | modal | overlay> called "<Name>" that <what it shows / what it lets the user do>.

Follow recipe A in README §9 (UI/UX component) exactly:
1. src/app/world/panels.tsx — create and export <Name>; read state via useWorld((s) => …); reuse Modal / Bar / useTick
   and the .panel / .label / .btn / .chip utilities. Show me the component in place, styled like its neighbours.
2. src/app/world/page.tsx — mount it in the HUD tree. It must be pointer-events-auto if it receives clicks.
3. If it is a modal: extend the `panel` union in src/app/world/store.ts, render it in page.tsx, and make sure every
   path that should close modals sets panel: null.
4. If it needs new state or mutations: add them to the WorldStore interface and implementation in store.ts; call the
   API through api() and finish with refresh().
5. If it needs server data that is not in the snapshot: extend WorldSnapshot in src/lib/types.ts and snapshot() in
   src/lib/server.ts (do not add a bespoke fetch in the component).

Data it needs (exact fields): <e.g. claim.profile.histogram, player.credits, stats.tilesServed>
Interactions: <e.g. click a structure row -> setSelectedKind + setMode("build")>
Empty / error / loading states: <describe>
Acceptance: <e.g. panel is visible on /world at 1440×900, updates after placing a building, no layout overflow>
```

---

## 2. New API endpoint

```text
Task: add <METHOD> /api/<name> that <purpose>. Request <shape>; response <shape>.

Follow recipe B in README §9 (API endpoint):
1. src/lib/types.ts — declare request/response DTOs (camelCase).
2. src/lib/server.ts — a helper that does the query/work and maps rows to the DTO; wrap DB access so an outage
   returns a safe fallback instead of throwing.
3. src/app/api/<name>/route.ts — the handler. Pattern to copy: src/app/api/buildings/route.ts for a POST with an
   `action` union, or src/app/api/terrain/route.ts for a GET with query params. Required shape:
   `export const dynamic = "force-dynamic"`, pilotFrom(req) -> loadConfig() -> ensurePilot(), validate input,
   return Response.json({ ok, error?, ... }) with 400/401/403/404/409/500 as appropriate.
4. src/app/world/store.ts — an action that calls it via api(), applies the returned DTO to state, then refresh().
5. Add one row to the API table in README §5.

Auth: <pilot-scoped | public>
Validation: <rules, e.g. claim must be owned by the pilot; coordinates finite; name <= 28 chars>
Acceptance: <e.g. curl examples for happy path + each error code; store action covered by a manual click-through>
```

---

## 3. New table or column (model)

```text
Task: persist <entity/field> — <why it must live in Postgres>.

Follow recipe C in README §9 (table/column):
1. src/db/schema.ts — add the table/column in snake_case with sensible NOT NULL defaults; use
   .references(..., { onDelete: "cascade" }) where it belongs to a claim/player; export the inferred row type.
2. Generate SQL: `npx drizzle-kit generate` and commit the generated file in ./drizzle (or tell me to run
   `npx drizzle-kit push` for local dev only).
3. src/lib/types.ts — add/extend the DTO.
4. src/lib/server.ts — row->DTO mapper plus the read/write helpers; keep the try/catch fallback convention.
5. If the client reads it: add it to WorldSnapshot + snapshot(); consume through store boot()/refresh().
6. If it is writable: add the route per the API recipe (run the API prompt too if a new file is needed).

Columns I want: <name type (pg type) default, purpose — one per line>
Relationships: <e.g. many buildings -> one claim; cascade delete with claim>
Migration notes: <is this additive, or does data need backfilling?>
Acceptance: schema generates clean SQL, typecheck passes, a round-trip <insert then read> works through the API.
```

---

## 4. New build kind / structure

```text
Task: add build kind "<key>" (<name>) to the catalogue.

Follow recipe D in README §9 (build kind):
1. src/engine/buildings.ts — append to BUILD_KINDS only. Then verify, without duplicating, that KIND_MAP,
   CATEGORY_LABEL, the palette (panels.tsx), the placement validator (simulation.ts) and the API all pick it up.
2. src/engine/simulation.ts — only if the mechanics need it (needsRoad, minFarm, special totals).
3. src/app/world/viewport.tsx — only if the generic mesh factory cannot express it; otherwise no viewer change.

Kind spec: key=<key>, name=<name>, category=<habitat|food|industry|commerce|civic|network|defense|luxury>,
cost=<cr>, upkeep=<cr/tick>, footprint=[w,d], floorHeight=<m>, storeys=<n>, color=<hex>, roof=<flat|pitch|dome|none|panels>,
population/income/food/power/defense/prestige=<numbers>, needsRoad=<yes/no>, minFarm=<or omit>, blurb="<one sentence>"
Balance intent: <what this structure is for, and which existing kind it competes with>
Acceptance: it appears in the palette, can be placed through POST /api/buildings, appears in computeTotals output,
and renders in /world without a viewer edit (or with the minimal edit you describe).
```

---

## 5. New biome / terrain behaviour

```text
Task: add biome "<key>" (<name>) — <how the ground should be classified>.

Follow recipe E in README §9 (biome):
1. src/engine/terrain.ts — append to BIOMES. IMPORTANT: `id` must equal the array index (classify() and
   SurveyCell.b index into it).
2. classify() — add/retune a branch that emits it, and say which thresholds you changed.
3. Do not touch consumers (survey, palette, minimap, landing page, costs) — they read from BIOMES.
4. Tell me whether cached surveys must be invalidated (README §9 guardrail 12) and how.

Spec: key=<key>, name=<name>, color=<hex>, fertility=<0..1>, cover=<multiplier>, walk=<speed multiplier>,
costMod=<build cost multiplier>, buildable=<yes/no>
Classification intent: <e.g. "hilltops above 200 m with slope > 18 and forest < 0.2">
Acceptance: /api/terrain for a coordinate in that region reports the new biome index; placement cost/refusal follows it.
```

---

## 6. New world config knob

```text
Task: add a tunable "<dtoKey>" (column <snake_case>) to world_config, default <value> — it should change <behaviour>.

Follow recipe F in README §9 (world_config knob). Touch these in this order and nowhere else:
1. src/db/schema.ts            2. drizzle-kit generate
3. src/lib/server.ts (DEFAULT_CONFIG + mapConfig)   4. src/lib/types.ts (WorldConfigDTO)
5. src/app/world/store.ts (FALLBACK_CONFIG)         6. src/app/page.tsx (config spread mapping)
7. src/app/world/panels.tsx (ConfigModal field)     8. src/app/world/viewport.tsx (only if the scene depends on it)

Where the value is consumed: <file:function — e.g. lib/server.ts createClaim>
Clamp/validation: <e.g. 1..256>
Acceptance: PATCH /api/config round-trips it; ConfigModal edits it live; the behaviour changes on the next snapshot.
```

---

## 7. End-to-end feature

```text
Task (feature): <one paragraph: the player-visible outcome>.

Work in this order (README §9 recipe G) and show me a file list before you start:
engine (pure maths/catalogue) -> schema + migration -> lib/types -> lib/server -> api/route -> store action/state
-> panels UI -> viewport scene -> README tables -> smoke test.

Scope guard: do not refactor unrelated modules, do not "fix" the lint baseline in README §9, do not add
dependencies without asking. If the feature needs a new dependency or a schema change you weren't told about,
stop and ask first.

Out of scope: <things an eager agent might also "clean up">
Acceptance: <the 3–5 checks a reviewer will perform, phrased as user actions>
```

---

## 8. Bug fix / small change

```text
Task: fix <symptom> in <route|panel|engine function>.

Start here: <file:function or line>, then follow the import graph only as far as needed.
Reproduce: <exact steps / curl>
Expected: <…>   Actual: <…>
Constraints: keep the change minimal; don't reformat surrounding code; if the bug's root cause is in an invariant
from README §3, tell me which one was violated before fixing.
Acceptance: the reproduction no longer fails, typecheck/lint/build per README §9, and you can explain the root cause
in two sentences.
```

---

## 9. Review / audit request

```text
Task: review the change on this branch against README §9 conventions.

Check specifically: engine purity; DTO boundary (no raw rows to client); store-only client data flow;
API envelope + status codes; degrade-without-DB on new calls; design tokens only (no stray hex);
viewer rebuild keys (claimsKey/sectorKey) if scene data changed; schema/migration included if the model changed.
Report findings as: file:line — rule violated — suggested fix. Don't edit files unless I say "fix them".
```

---

## 10. Where to point the agent (cheat sheet)

| You want to change… | Open first | Then |
| --- | --- | --- |
| A HUD panel's layout or copy | `src/app/world/panels.tsx` | `page.tsx` if it moves |
| A new modal / open-close behaviour | `panels.tsx` + `store.ts` (`panel` union) | `page.tsx` mount |
| Anything about the 3D scene | `src/app/world/viewport.tsx` (`applyView`, `claimsKey`, `sectorKey`) | `globals.css` for tokens |
| Game rules (costs, defence, assault) | `src/engine/simulation.ts` | `src/engine/buildings.ts` |
| Terrain shape / biomes | `src/engine/terrain.ts` | cache invalidation (README §9.12) |
| An endpoint's behaviour | its `src/app/api/**/route.ts` | `src/lib/server.ts` helper |
| What the client can see | `src/lib/types.ts` (`WorldSnapshot`) | `lib/server.ts` `snapshot()` |
| A persisted field | `src/db/schema.ts` | migration + DTO + mapper |
| Live-tunable numbers | `src/db/schema.ts` → `lib/server.ts` → `store.ts` → `ConfigModal` | README §6 |
| Styling / colors / animations | `src/app/globals.css` | — |

---

## Keeping this file useful

When a recipe changes (a file moves, a layer is added), update **both** `README.md` §9 and the matching prompt here in
the same PR. The prompts are only cheap if they stay true; a stale brief is worse than no brief.
