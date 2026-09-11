export const SENSOR_LABELS = { optical: 'Optical', multispectral: 'Multispectral', sar: 'SAR', thermal: 'Thermal', lidar: 'LiDAR raster', hyperspectral: 'Hyperspectral' } as const;
export type Sensor = keyof typeof SENSOR_LABELS;
export type SarProduct = 'slc' | 'grd';
export type Bounds = [number, number, number, number]; // west, south, east, north; in the stated CRS
export interface BandStats { band: number; min: number; max: number; mean: number; validPixels: number }
export interface Observation {
  id: string; name: string; sensor: Sensor; date: string; source: 'upload' | 'sentinel';
  preview: string; file?: File; width: number; height: number; bands: number;
  crs?: string; bounds?: Bounds; resolution?: number; resolutionLabel?: string; stats: BandStats[]; sarProduct?: SarProduct;
  benchmark?: string; cloudCover?: number; collection?: string; sceneId?: string;
  warnings: string[];
}
export interface CatalogScene { id: string; collection: string; date: string; bounds: Bounds; cloudCover?: number }
export interface SearchRequest { bounds: Bounds; collections: string[]; mode: 'latest' | 'range'; start?: string; end?: string }
export interface SearchResult { scenes: CatalogScene[]; fallback: boolean; message: string; truncated: boolean }
export interface LocationMatch { name: string; bounds: Bounds; latitude: number; longitude: number }
export interface ExecutionSummary {
  task: string;
  classification?: { task: string; confidence: number; signals: string[] };
  tools: { id: string; version: string; parameters: Record<string, unknown> }[];
}
export interface AnalysisResult {
  observationIds: string[];
  query: string; task: string; answer: string; findings: string[]; warnings: string[];
  confidence: number | null; mode: 'inspection' | 'model'; timestamp: string;
  trace: { tool: string; status: string; detail: string }[];
  evidence?: { observationId: string; label: string; box: [number, number, number, number]; confidence?: number }[];
  // Optional agentic-controller metadata. Included in the downloadable JSON
  // report; not rendered by the current UI.
  spatialMetrics?: Record<string, number | string>;
  executionSummary?: ExecutionSummary;
}
