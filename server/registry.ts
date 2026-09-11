// Specialist model / tool registry for the agentic controller.
//
// Problem Statement 26167 requires the system to "select one or more models or
// tools from a predefined registry" and "configure only permitted task
// parameters". This module is that predefined registry: a declarative list of
// specialist tools, the tasks each one serves, its input constraints, and the
// exact set of parameters the controller is allowed to pass to it.

export type TaskName =
  | 'vqa_single'
  | 'captioning'
  | 'grounding'
  | 'change_vqa'
  | 'multisensor_fusion'
  | 'spectral_analysis'
  | 'input_validation';

export interface ToolSpec {
  id: string;
  version: string;
  displayName: string;
  kind: 'validator' | 'measurement' | 'vlm' | 'assessor';
  tasks: TaskName[];
  minImages: number;
  maxImages: number;
  /** Sensor families that must all be present among the inputs (e.g. optical + sar). */
  requiredModalities?: string[][];
  /** The ONLY parameter keys the controller may forward to this tool. */
  permittedParameters: string[];
  summary: string;
}

export const TOOL_REGISTRY: ToolSpec[] = [
  {
    id: 'input-compatibility-checker',
    version: '1.1.0',
    displayName: 'Input & Modality Compatibility Checker',
    kind: 'validator',
    tasks: ['vqa_single', 'captioning', 'grounding', 'change_vqa', 'multisensor_fusion', 'spectral_analysis', 'input_validation'],
    minImages: 0,
    maxImages: 16,
    permittedParameters: [],
    summary: 'Verifies image count, modality, georeferencing, band metadata and CRS/footprint compatibility for the routed task.',
  },
  {
    id: 'co-registration-assessor',
    version: '1.0.0',
    displayName: 'Pair Co-Registration Assessor',
    kind: 'assessor',
    tasks: ['change_vqa', 'multisensor_fusion'],
    minImages: 2,
    maxImages: 2,
    permittedParameters: [],
    summary: 'Reports CRS match, footprint IoU and pixel-grid agreement for an image pair (alignment evidence, not a co-registration step).',
  },
  {
    id: 'rs-vlm-adapter',
    version: '0.3.0',
    displayName: 'Remote-Sensing VLM Adapter',
    kind: 'vlm',
    tasks: ['vqa_single', 'captioning', 'grounding', 'change_vqa', 'multisensor_fusion', 'spectral_analysis'],
    minImages: 1,
    maxImages: 8,
    permittedParameters: ['temperature', 'topP', 'maxTokens', 'responseFormat'],
    summary: 'Routes the query and image previews to the configured multimodal model (custom RS endpoint, OpenRouter, or Gemini) and normalises its structured answer.',
  },
  {
    id: 'bigearthnet-scene-descriptor',
    version: '1.0.0',
    displayName: 'BigEarthNet-Style Scene Descriptor',
    kind: 'measurement',
    tasks: ['captioning', 'vqa_single'],
    minImages: 1,
    maxImages: 1,
    permittedParameters: ['topKClasses'],
    summary: 'Characterises land cover from measured scene-mean spectral indices and valid-data fraction.',
  },
  {
    id: 'spectral-index-engine',
    version: '1.0.0',
    displayName: 'Spectral Index Engine',
    kind: 'measurement',
    tasks: ['spectral_analysis', 'vqa_single'],
    minImages: 1,
    maxImages: 1,
    permittedParameters: ['indices'],
    summary: 'Computes NDVI / NDWI / NDBI (and SAR VV/VH ratio) from sampled band statistics with explicit formulas and inputs.',
  },
  {
    id: 'bitemporal-change-analyzer',
    version: '1.0.0',
    displayName: 'Bi-Temporal Change Analyzer',
    kind: 'measurement',
    tasks: ['change_vqa'],
    minImages: 2,
    maxImages: 2,
    permittedParameters: ['changeThreshold'],
    summary: 'Quantifies scene-mean band and index deltas between two acquisitions and reports increase / decrease / unchanged per proxy.',
  },
  {
    id: 'optical-sar-fusion-analyzer',
    version: '1.0.0',
    displayName: 'Optical-SAR Fusion Analyzer',
    kind: 'measurement',
    tasks: ['multisensor_fusion'],
    minImages: 2,
    maxImages: 4,
    requiredModalities: [['optical', 'multispectral'], ['sar']],
    permittedParameters: ['speckleFilter', 'fusionMode'],
    summary: 'Reads optical spectral indices and SAR backscatter side by side to extract complementary land-cover / water / structure evidence.',
  },
  {
    id: 'text-region-grounder',
    version: '0.1.0',
    displayName: 'Text-Guided Region Grounder',
    kind: 'measurement',
    tasks: ['grounding'],
    minImages: 1,
    maxImages: 1,
    permittedParameters: ['iouThreshold'],
    summary: 'Placeholder grounder: returns the referenced feature description and flags that bounding-box localisation needs a trained grounding model or a configured VLM.',
  },
];

export const DEFAULT_PARAMETERS: Record<string, Record<string, unknown>> = {
  'rs-vlm-adapter': { temperature: 0.2, topP: 0.95, responseFormat: 'json_object' },
  'bigearthnet-scene-descriptor': { topKClasses: 5 },
  'spectral-index-engine': { indices: ['NDVI', 'NDWI', 'NDBI'] },
  'bitemporal-change-analyzer': { changeThreshold: 0.02 },
  'optical-sar-fusion-analyzer': { speckleFilter: 'none', fusionMode: 'evidence-side-by-side' },
  'text-region-grounder': { iouThreshold: 0.5 },
};

export function getTool(id: string): ToolSpec | undefined {
  return TOOL_REGISTRY.find(t => t.id === id);
}

/**
 * Keep only the parameter keys the tool permits. Returns the accepted
 * parameters and the list of rejected keys so the controller can log them.
 */
export function whitelistParameters(
  toolId: string,
  requested: Record<string, unknown>
): { accepted: Record<string, unknown>; rejected: string[] } {
  const tool = getTool(toolId);
  const permitted = new Set(tool?.permittedParameters ?? []);
  const accepted: Record<string, unknown> = { ...(DEFAULT_PARAMETERS[toolId] ?? {}) };
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(requested ?? {})) {
    if (permitted.has(key)) accepted[key] = value;
    else rejected.push(key);
  }
  return { accepted, rejected };
}

/**
 * Select the ordered tool chain for a routed task and a set of inputs.
 * Always: compatibility check -> (pair assessor) -> primary specialist.
 * The primary specialist is the VLM adapter when a model provider is
 * configured, otherwise the measurement specialist registered for the task.
 */
export function selectToolChain(
  task: TaskName,
  imageCount: number,
  sensors: string[],
  providerConfigured: boolean
): { chain: ToolSpec[]; notes: string[] } {
  const notes: string[] = [];
  const chain: ToolSpec[] = [getTool('input-compatibility-checker')!];

  if (imageCount === 2 && (task === 'change_vqa' || task === 'multisensor_fusion')) {
    chain.push(getTool('co-registration-assessor')!);
  }

  const measurementByTask: Partial<Record<TaskName, string>> = {
    captioning: 'bigearthnet-scene-descriptor',
    vqa_single: 'bigearthnet-scene-descriptor',
    spectral_analysis: 'spectral-index-engine',
    change_vqa: 'bitemporal-change-analyzer',
    multisensor_fusion: 'optical-sar-fusion-analyzer',
    grounding: 'text-region-grounder',
  };

  if (providerConfigured) {
    chain.push(getTool('rs-vlm-adapter')!);
    notes.push('Model provider configured: primary reasoning tool is rs-vlm-adapter.');
    // The spectral engine still runs alongside the VLM for spectral queries so the
    // answer carries verifiable numbers.
    if (task === 'spectral_analysis' && imageCount === 1) chain.push(getTool('spectral-index-engine')!);
  } else {
    const measurementId = measurementByTask[task];
    if (measurementId) {
      chain.push(getTool(measurementId)!);
      notes.push(`No model provider configured: primary tool is measurement specialist ${measurementId}.`);
    } else {
      notes.push('No measurement specialist maps to this task; compatibility report only.');
    }
  }

  return { chain, notes };
}
