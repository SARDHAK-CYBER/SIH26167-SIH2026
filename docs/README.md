# SatQuery AI

**An interactive vision-language assistant for multimodal remote-sensing image analysis through text queries.**

Built for ISRO / SAC Problem Statement **26167**. SatQuery AI is a local web application that accepts remote-sensing imagery (single images, co-registered optical–SAR pairs, or bi-temporal pairs) plus a natural-language query, routes the query to a task-specific workflow through an agentic controller, and returns an evidence-grounded textual + visual answer with an auditable execution trace.

---

## Table of contents

1. [What this repository contains](#what-this-repository-contains)
2. [Architecture](#architecture)
3. [Quick start](#quick-start)
4. [Configuration (`.env`)](#configuration-env)
5. [Feature reference](#feature-reference)
6. [Agentic controller & tool registry](#agentic-controller--tool-registry)
7. [Model service contract](#model-service-contract)
8. [HTTP API](#http-api)
9. [Scripts](#scripts)
10. [Testing](#testing)
11. [Project layout](#project-layout)
12. [Known limitations & what remains for PS 26167](#known-limitations--what-remains-for-ps-26167)
13. [Provider documentation](#provider-documentation)

---

## What this repository contains

| Layer | Description | Status |
|---|---|---|
| **Web dashboard** (`src/`) | React 19 + TypeScript single-page app: imagery collection, raster viewer with zoom/compare slider, fusion workbench, query composer, results panel (answer / evidence / trace tabs), JSON report export. | Implemented |
| **Local API** (`server/`) | Zero-framework Node HTTP server (loopback only). Serves the built dashboard and proxies Copernicus Sentinel Hub, a JP2 decoder, geocoding, and model inference. | Implemented |
| **Raster ingestion** (`src/services/observationReader.ts`) | Real GeoTIFF/TIFF decoding in the browser (`geotiff`), local JP2/J2K/JPX decoding via Python + Rasterio, PNG/JPEG visual decoding. Dimensions, bands, GeoKeys/CRS, bounding box, sampled per-band statistics. | Implemented |
| **Copernicus integration** (`server/sentinel.ts`, `server/catalog.ts`) | Server-side OAuth (client credentials), Catalog API date discovery with full pagination, Process API AOI GeoTIFF retrieval for Sentinel-2 L2A and Sentinel-1 GRD. | Implemented, live-verified |
| **Task classifier & pre-checks** (`src/services/fusionPlan.ts`, `src/services/workspaceAnalysis.ts`) | Query→task classification with observable signals + confidence (`classifyTask`), temporal/CRS/footprint pre-checks, `assessCoRegistration` for pairs, input selection, execution-trace assembly. | Implemented |
| **Agentic controller** (`server/orchestrator.ts`, `server/registry.ts`) | Declarative specialist **tool registry**, ordered tool-chain selection, per-tool permitted-parameter whitelisting, VLM-adapter execution with automatic fallback to measurement specialists, output fusion, confidence estimate, auditable execution summary. | Implemented |
| **Measurement specialists** (`server/specialists.ts`) | Deterministic, evidence-grounded computation from the measured band statistics: scene-mean NDVI/NDWI/NDBI, SAR VV/VH, bi-temporal index/band deltas, optical–SAR side-by-side reading. No fabricated figures. | Implemented |
| **Inference adapter** (`server/aiService.ts`) | Multimodal VLM path: OpenRouter or Google Gemini, or a separate `MODEL_API_URL` orchestrator that owns the whole request. Not remote-sensing-adapted — see limitations. | Implemented |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (React 19 SPA)                                               │
│                                                                      │
│  App.tsx ── observationReader ─► geotiff decode / JP2 fetch / bitmap  │
│        │                                                             │
│        ├── fusionPlan.planFusion() ─► temporal + CRS + overlap check │
│        ├── fusionPlan.classifyTask() ─► task + signals + confidence  │
│        ├── fusionPlan.assessCoRegistration() ─► pair alignment grade │
│        └── workspaceAnalysis.analyzeWorkspace()                       │
│              │  inspection mode → measured metadata only             │
│              │  model mode      → POST /api/analyze (stats+previews)  │
└──────────────┼───────────────────────────────────────────────────────┘
               │  loopback HTTP :8787  (origin restricted to localhost)
┌──────────────▼───────────────────────────────────────────────────────┐
│  Node HTTP server (server/index.ts, TypeScript run directly)         │
│                                                                      │
│  /api/status /api/config/model   runtime + provider status/config    │
│  /api/location/search            Nominatim (OpenStreetMap) geocoding │
│  /api/sentinel/check|search|raster  OAuth · Catalog · Process (AOI)  │
│  /api/raster/jp2                 Rasterio/GDAL JP2 → GeoTIFF preview  │
│  /api/analyze ─► orchestrator.ts (agentic controller)                │
│        1 classify · 2 validate · 3 select tools from registry.ts     │
│        4 whitelist params · 5 execute · 6 fuse · 7 execution summary  │
│        primary tool = VLM adapter (aiService.ts) if a provider is set,│
│        else measurement specialists (specialists.ts); VLM failure     │
│        falls back to the measurement specialist for the task.        │
└──────────────────────────────────────────────────────────────────────┘
               │                              │
      Copernicus Data Space          OpenRouter / Gemini / your MODEL_API_URL
```

- **Stack:** React 19, TypeScript ~6, Vite, Tailwind CSS 4, `lucide-react`, `geotiff`. Server uses only Node built-ins plus `express` types; TypeScript files are executed directly (Node 24+).
- **State:** imagery lives in browser memory and is lost on refresh. Session Q&A memory (last 8 turns) is kept in `sessionStorage` and passed to the model as prior context.
- **Isolation:** the server binds `127.0.0.1` and rejects any non-`localhost` `Origin`. Request bodies are capped at 160 MB. Secrets are stripped from provider error messages and never logged.

---

## Quick start

**Requirements:** Node.js 24+ (the server runs `.ts` directly). Python 3 is optional and only needed for JP2/JPEG2000 files.

```bash
# 1. Install dependencies (pnpm lockfile is authoritative)
pnpm install

# 2. Configure credentials
cp .env.example .env
#    then edit .env — see "Configuration" below

# 3. (optional) install the JP2 decoder into the project .venv
npm run setup:jp2

# 4. Build the dashboard and start the local server
npm start
#    open http://127.0.0.1:8787/
```

In the app: open **Settings & Guide → Copernicus Sentinel**, confirm credentials, then use **Test Sentinel connection** and **Find imagery**. Upload and inspection of local files work without any credentials.

For frontend-only iteration use `npm run dev` (Vite dev server, no API). Use `npm start` for the complete local app.

---

## Configuration (`.env`)

Server-side only. **Never** place secrets in `VITE_*` variables — those are bundled into the client.

| Variable | Required | Purpose |
|---|---|---|
| `SENTINEL_PROVIDER` | yes | `cdse` (Copernicus Data Space, default) or `sentinelhub`. |
| `SENTINEL_CLIENT_ID` | for Sentinel | OAuth client id. |
| `SENTINEL_CLIENT_SECRET` | for Sentinel | OAuth client secret. |
| `OPENROUTER_API_KEY` | optional | Enables OpenRouter multimodal inference. |
| `OPENROUTER_MODEL` | optional | Model id (default `google/gemma-4-31b-it:free`; automatic fallback to `google/gemma-4-26b-a4b-it:free` on HTTP 429). |
| `GEMINI_API_KEY` | optional | Enables Google Gemini (`gemini-2.0-flash`) inference. |
| `MODEL_API_URL` | optional | Your own remote-sensing model/orchestrator endpoint. Leave empty unless it is a *separate* inference service — it must not point at this dashboard/API. |
| `MODEL_API_KEY` | optional | Sent as `Authorization: Bearer …` to `MODEL_API_URL`. |
| `SATQUERY_MASTER_KEY` | optional | Passphrase that decrypts a committed `.env.enc` at runtime (see [Secrets & open-sourcing](#secrets--open-sourcing)). Set it in your shell/CI — never in a file. |

Provider precedence when several are set: `OPENROUTER_API_KEY` → `GEMINI_API_KEY` → `MODEL_API_URL` → built-in engine. Config sources merge as **process env < `.env.enc` < `.env`**. The API re-reads them on every request; the model provider can also be switched at runtime from **Settings & Guide → AI Model Setup** (`POST /api/config/model`).

If no model provider is configured, `/api/analyze` runs the measurement specialists; the client's inspection mode (`useModel = false`) returns measured metadata only with `confidence: null`.

### Secrets & open-sourcing

`.env` holds real keys and is git-ignored — **never commit it**. To publish this repo with working credentials without exposing them:

```bash
npm run secrets encrypt          # .env  ->  .env.enc   (AES-256-GCM, scrypt KDF)
git add .env.enc                  # ciphertext is safe to commit
SATQUERY_MASTER_KEY=… npm start   # server auto-decrypts .env.enc at runtime
```

- The master key is supplied out-of-band (`SATQUERY_MASTER_KEY`, `--key=`, or an interactive prompt) and is never written to disk or the repo.
- `npm run secrets check` verifies `.env.enc` decrypts; `npm run secrets decrypt --out` restores a local `.env`.
- A local plaintext `.env` still takes precedence, so day-to-day development is unchanged.
- Encryption-at-rest is only as strong as key handling — for maximum safety still prefer **not shipping secrets at all** (`.env.example` + each user brings their own keys). If a key was ever committed in plain text, rotate it.

---

## Feature reference

### Input handling
- Multiple **GeoTIFF/TIFF** uploads, decoded in-browser: width/height, band count, GeoKeys → `EPSG:` CRS, bounding box, GDAL no-data, and per-band min/max/mean/valid-pixel statistics on a preview-sized sample. Corrupt files fail explicitly — no synthetic fallback raster.
- **JP2 / J2K / JPX** decoded locally via GDAL/OpenJPEG through project-pinned Rasterio (`rasterio==1.5.1`). The original file remains the inference input; only a nearest-neighbour, ≤768 px display/statistics raster is derived. CRS and geotransform are preserved when present. 1–16 bands, ≤128 MB. SAFE ZIP archives must be extracted first.
- **PNG / JPEG** visual images (including Sentinel quicklooks) load directly; missing georeferencing and spectral calibration are flagged. The optional benchmark label is a user declaration, not authenticated membership.
- Sensor types: **optical, multispectral, SAR, thermal, hyperspectral, LiDAR raster**. LAS/LAZ/PLY/PCD/E57 point clouds and HDF/NetCDF/ENVI containers are rejected with conversion guidance. SAR products are tagged SLC vs GRD from filename/metadata with processing caveats.
- Acquisition dates are optional for single-image inspection and **required** for temporal pairing.

### Viewer
- Raster preview with zoom (100–300 %), fullscreen, N/compass indicator, live CRS + pixel-dimension readout.
- Two-image **comparison slider** (clearly labelled "alignment not verified").
- **Evidence overlay**: normalized `[xmin, ymin, xmax, ymax]` boxes from the model are drawn as SVG rectangles on the selected image.

### Location & Sentinel discovery
- **Location resolution** ([`server/geocode.ts`](server/geocode.ts)), no hard-coded places:
  - A **place name** → OpenStreetMap **Nominatim** forward search → up to 5 matches. A city/region keeps its (span-clamped ≤ 1.8°) OSM extent; a point-like result gets the radius box below.
  - A single **`latitude, longitude`** (also `lat lon` / `lat;lon`) → a square AOI of **3 km half-extent** (~6 × 6 km) centred on the point, with a reverse-geocoded label. Override with `?radiusKm=` (0.5–100).
- Server-only Copernicus **OAuth**, **Catalog API** date discovery (`/catalog/v1/search`), **Process API** AOI retrieval (`/process/v1`).
- **Latest** mode queries the last 30 days first, then falls back to full history (from 2014). **Range** mode does inclusive matching and, when empty, returns the nearest available date before and after, sorted by temporal distance. Pagination is followed to completion before any "latest/nearest" claim; incomplete pagination fails explicitly.
- Up to 12 dates per sensor and 100 scenes per date; truncation is disclosed.
- Output bands — Sentinel-2 L2A: `B02, B03, B04, B08, B11, B12, SCL, dataMask`; Sentinel-1 GRD: `VV, VH, dataMask` (DV dual-pol only). Processed AOI rasters are **768 × 768**, not native resolution.

### Fusion workbench
- Target-date fusion prep with same-day or ± {1, 3, 7, 14, 30}-day windows.
- Excludes undated / out-of-window images; checks common CRS and shared bounding-box footprint.
- These are **pre-checks only** — pixel-level co-registration, resampling, calibration and mask handling are the responsibility of the model service.
- Bi-temporal requests require exactly two dated, overlapping, common-CRS images; a missing second image is never synthesized.

### Results & reporting
- Tabs: **answer** (natural-language answer, confidence, key findings, warnings), **evidence** (measured per-band statistics tables), **trace** (ordered tool-execution log).
- One-click **JSON report** download (`satquery-analysis.json`) containing the query, routed task, answer, findings, warnings, confidence, full trace, evidence boxes, `spatialMetrics`, the `executionSummary` (task, tool ids/versions, applied parameters), and sanitized observation metadata (no local paths, no previews).

---

## Agentic controller & tool registry

The client classifies the query and validates inputs; the server's controller ([`server/orchestrator.ts`](server/orchestrator.ts)) selects and runs the specialist chain.

**1 — Query interpretation.** `classifyTask(query, imageCount)` in [`src/services/fusionPlan.ts`](src/services/fusionPlan.ts) returns `{ task, confidence, signals, rationale }`. `routeTask` remains the routing authority; `classifyTask` records *why* in the trace.

| Routed task | Signal cues (case-insensitive) | Input rule enforced before inference |
|---|---|---|
| `change_vqa` | change / before / after / increase / decrease / over time | exactly 2 dated images, different dates, common CRS, overlapping footprints |
| `multisensor_fusion` | fuse / together / combine / cross-modal / complement / optical+SAR | ≥ 2 sensor types in the temporal window, common CRS, shared overlap |
| `grounding` | highlight / locate / ground / where is / bounding / delineate | selected single image |
| `spectral_analysis` | ndvi / ndwi / ndbi / spectral index / backscatter | selected single image |
| `captioning` | describe / caption / land-cover / what is visible / summarise | selected single image |
| `vqa_single` | default when images are present | selected single image |
| `input_validation` | default when no images | — |

**2 — Input & modality validation.** `input-compatibility-checker` re-verifies count, modality, dating, georeferencing and band metadata for the routed task.

**3 — Tool selection from the registry.** [`server/registry.ts`](server/registry.ts) is the predefined registry. `selectToolChain` builds an ordered chain: `input-compatibility-checker` → (`co-registration-assessor` for pairs) → **primary specialist**. The primary is `rs-vlm-adapter` when a model provider is configured, otherwise the measurement specialist registered for the task.

| Tool id | Kind | Serves | Permitted parameters |
|---|---|---|---|
| `input-compatibility-checker` | validator | all tasks | — |
| `co-registration-assessor` | assessor | `change_vqa`, `multisensor_fusion` | — |
| `rs-vlm-adapter` | vlm | all tasks | `temperature`, `topP`, `maxTokens`, `responseFormat` |
| `bigearthnet-scene-descriptor` | measurement | `captioning`, `vqa_single` | `topKClasses` |
| `spectral-index-engine` | measurement | `spectral_analysis`, `vqa_single` | `indices` |
| `bitemporal-change-analyzer` | measurement | `change_vqa` | `changeThreshold` |
| `optical-sar-fusion-analyzer` | measurement | `multisensor_fusion` | `speckleFilter`, `fusionMode` |
| `text-region-grounder` | measurement | `grounding` | `iouThreshold` |

**4 — Permitted-parameter whitelisting.** `whitelistParameters(toolId, requested)` forwards only keys in that tool's `permittedParameters` (merged over its registry defaults); every rejected key is logged in the trace.

**5 — Execution.** The chain runs in order. If `rs-vlm-adapter` throws (provider error, rate limit, invalid JSON) the controller **falls back** to the measurement specialist for the task and records the failure. For `spectral_analysis`, the spectral engine runs alongside the VLM so the answer carries verifiable numbers.

**6 — Fusion & confidence.** Textual + spatial outputs are merged. The VLM path uses the model's calibrated confidence or `null`; the measurement path uses a documented, capped heuristic — `0.2 + 0.35·validDataFraction + 0.1·coRegistrationFactor`, clamped to ≤ 0.6 — or `null` when no valid-data fraction is available. No confidence is ever invented.

**7 — Execution summary.** Every response carries `executionSummary` (`task`, classification, and each tool's `id` / `version` / applied `parameters`) plus a matching `Execution Summary` trace entry. Internal planning text is neither produced nor evaluated.

### Measurement specialists ([`server/specialists.ts`](server/specialists.ts))

The "no model provider" path is **computed, not templated**. Using the per-band `min/max/mean/valid-pixel` statistics the browser measured from the original raster:

- **Band roles** are resolved for Sentinel-2 L2A (`B02,B03,B04,B08,B11,B12,SCL,dataMask`) and Sentinel-1 GRD (`VV,VH,dataMask`); otherwise only raw band values are reported.
- **Spectral indices** — scene-mean `NDVI=(NIR−Red)/(NIR+Red)`, `NDWI=(Green−NIR)/(Green+NIR)`, `NDBI=(SWIR1−NIR)/(SWIR1+NIR)`; SAR `VV−VH` — each reported with its formula and input values, and flagged as AOI-wide means (not per-pixel index maps).
- **Change** — per-index and per-band mean deltas between the two acquisitions, with `increased / decreased / unchanged` per proxy and a mean-relative-band-change score.
- **Optical–SAR** — optical valid-data fraction and cloud, SAR backscatter means, and a side-by-side complementary reading, plus the co-registration grade.
- **Grounding** — feature description only; the measurement path returns no bounding boxes and says so.

---

## Model service contract

`MODEL_API_URL` is an optional server-side endpoint for **your** adapted remote-sensing model / orchestrator. When set, it **owns the whole `/api/analyze` request**: the local API forwards the body unchanged and returns its response; the built-in controller runs only if that call fails. `MODEL_API_KEY`, if set, becomes the `Authorization: Bearer` header. JSON-first services receive:

```jsonc
// POST body to /api/analyze (also forwarded to MODEL_API_URL)
{
  "query": "…user question…",
  "task": "change_vqa",              // routed task
  "targetDate": "2026-09-08",
  "toleranceDays": 3,
  "sessionMemory": [ { "query": "…", "answer": "…", "observationNames": ["…"] } ],
  "observations": [
    {
      "id": "…", "name": "…", "sensor": "sar", "date": "2026-09-06",
      "bands": 3, "width": 768, "height": 768,
      "crs": "EPSG:4326", "bounds": [w, s, e, n],
      "collection": "sentinel-1-grd", "cloudCover": 4, "resolution": 10,
      "sarProduct": "grd",
      "stats": [ { "band": 1, "min": 0, "max": 1, "mean": 0.07, "validPixels": 1000 } ],
      "previewBase64": "data:image/png;base64,…"   // display raster only
    }
  ]
}
```

Your service must return JSON of this shape (invalid shapes are rejected by the client):

```json
{
  "answer": "An evidence-grounded answer from your model.",
  "findings": ["A result supported by source imagery."],
  "confidence": null,
  "warnings": [],
  "trace": [
    { "tool": "Your specialist name and version", "status": "completed",
      "detail": "Adaptation dataset, actual parameters, alignment checks, output summary." }
  ],
  "evidence": [
    { "observationId": "id-from-request", "label": "Detected region", "box": [0.1, 0.2, 0.3, 0.4] }
  ]
}
```

- `box` is normalized `[xmin, ymin, xmax, ymax]` relative to the referenced image.
- `confidence` is `null` when uncalibrated, otherwise a number in `[0, 1]`.
- Task names your registry should handle: `vqa_single`, `captioning`, `grounding`, `change_vqa`, `multisensor_fusion`, `spectral_analysis`.
- The adapter must validate the raster itself, honour no-data / cloud masks, calibrate physical units, verify overlap, and perform reprojection / resampling / **co-registration**. Bounding-box and metadata checks alone do not establish aligned pixels.

---

## HTTP API

All endpoints are loopback-only and reject non-`localhost` origins.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/status` | Sentinel-credential presence, active model provider, model errors. |
| `GET` | `/api/location/search?q=&radiusKm=` | Resolve a place name (Nominatim) or a `lat,lon` pair → AOI matches; single coordinates get a 3 km-radius box. |
| `GET` | `/api/config/model` | Current model-provider configuration (no secret values). |
| `POST` | `/api/config/model` | Update model provider / keys / model id at runtime. |
| `POST` | `/api/sentinel/check` | Acquire an OAuth token to verify credentials. |
| `POST` | `/api/sentinel/search` | Catalog date discovery for an AOI + collections + mode. |
| `POST` | `/api/sentinel/raster` | Retrieve a 768×768 AOI GeoTIFF for one scene. |
| `POST` | `/api/raster/jp2` | Decode a raw JP2 body → bounded GeoTIFF (+ `X-Raster-Metadata`). |
| `POST` | `/api/analyze` | Forward to `MODEL_API_URL` if set, else run the agentic controller (`orchestrator.ts` + `registry.ts`). |
| `GET` | `/*` | Serve the built dashboard from `dist/`. |

---

## Scripts

| Command | Action |
|---|---|
| `npm start` | `vite build` then launch the Node server on `:8787` (dashboard + API). |
| `npm run dev` | Vite dev server only (frontend, no API). |
| `npm run api` | Run the Node server without rebuilding. |
| `npm run build` | Production build into `dist/`. |
| `npm run lint` | `oxlint` (React + TypeScript rules). |
| `npm test` | `node --test` over `tests/*.test.ts` and `tests/*.test.mjs`. |
| `npm run setup:jp2` | Create `.venv` and install `rasterio` for JP2 decoding. |
| `npm run secrets <cmd>` | `encrypt` / `decrypt` / `check` the `.env` ↔ `.env.enc` (see [Secrets & open-sourcing](#secrets--open-sourcing)). |

---

## Testing

`npm test` runs seven suites with **real** fixtures (no mocked decoders); 40 JS assertions pass, 1 skips without Python:

| Suite | Covers |
|---|---|
| `tests/workspace.test.ts` | `selectDates` latest/range/nearest logic, `validateSearch` guards, `searchCatalog` pagination-before-"latest", `planFusion` / `routeTask`. |
| `tests/analysis.test.mjs` | `analyzeWorkspace` uses the selected image, reports `confidence: null` in inspection mode, refuses to synthesize a missing temporal image, blocks undated fusion inputs. |
| `tests/orchestrator.test.mjs` | Registry parameter whitelisting, tool-chain selection, band-role resolution, **real NDVI/NDWI from band means**, bi-temporal index deltas, `assessCoRegistration` grading, `classifyTask` signals, and `orchestrate()` end-to-end (measurement path) returning an auditable execution summary. |
| `tests/geocode.test.mjs` | `parseLatLon`, `boxFromCenter` (3 km radius, latitude-corrected longitude), `clampBoxSpan`, and `resolveLocation` for coordinate / city / point / unresolvable inputs (fetch stubbed). |
| `tests/envcrypto.test.mjs` | `.env` encrypt→decrypt round-trip, no plaintext in ciphertext, wrong-key and tampered-ciphertext rejection, malformed-input handling. |
| `tests/raster.test.mjs` | Real GeoTIFF encode/decode, measured values + EPSG, corrupt-file rejection, point-cloud rejection, PNG/JPEG admission without a benchmark declaration. (Canvas rendering is stubbed.) |
| `tests/jp2.test.ts` | JP2 signature validation; real 16-bit georeferenced JP2 decode preserving raw values and CRS. **Skipped** when the `.venv` Python is not runnable — run `npm run setup:jp2` first. |

---

## Project layout

```
server/
  index.ts            HTTP server, routing, static hosting
  config.ts           .env + .env.enc parsing + runtime model overrides
  envcrypto.ts        AES-256-GCM encrypt/decrypt for .env (pure functions)
  geocode.ts          place name / "lat,lon" → AOI (Nominatim + 3 km radius box)
  sentinel.ts         OAuth token cache + Catalog/Process request helper
  catalog.ts          AOI validation, date selection, paginated search
  jp2.ts              JP2 signature check + Rasterio subprocess bridge
  jp2_preview.py      Rasterio JP2 → bounded GeoTIFF preview
  orchestrator.ts     agentic controller (classify → validate → select →
                      whitelist params → execute → fuse → execution summary)
  registry.ts         predefined specialist tool registry + param whitelist
  specialists.ts      measurement-grounded specialists (NDVI/NDWI/NDBI,
                      SAR VV/VH, bi-temporal deltas, optical-SAR reading)
  aiService.ts        multimodal VLM adapter (OpenRouter / Gemini)
src/
  App.tsx             main workspace UI + state
  components/
    WorkspaceDialogs.tsx   upload modal + settings/model-config modal
    WorkspaceResults.tsx   answer / evidence / trace tabs + JSON export
  services/
    observationReader.ts   GeoTIFF / JP2 / PNG-JPEG ingestion
    fusionPlan.ts          planFusion, routeTask, classifyTask, assessCoRegistration
    workspaceAnalysis.ts   inspection vs model analysis orchestration
  types/workspace.ts       active type definitions
tests/                  node:test suites (workspace, analysis, orchestrator, geocode, envcrypto, raster, jp2)
scripts/setup-jp2.mjs   JP2 decoder installer
scripts/secrets.mjs     .env ↔ .env.enc CLI
```

The earlier `Atlas*` / `specialists/*` / `atlasOrchestrator` / `reportGenerator` / `rasterEngine` / `data/datasets` / `types/index` prototype (canned demonstration outputs, never imported by the running app) has been **removed**. `jspdf` and `html2canvas` in `package.json` are now unused and can be dropped on the next lockfile update.

---

## Known limitations & what remains for PS 26167

This repository delivers the **interface, ingestion, agentic controller with a specialist tool registry, measurement-grounded specialists, and provider integration**. It does **not** include:

- Trained / fine-tuned model weights, or **BigEarthNet.txt** (or equivalent) domain adaptation of a visual component.
- A learned optical–SAR fusion model, automatic pixel **co-registration**, semantic segmentation, or reference-mask change maps. (`assessCoRegistration` *grades* alignment; it does not perform it.)
- Per-pixel spectral-index rasters (the engine computes AOI **scene-mean** indices from sampled statistics) or benchmark evaluation harnesses for VRSBench, RSVQA, CDVQA.

Behaviour today:

- With **no model provider configured**, `/api/analyze` runs the measurement specialists: real scene-mean NDVI/NDWI/NDBI, SAR VV/VH, and bi-temporal deltas computed from the measured band statistics, with a documented capped confidence and a full execution summary. No figures are fabricated; spatial localisation (bounding boxes) is not attempted.
- With **OpenRouter / Gemini** configured, `rs-vlm-adapter` answers from the preview images + band statistics; on any provider failure the controller falls back to the measurement specialist for the task. A general multimodal VLM is **not** a remote-sensing-adapted model and does not satisfy MFS-1 on its own.
- The client's **inspection mode** (used when the caller passes `useModel = false`) still returns measured metadata only with `confidence: null`.

To fully meet PS 26167, register a domain-adapted model as `rs-vlm-adapter`'s backend (via `MODEL_API_URL` or by extending `aiService.ts`) that implements: BigEarthNet-style adaptation, single-image VQA **plus** captioning or grounding, bi-temporal change understanding, co-registered optical–SAR analysis, and genuine specialist execution — the registry, parameter whitelisting, fusion, confidence and execution-summary plumbing is already in place.

**Live-integration check (2026-09-10):** Copernicus OAuth, Catalog discovery, and Process retrieval were verified with the configured credentials for AOI `[72.79, 18.90, 72.88, 18.98]` — Sentinel-2 (2026-09-08, eight bands) and Sentinel-1 (2026-09-06, three bands), both 768 × 768 with valid mask samples. This verifies the tested account and AOI, not every mission or product.

### Hosting

The server is a loopback Node process with Vite's `/api` proxy. A static-only deployment loses every server-backed workflow. Public hosting requires porting the API to a server runtime plus secret management, authentication, upload limits, origin restrictions, and rate limiting. The current deliverable is the local workspace.

---

## Provider documentation

- [Copernicus OAuth](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html)
- [Catalogue examples and pagination](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Catalog/Examples.html)
- [Sentinel-2 processing](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Process/Examples/S2L2A.html)
- [Provider data fusion](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DataFusion.html)
