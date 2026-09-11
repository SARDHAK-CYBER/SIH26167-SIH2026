# Product Requirements Document — SatQuery AI

| Field | Value |
|---|---|
| **Product** | SatQuery AI — Interactive Vision-Language Assistant for Multimodal Remote-Sensing Image Analysis through Text Queries |
| **Problem statement** | ISRO / SAC **PS 26167** |
| **Organization** | Indian Space Research Organisation (ISRO) / Space Applications Centre (SAC) |
| **Document status** | Draft — reconciled with the current codebase |
| **Last updated** | 2026-09-10 |
| **Repository** | `Project-FAAH` (local workspace: React 19 + TypeScript SPA + Node loopback API) |

---

## 1. Background & problem

Remote-sensing imagery underpins agricultural monitoring, disaster management, urban planning, forest and water-resource assessment, infrastructure mapping, and environmental analysis. Yet most operational remote-sensing AI tools are **single-task, single-image** applications (land-cover classification *or* detection *or* VQA *or* change detection) that assume the user understands satellite-data characteristics, GIS workflows, model selection, and task parameters. Non-expert users cannot easily extract meaning from satellite imagery with a plain-language question.

Many real questions cannot be answered from one optical image:

- **Optical / multispectral** gives spectral and contextual information but is defeated by cloud and night.
- **SAR** gives complementary structural information and day-and-night, cloud-penetrating acquisition.
- **Multitemporal pairs** are required to identify and interpret change.
- **Co-registered optical–SAR pairs** provide more complete, more reliable information than either modality alone.

A generic LLM/VLM cannot perform these specialised tasks reliably without adaptation to remote-sensing imagery, sensor characteristics, and domain terminology.

### 1.1 Product thesis

The novelty of SatQuery AI is an **agentic, query-driven framework**. Instead of applying one generic VLM, the system:

1. interprets the query and classifies the requested task;
2. validates the number, modality, format, metadata, and compatibility of the input images;
3. selects one or more specialist models/tools from a predefined registry;
4. configures only permitted task parameters and executes the workflow;
5. combines textual and spatial outputs, estimates confidence, and returns visual evidence;
6. produces an auditable execution summary (selected task, model/tool names, key parameters).

Internal planning may occur but is **not** evaluated — only the observable execution trace is.

---

## 2. Goals & non-goals

### 2.1 Goals

- **G1** — Let a non-expert get an evidence-grounded answer about satellite imagery from a natural-language query through a GUI/web app.
- **G2** — Support single image, co-registered optical–SAR pair, and bi-temporal pair inputs in GeoTIFF/TIFF (PNG/JPEG only for prescribed benchmarks).
- **G3** — Provide an agentic controller that routes each query to the correct specialist workflow and records an auditable trace.
- **G4** — Include at least one visual / vision-language component **adapted** to remote sensing (e.g. via BigEarthNet.txt or other open training data).
- **G5** — Deliver single-image VQA (mandatory) plus one more single-image task (captioning **or** grounding).
- **G6** — Deliver bi-temporal change understanding (change description **or** change-VQA; optional change map where masks exist).
- **G7** — Deliver cross-modal optical–SAR joint information extraction.
- **G8** — Return visual evidence, confidence, execution summaries, and downloadable reports.
- **G9** — Perform on prescribed public benchmark test splits and the ISRO/SAC evaluation set.

### 2.2 Non-goals

- A hosted, multi-tenant SaaS deployment (current deliverable is a local workspace).
- General-purpose chat unrelated to the loaded imagery.
- Thermal / LiDAR fusion beyond the mandatory optical–SAR and bi-temporal pair requirements (allowed as an extension only).
- Acting as a GIS editor or a data-labelling platform.
- Investment, legal, or safety-critical operational decision-making.

---

## 3. Users & personas

| Persona | Need | How SatQuery AI serves it |
|---|---|---|
| **Domain analyst (non-RS-expert)** — agriculture/urban/disaster officer | "What changed here between these dates?" without GIS skills | Natural-language query, guided upload, plain-language grounded answer + map overlay |
| **Remote-sensing researcher** | Reproducible multi-sensor reasoning with provenance | Execution trace, per-band statistics, JSON report, model registry |
| **Evaluator (ISRO/SAC)** | Score outputs against reference answers/labels/boxes/masks | Deterministic task routing, structured outputs, benchmark-format inputs, auditable trace |
| **Integrator / model author** | Plug a domain-adapted model into the workflow | Documented `MODEL_API_URL` contract with fixed request/response schema |

---

## 4. Scope

### 4.1 Defined input scope

| Input class | Definition | Formats | Primary use |
|---|---|---|---|
| **Single image** | One optical/multispectral **or** SAR image | GeoTIFF/TIFF; PNG/JPEG for prescribed benchmarks only | Captioning, VQA, text-guided region grounding |
| **Cross-modal pair** | Co-registered optical/multispectral **and** SAR image of the same area | GeoTIFF/TIFF | Joint information extraction, cross-modal analysis |
| **Bi-temporal pair** | Two spatially corresponding images of the same area at different times | GeoTIFF/TIFF | Change detection, change description, change-VQA, optional change map |

### 4.2 Mandatory functional scope

| # | Requirement |
|---|---|
| MFS-1 | **Remote-sensing adaptation** — at least one visual / vision-language component fine-tuned or otherwise adapted using BigEarthNet.txt or other open training data. |
| MFS-2 | **Single-image baseline** — VQA is mandatory; additionally implement captioning/scene-description **or** text-guided region grounding. |
| MFS-3 | **Multi-image change analysis** — change description **or** change-VQA from a bi-temporal pair is mandatory; a spatial change map may be produced where reference masks exist. |
| MFS-4 | **Cross-modal pair analysis** — extract complementary information from a co-registered optical/multispectral + SAR pair. |
| MFS-5 | **Agentic orchestration** — automatically select, sequence, and execute the appropriate specialist models/tools per query and input configuration. |

A generic LLM/VLM without remote-sensing adaptation does **not** satisfy MFS-1.

### 4.3 Representative queries

- "Describe the land-cover and major objects visible in this image."
- "Highlight the water body referred to in the query."
- "What changed between these two dates, and where did the change occur?"
- "Use the optical and SAR images together to identify built-up and water-covered regions."
- "Has the built-up area increased, decreased, or remained unchanged?"

---

## 5. Functional requirements

IDs are stable references. **State** reflects the current repository: **Done** / **Partial** / **Planned**.

### 5.1 Input, upload & compatibility checking

| ID | Requirement | State | Notes |
|---|---|---|---|
| FR-IN-1 | Upload one or more images via drag-drop / file picker | Done | `WorkspaceDialogs`, 128 MB/file browser cap |
| FR-IN-2 | Decode GeoTIFF/TIFF in-browser: dimensions, band count, GeoKeys→CRS, bounding box, no-data, per-band min/max/mean/valid-pixel stats | Done | `observationReader.ts` via `geotiff` |
| FR-IN-3 | Decode JP2/J2K/JPX locally, preserving CRS + geotransform; keep original as inference input | Done | `server/jp2.ts` + Rasterio; ≤16 bands, ≤128 MB |
| FR-IN-4 | Accept PNG/JPEG visual images; flag missing georeferencing / calibration; benchmark label is a user declaration only | Done | — |
| FR-IN-5 | Reject point clouds (LAS/LAZ/PLY/PCD/E57) and raw containers (HDF/NetCDF/ENVI/SAFE-ZIP) with conversion guidance | Done | — |
| FR-IN-6 | Classify sensor type (optical, multispectral, SAR, thermal, hyperspectral, LiDAR raster); tag SAR SLC vs GRD with caveats | Done | — |
| FR-IN-7 | Require acquisition dates for temporal pairing; optional for single-image inspection | Done | `analyzeWorkspace`, `planFusion` |
| FR-IN-8 | Compatibility pre-check for pairs: common CRS, overlapping footprint, temporal window; never synthesize a missing image | Done | Pre-check only — not pixel co-registration |
| FR-IN-9 | Corrupt / undecodable inputs fail explicitly with no synthetic fallback raster | Done | — |
| FR-IN-10 | Validate that a **cross-modal / bi-temporal pair** is genuinely co-registered, not merely overlapping | Partial | `assessCoRegistration` (`fusionPlan.ts`) grades CRS match, footprint IoU, pixel-grid agreement and resolution ratio → `co-registered` / `overlap-only` / `incompatible`; run by the `co-registration-assessor` tool. Sub-pixel alignment still delegated to the analysis model. |

### 5.2 Agentic controller & orchestration

| ID | Requirement | State | Notes |
|---|---|---|---|
| FR-AG-1 | Interpret the query and classify the requested task | Done | `routeTask()` routes; `classifyTask()` adds observable `signals`, a `confidence` and a `rationale` string, recorded by the "Query Interpreter" trace step. A learned classifier is still a future upgrade. |
| FR-AG-2 | Check number, modality, format, metadata, and compatibility of inputs before execution | Done | Client guards in `analyzeWorkspace` + server `input-compatibility-checker` tool re-verifies count / modality / dating / georeferencing / bands per task. |
| FR-AG-3 | Select one or more models/tools from a **predefined registry** | Done | `server/registry.ts` (`TOOL_REGISTRY`, 8 tools); `selectToolChain()` builds an ordered chain `checker → (pair assessor) → primary specialist`. |
| FR-AG-4 | Configure only permitted task parameters | Done | `whitelistParameters(toolId, requested)` forwards only keys in each tool's `permittedParameters` (over registry defaults); rejected keys logged in the trace. |
| FR-AG-5 | Execute the selected workflow (single or multi-step) | Done | `orchestrate()` runs the chain in order; VLM-adapter failure falls back to the task's measurement specialist; spectral engine runs alongside the VLM for spectral queries. |
| FR-AG-6 | Combine textual + spatial outputs, estimate confidence, return visual evidence | Done | Outputs fused; confidence = model-calibrated value, or documented capped heuristic `0.2 + 0.35·validFraction + 0.1·coRegFactor` (≤ 0.6), or `null`. Evidence boxes rendered when a VLM/grounder returns them. |
| FR-AG-7 | Produce an auditable execution summary: selected task, model/tool names, key parameters | Done | `executionSummary` object (task, classification, per-tool id/version/parameters) + matching "Execution Summary" trace entry; both in the JSON report. |
| FR-AG-8 | Keep internal reasoning text out of the evaluated output | Done | Only observable trace is emitted |
| FR-AG-9 | Maintain short-term session memory as context for follow-up queries | Done | last 8 turns via `sessionStorage` |

### 5.3 Specialist tools (target registry)

| ID | Requirement | State | Notes |
|---|---|---|---|
| FR-SP-1 | Remote-sensing-adapted VQA / captioning model (single image) | Partial | `bigearthnet-scene-descriptor` gives measurement-grounded characterisation now; `rs-vlm-adapter` slot awaits domain-adapted weights (OpenRouter/Gemini are generic). |
| FR-SP-2 | Text-guided grounding model → normalized bounding boxes | Partial | `text-region-grounder` registered; measurement path returns description only and flags that boxes need a VLM/trained grounder; overlay renders boxes when a VLM returns them. |
| FR-SP-3 | Change-understanding / change-VQA model (bi-temporal) | Partial | `bitemporal-change-analyzer` computes real scene-mean index/band deltas + direction; a learned per-pixel change model is the upgrade. |
| FR-SP-4 | Optical–SAR fusion / joint information-extraction model | Partial | `optical-sar-fusion-analyzer` reads optical indices + SAR backscatter side by side with the co-registration grade; learned feature fusion is the upgrade. |
| FR-SP-5 | Spectral-index computation (NDVI/NDWI/etc.) from bands | Done (scene-mean) | `spectral-index-engine`: NDVI/NDWI/NDBI + SAR VV−VH from sampled band means, each with formula and inputs. Per-pixel index rasters are out of scope for the statistics-based path. |
| FR-SP-6 | Optional spatial change-map generation where reference masks exist | Planned | — |
| FR-SP-7 | At least one component adapted with BigEarthNet.txt / open RS data (**MFS-1**) | Planned | Not present — registry slot (`rs-vlm-adapter`) and payload (band stats + previews) are ready for it. |

### 5.4 Data acquisition (Copernicus)

| ID | Requirement | State | Notes |
|---|---|---|---|
| FR-DA-1 | Server-side OAuth (client credentials); credentials never reach the browser or logs | Done | `sentinel.ts`; secrets redacted from errors |
| FR-DA-2 | Catalog API date discovery with full pagination before any "latest/nearest" claim | Done | `catalog.ts`; fails explicitly on incomplete pagination |
| FR-DA-3 | Latest mode (last 30 days → full history from 2014) and inclusive Range mode with nearest-before/after fallback | Done | `selectDates()` |
| FR-DA-4 | Process API AOI retrieval: Sentinel-2 L2A (B02,B03,B04,B08,B11,B12,SCL,dataMask) and Sentinel-1 GRD (VV,VH,dataMask, DV) | Done | 768×768, disclosed as non-native resolution |
| FR-DA-5 | Location → AOI bounding box (< 2°) | Done | `server/geocode.ts`: place name → Nominatim (span-clamped ≤ 1.8°); a single `lat,lon` → 3 km-radius box (`?radiusKm=` override) with reverse-geocoded label. No coordinates hard-coded; the client's default AOI fields ship empty. |
| FR-DA-6 | Disclose truncation (12 dates/sensor, 100 scenes/date) and empty-pixel AOIs | Done | — |

### 5.5 Outputs, evidence & reporting

| ID | Requirement | State | Notes |
|---|---|---|---|
| FR-OUT-1 | Natural-language answer grounded in the imagery | Done | Measurement specialists compute from band statistics; VLM path answers from previews + statistics; inspection mode returns measured metadata only. |
| FR-OUT-2 | Key findings list | Done | — |
| FR-OUT-3 | Confidence: `[0,1]` when calibrated, `null` when not — never invented | Done | VLM value passed through unchanged; measurement path uses a documented capped heuristic or `null`; the earlier `0.94` default in `workspaceAnalysis` was removed. |
| FR-OUT-4 | Visual evidence: normalized `[xmin,ymin,xmax,ymax]` boxes overlaid on the referenced image | Done | SVG overlay in viewer; VLM system prompt fixed to request `[xmin,ymin,xmax,ymax]` (was `[ymin,xmin,ymax,xmax]`, wrong axis order). |
| FR-OUT-5 | Execution trace: ordered tool / status / detail entries | Done | Query Interpreter → Tool Registry Selector → per-tool → Confidence Estimator → Execution Summary. |
| FR-OUT-6 | Warnings surfaced (calibration, alignment, georeferencing gaps) | Done | Deduplicated across tools; includes co-registration notes and scene-mean caveats. |
| FR-OUT-7 | Downloadable JSON report | Done | `satquery-analysis.json` now also carries `spatialMetrics` + `executionSummary`. |
| FR-OUT-8 | Additional export formats (PDF, GeoJSON) | Planned | The unused legacy `reportGenerator.ts` was removed; a wired exporter is future work. |
| FR-OUT-9 | Spatial change map / mask output when available | Planned | — |

### 5.6 GUI / web application

| ID | Requirement | State |
|---|---|---|
| FR-UI-1 | Imagery collection with per-item sensor + date editing | Done |
| FR-UI-2 | Raster viewer: zoom, fullscreen, CRS + pixel readout, north indicator | Done |
| FR-UI-3 | Two-image comparison slider, explicitly labelled "alignment not verified" | Done |
| FR-UI-4 | Fusion workbench: target date, temporal window, eligibility/precheck status | Done |
| FR-UI-5 | Query composer with task suggestions and image-count context | Done |
| FR-UI-6 | Results panel: answer / evidence / trace tabs | Done |
| FR-UI-7 | Settings hub: model-provider config, Copernicus setup, benchmark reference | Done |
| FR-UI-8 | Error banner with actionable, non-sensitive messages | Done |

---

## 6. Model service contract (integration interface)

`POST /api/analyze` — if `MODEL_API_URL` is set it owns the request (body forwarded unchanged); otherwise the agentic controller (`orchestrator.ts` + `registry.ts`) runs.

**Request**

```jsonc
{
  "query": "string",
  "task": "vqa_single | captioning | grounding | change_vqa | multisensor_fusion | spectral_analysis",
  "targetDate": "YYYY-MM-DD",
  "toleranceDays": 3,
  "parameters": { "temperature": 0.2, "indices": ["NDVI","NDWI"] },   // whitelisted per tool
  "sessionMemory": [ { "query": "…", "answer": "…", "observationNames": ["…"] } ],
  "observations": [
    { "id": "string", "name": "string", "sensor": "string", "date": "YYYY-MM-DD",
      "bands": 0, "width": 0, "height": 0, "crs": "EPSG:…", "bounds": [w,s,e,n],
      "collection": "sentinel-2-l2a", "cloudCover": 4, "resolution": 10, "sarProduct": "grd",
      "stats": [ { "band": 1, "min": 0, "max": 1, "mean": 0.09, "validPixels": 1000 } ],
      "previewBase64": "data:image/png;base64,…" }
  ]
}
```

**Response** additionally carries `spatialMetrics` (computed indices / deltas / footprint IoU) and `executionSummary` (`task`, `classification`, and each tool's `id` / `version` / applied `parameters`).

**Response** (invalid shapes rejected client-side)

```json
{
  "answer": "string",
  "findings": ["string"],
  "confidence": null,
  "warnings": ["string"],
  "trace": [ { "tool": "string", "status": "completed", "detail": "string" } ],
  "evidence": [ { "observationId": "string", "label": "string", "box": [0.1,0.2,0.3,0.4] } ]
}
```

**Adapter responsibilities:** validate the raster; honour no-data / cloud masks; calibrate physical units; verify overlap; reproject / resample; perform **co-registration**; return only observable tool execution in `trace`. Metadata and bounding-box checks alone do not establish aligned pixels.

---

## 7. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | **Security** | Server binds loopback; non-`localhost` origins rejected; request body ≤ 160 MB; secrets never sent to the client, never logged, redacted from provider errors. `.env` is git-ignored; for open-source distribution `scripts/secrets.mjs` encrypts it to a committable `.env.enc` (AES-256-GCM, scrypt KDF) that the server decrypts at runtime from `SATQUERY_MASTER_KEY` (never stored). |
| NFR-2 | **Privacy** | Original uploads leave the machine only when the user submits a query with a model provider configured; JP2 bytes go only to the local decoder; temp files deleted after each conversion. |
| NFR-3 | **Provenance / honesty** | No invented location, cloud cover, resolution, labels, or confidence. Derived/resampled rasters and unverified alignment are disclosed. Benchmark labels are user declarations. |
| NFR-4 | **Determinism** | Task routing and input validation are deterministic and inspectable; low inference temperature (≤ 0.2) for provider calls. |
| NFR-5 | **Reproducibility** | Every analysis emits a full trace and a downloadable report; pnpm lockfile pins JS deps; `rasterio==1.5.1` pins the decoder. |
| NFR-6 | **Performance** | Client previews resampled to ≤ 768 px longest side; Sentinel requests time-boxed (search ≤ 180 s, raster ≤ 90 s, token ≤ 30 s). |
| NFR-7 | **Portability** | Node 24+; Windows/macOS/Linux; Python/Rasterio optional (JP2 only). |
| NFR-8 | **Resilience** | OAuth token cached with refresh-on-401; OpenRouter 429 → automatic model fallback; catalogue pagination failures fail loud. |
| NFR-9 | **Accessibility** | Keyboard-operable controls, ARIA labels, live regions for status/results. |
| NFR-10 | **Evaluability** | Structured outputs (answer / boxes / optional mask) match benchmark scoring needs; metrics normalised before combining. |

---

## 8. System architecture (as built)

- **Frontend** — React 19 + TypeScript SPA (Vite, Tailwind 4). Ingestion in `observationReader.ts`; client-side classification + pre-checks in `fusionPlan.ts` (`routeTask`, `classifyTask`, `planFusion`, `assessCoRegistration`); request assembly in `workspaceAnalysis.ts`; UI in `App.tsx`, `WorkspaceDialogs`, `WorkspaceResults` (unchanged in this pass).
- **Local API** — `server/index.ts`, a dependency-free Node HTTP server executing TypeScript directly. Serves `dist/` and the `/api/*` endpoints.
- **Agentic controller** — `server/orchestrator.ts` (7-step controller) + `server/registry.ts` (predefined tool registry + parameter whitelist) + `server/specialists.ts` (measurement-grounded specialists) + `server/aiService.ts` (multimodal VLM adapter, OpenRouter / Gemini).
- **External services** — Copernicus Data Space (OAuth + Catalog + Process), Nominatim (geocoding), and one of OpenRouter / Google Gemini / a separate `MODEL_API_URL` orchestrator for inference.
- **Removed** — the earlier `Atlas*` / `specialists/*` / `atlasOrchestrator` / `reportGenerator` / `rasterEngine` / `data/datasets` / `types/index` prototype (canned outputs, never imported) was deleted in this pass; `jspdf` / `html2canvas` in `package.json` are now unused.

See [`README.md`](README.md) for the full architecture diagram, tool-registry table, API table, and run instructions.

---

## 9. Gap analysis — current state vs PS 26167

| PS 26167 mandatory element | Current repository | Gap to close |
|---|---|---|
| Remote-sensing-adapted visual/VL component (BigEarthNet.txt or open data) | `rs-vlm-adapter` registry slot + payload (band stats + previews) ready; no adapted weights; generic VLM or measurement fallback | Train/fine-tune and serve an adapted encoder/VLM behind `MODEL_API_URL`; record the adaptation dataset in the trace |
| Single-image VQA (mandatory) | Routed; measurement descriptor or VLM answers; execution summary emitted | Back with the adapted VQA specialist |
| One more single-image task (captioning **or** grounding) | Captioning done via measurement descriptor; grounding registered but returns no boxes without a VLM | Add a trained grounding model for calibrated boxes on the no-provider path |
| Bi-temporal change understanding (mandatory) | Real scene-mean index/band deltas + direction + co-registration grade | Learned per-pixel change model; change-map artefact where masks exist |
| Cross-modal optical–SAR analysis | Real side-by-side optical-index + SAR-backscatter reading + co-registration grade (`assessCoRegistration`) | Learned feature fusion; sub-pixel co-registration step |
| Agentic model/tool orchestration | **Done** — predefined registry, ordered tool chain, permitted-parameter whitelist, VLM→measurement fallback, output fusion, execution summary | Multi-step chaining across >1 specialist per query; learned intent classifier |
| Visual evidence + confidence + summaries + downloadable reports | Boxes (VLM), documented capped/`null` confidence, 7-step trace, JSON with `executionSummary` + `spatialMetrics` | Re-wire PDF/GeoJSON export; change-map artefact |
| Benchmark performance (VRSBench, RSVQA, CDVQA) + ISRO/SAC set | No evaluation harness | Build split-wise evaluation with normalised metric combination |
| Interactive GUI / web app with agentic RS backend | GUI done; agentic backend done; adapted RS models absent | Attach the domain-adapted model as `rs-vlm-adapter`'s backend |

**Verified working today (all green: `npm run lint`, `npm run build`, 40/40 JS tests + 1 skipped):** local upload & inspection (GeoTIFF/JP2/PNG/JPEG), measured statistics, Copernicus OAuth + Catalog discovery + Process AOI retrieval (live-checked 2026-09-10), location resolution for arbitrary place names and `lat,lon` → 3 km AOI (live-checked against Nominatim), task classification with signals/confidence, temporal/CRS/overlap pre-checks + `assessCoRegistration`, the agentic controller (registry tool-chain selection, parameter whitelisting, VLM-adapter with measurement fallback on provider failure — confirmed end-to-end against a live OpenRouter 429), measurement specialists computing real NDVI/NDWI/NDBI and bi-temporal deltas from band statistics, execution summary + JSON report, and `.env` encryption round-trip with the server loading credentials from `.env.enc`.

---

## 10. Evaluation / Judging criteria

Final evaluation uses the prescribed public-benchmark **test** splits and an ISRO/SAC evaluation dataset. Scores are **normalised before combining** across metrics. Evaluation annotations are **not disclosed** to teams. The ISRO/SAC set contains pre-georeferenced, co-registered **Cartosat-2S optical** and **RISAT SAR** image pairs with task-specific reference answers, labels, bounding boxes, or masks as applicable.

| Task family | Dataset(s) | Input class | Reference type | Representative metrics |
|---|---|---|---|---|
| Single-image captioning / scene description | VRSBench | Single optical/MS | Reference captions | BLEU-4, METEOR, CIDEr, ROUGE-L |
| Single-image VQA (**mandatory**) | RSVQA, VRSBench | Single optical/MS or SAR | Reference answers | Answer accuracy (overall + per type), F1 |
| Text-guided region grounding | VRSBench | Single image | Reference bounding boxes | Acc@0.5 IoU, mIoU |
| Multitemporal change-VQA / change description (**mandatory**) | CDVQA | Bi-temporal pair | Reference answers / descriptions | Change-answer accuracy, F1; caption metrics for descriptions |
| Spatial change map (where masks exist) | CDVQA / ISRO-SAC | Bi-temporal pair | Reference masks | IoU, F1, Overall Accuracy |
| Cross-modal optical–SAR information extraction | ISRO/SAC (Cartosat-2S + RISAT) | Cross-modal pair | Answers / labels / boxes / masks | Task-appropriate accuracy / IoU / F1 |
| Agentic orchestration | All of the above | Any | Expected task + tool/param trace | Correct task selection rate, tool-selection validity, permitted-parameter compliance, trace completeness |
| Domain adaptation evidence (**MFS-1**) | BigEarthNet.txt (adaptation) | — | — | Presence & documentation of an adapted component in the execution trace |

Only the **observable execution trace** — selected task, model/tool names, permitted parameters, and outputs — is evaluated for orchestration. Internal reasoning text is neither required nor scored.

---

## 11. Deliverables

| # | Deliverable | Current status |
|---|---|---|
| D1 | Interactive GUI / web application with an agentic remote-sensing AI backend | GUI + agentic controller (registry, tool-chain, parameter whitelist, fusion, execution summary) + provider integration delivered; domain-adapted model to be attached at `rs-vlm-adapter` |
| D2 | Codes and models, including test and demonstration | Application code + 5 `node:test` suites (28 JS assertions) delivered; trained/adapted models pending |
| D3 | Demonstration of: single-image VQA, one more single-image task, multitemporal change understanding, optical–SAR paired analysis, agentic model/tool orchestration | Orchestration + measurement-grounded VQA / captioning / spectral / bi-temporal / optical–SAR paths demonstrable end-to-end now (measured indices + deltas + execution summary); domain-adapted accuracy pending model integration |

---

## 12. Milestones (indicative)

| Phase | Outcome |
|---|---|
| **M0 — Interface & integration (complete)** | Upload/inspection, Copernicus discovery + retrieval, task classification, pre-checks, trace + report, model-provider plumbing |
| **M1 — Agentic controller (complete)** | Predefined tool registry, ordered tool-chain selection, permitted-parameter whitelisting, VLM adapter with measurement fallback, output fusion, capped confidence heuristic, `executionSummary`, co-registration grading, measurement-grounded NDVI/NDWI/NDBI + bi-temporal deltas. Dead prototype removed. |
| **M2 — Domain-adapted single-image core** | BigEarthNet.txt (or open-data) adaptation of a visual/VL component behind `rs-vlm-adapter`; adapted single-image VQA + captioning/grounding; RSVQA/VRSBench baseline scores |
| **M3 — Bi-temporal change & cross-modal models** | Learned per-pixel change model + optical–SAR feature fusion; sub-pixel co-registration step; optional change map where masks exist; CDVQA + ISRO/SAC pair demos |
| **M4 — Multi-step chaining & exports** | Chain >1 specialist per query; learned intent classifier; re-wired PDF/GeoJSON exporters |
| **M5 — Evaluation & hardening** | Split-wise benchmark harness with normalised metric combination; performance, accessibility, and packaging pass |

---

## 13. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
|---|---|---|
| No trained RS models in repo | Cannot satisfy MFS-1 alone | Agentic plumbing is done (M1); M2–M3 model work; contract-first `MODEL_API_URL` / `rs-vlm-adapter` slot so the backend develops independently |
| Rule-based task routing misclassifies edge-case queries | Wrong specialist selected | `classifyTask` surfaces signals + a confidence in the trace so low-confidence routings are visible; learned classifier in M4; task override in the UI is future work |
| "Co-registered" pair may not be pixel-aligned | Invalid cross-modal results | `assessCoRegistration` grades CRS/grid/footprint and labels `overlap-only` / `incompatible`; the analysis model must still co-register; disclosed in warnings when unverified |
| Provider rate limits / outages (Copernicus, OpenRouter, Gemini) | Analysis unavailable | Token cache + 401 refresh, 429 model fallback, explicit user-facing errors |
| Browser memory limits for large rasters | Upload failure | 128 MB cap, ≤768 px previews, AOI cropping guidance |
| Benchmark annotations undisclosed | Overfitting risk | Evaluate only on public train/val locally; keep routing + adaptation general |
| Local-only deployment | Not web-hosted | Documented hosting path (server runtime port, secrets, authn, limits, rate limiting) |

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **AOI** | Area of interest (bounding box, < 2° per side for catalogue queries) |
| **CDSE** | Copernicus Data Space Ecosystem |
| **CRS** | Coordinate reference system (e.g. `EPSG:4326`) |
| **GRD / SLC** | SAR Ground Range Detected / Single Look Complex products |
| **Grounding** | Localising a text-referenced region as a bounding box |
| **L2A** | Sentinel-2 Level-2A surface-reflectance product |
| **NDVI / NDWI** | Normalised Difference Vegetation / Water Index |
| **Observation** | One loaded image plus its decoded metadata and statistics |
| **Trace** | Ordered, auditable log of tools/parameters executed for a query |
| **VQA** | Visual question answering |
