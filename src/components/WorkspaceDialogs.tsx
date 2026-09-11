import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Key, Layers, LoaderCircle, Orbit, Save, Sparkles, Upload, X } from 'lucide-react';
import type { Observation, Sensor } from '../types/workspace';
import { SENSOR_LABELS } from '../types/workspace';
import { readObservation } from '../services/observationReader';

const POPULAR_OPENROUTER_MODELS = [
  { id: 'google/gemma-4-31b-it:free', label: 'Google Gemma 4 31B IT (Free · Active)' },
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'Google Gemma 4 26B A4B (Free · Fallback)' },
  { id: 'google/gemini-2.0-flash-exp:free', label: 'Gemini 2.0 Flash Experimental (Free)' },
  { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', label: 'Llama 3.2 11B Vision Instruct (Free)' },
  { id: 'qwen/qwen-2.5-vl-72b-instruct', label: 'Qwen 2.5 VL 72B Instruct (High Precision RS)' },
  { id: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o Mini' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Anthropic Claude 3.5 Sonnet' }
];

export function WorkspaceDialogs({
  uploadOpen,
  helpOpen,
  closeUpload,
  closeHelp,
  onLoaded,
  onModelConfigured
}: {
  uploadOpen: boolean;
  helpOpen: boolean;
  closeUpload: () => void;
  closeHelp: () => void;
  onLoaded: (items: Observation[]) => void;
  onModelConfigured?: () => void;
}) {
  const [sensor, setSensor] = useState<Sensor>('optical');
  const [date, setDate] = useState('');
  const [benchmark, setBenchmark] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // AI Configuration State
  const [aiTab, setAiTab] = useState<'ai' | 'sentinel' | 'benchmarks'>('ai');
  const [aiProvider, setAiProvider] = useState<'openrouter' | 'gemini' | 'custom' | 'local'>('openrouter');
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [openRouterModel, setOpenRouterModel] = useState('google/gemma-4-31b-it:free');

  const [geminiKey, setGeminiKey] = useState('');
  const [customModelUrl, setCustomModelUrl] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [modelSuccessMsg, setModelSuccessMsg] = useState('');

  const uploadRef = useRef<HTMLDialogElement>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (uploadOpen) uploadRef.current?.showModal();
    else uploadRef.current?.close();
  }, [uploadOpen]);

  useEffect(() => {
    if (helpOpen) {
      helpRef.current?.showModal();
      // Fetch existing model status
      fetch('/api/config/model')
        .then(r => r.json())
        .then(data => {
          if (data.aiProvider) setAiProvider(data.aiProvider);
          if (data.openRouterModel) setOpenRouterModel(data.openRouterModel);
          if (data.modelURL) setCustomModelUrl(data.modelURL);
        })
        .catch(() => {});
    } else {
      helpRef.current?.close();
    }
  }, [helpOpen]);

  async function addFiles(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setError('');
    const loaded: Observation[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        loaded.push(await readObservation(file, sensor, date, benchmark));
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : 'Could not decode image.'}`);
      }
    }
    if (loaded.length) onLoaded(loaded);
    setBusy(false);
    if (!failures.length) closeUpload();
    else setError(failures.join(' '));
    if (fileRef.current) fileRef.current.value = '';
  }

  async function saveAiConfiguration() {
    setSavingModel(true);
    setModelSuccessMsg('');
    setError('');
    try {
      const payload: any = { aiProvider };
      if (aiProvider === 'openrouter') {
        payload.openRouterKey = openRouterKey.trim();
        payload.openRouterModel = openRouterModel.trim();
      } else if (aiProvider === 'gemini') {
        payload.geminiKey = geminiKey.trim();
      } else if (aiProvider === 'custom') {
        payload.modelURL = customModelUrl.trim();
      }

      const res = await fetch('/api/config/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save configuration');
      setModelSuccessMsg('AI Model configuration updated successfully!');
      onModelConfigured?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save configuration');
    } finally {
      setSavingModel(false);
    }
  }

  return (
    <>
      <dialog
        ref={uploadRef}
        className="modal"
        onCancel={e => {
          if (busy) e.preventDefault();
          else closeUpload();
        }}
        onClose={closeUpload}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">YOUR DATA, YOUR PERSPECTIVE</span>
            <h2>Add imagery</h2>
          </div>
          <button className="icon-button" disabled={busy} aria-label="Close upload" onClick={closeUpload}>
            <X size={21} />
          </button>
        </div>
        <p className="modal-intro">Add one or more observations. Use the fusion workbench to adjust each image’s sensor and date.</p>
        <div className="upload-fields">
          <label>
            Sensor type
            <select value={sensor} disabled={busy} onChange={e => setSensor(e.target.value as Sensor)}>
              {Object.entries(SENSOR_LABELS).map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Acquisition date
            <input type="date" disabled={busy} value={date} onChange={e => setDate(e.target.value)} />
          </label>
        </div>
        <label className="benchmark-select">
          Benchmark (optional)
          <select value={benchmark} disabled={busy} onChange={e => setBenchmark(e.target.value)}>
            <option value="">Not a benchmark / Sentinel download</option>
            {['VRSBench', 'RSVQA', 'CDVQA', 'BigEarthNet.txt', 'ISRO-SAC'].map(b => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <button
          disabled={busy}
          className="modal-dropzone"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            if (!busy) void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {busy ? <LoaderCircle size={30} className="spin" /> : <Upload size={30} />}
          <strong>{busy ? 'Decoding your imagery…' : 'Drop files here, or browse'}</strong>
          <span>GeoTIFF / TIFF / JP2 / JPEG / PNG · Up to 128 MB per file</span>
        </button>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".tif,.tiff,.jp2,.j2k,.jpx,.png,.jpg,.jpeg"
          multiple
          onChange={e => void addFiles(Array.from(e.target.files || []))}
        />
        {error && <p className="modal-error" role="alert">{error}</p>}
        <p className="field-hint">
          JP2 files are decoded locally by the API. JPEG/PNG images load directly. Dates are optional for single-image inspection and required for temporal pairing.
        </p>
      </dialog>

      <dialog ref={helpRef} className="modal guide-modal" onCancel={closeHelp} onClose={closeHelp}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">SATQUERY AI · PS 26167</span>
            <h2>Settings & Knowledge Hub</h2>
          </div>
          <button className="icon-button" aria-label="Close guide" onClick={closeHelp}>
            <X size={21} />
          </button>
        </div>

        <div className="segmented" style={{ marginBottom: '1.2rem' }}>
          <button className={aiTab === 'ai' ? 'selected' : ''} onClick={() => setAiTab('ai')}>
            <Sparkles size={14} style={{ marginRight: '6px' }} /> AI Model Setup
          </button>
          <button className={aiTab === 'sentinel' ? 'selected' : ''} onClick={() => setAiTab('sentinel')}>
            <Orbit size={14} style={{ marginRight: '6px' }} /> Copernicus Sentinel
          </button>
          <button className={aiTab === 'benchmarks' ? 'selected' : ''} onClick={() => setAiTab('benchmarks')}>
            <Layers size={14} style={{ marginRight: '6px' }} /> Benchmarks & PS 26167
          </button>
        </div>

        {aiTab === 'ai' && (
          <div className="ai-config-section">
            <h3>Connect Multimodal Vision-Language Model</h3>
            <p className="field-hint">
              Connect a free multimodal VLM via OpenRouter, Google Gemini, or use the built-in Remote Sensing Specialist Engine.
            </p>

            <div style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
              <label>
                <strong>AI Provider</strong>
                <select
                  value={aiProvider}
                  onChange={e => setAiProvider(e.target.value as any)}
                  style={{ width: '100%', marginTop: '4px', padding: '8px', background: 'var(--bg-card, #1e2433)', color: '#fff', border: '1px solid #334155', borderRadius: '6px' }}
                >
                  <option value="openrouter">OpenRouter (Supports Free Multimodal Models)</option>
                  <option value="gemini">Google Gemini API (Direct Key)</option>
                  <option value="custom">Custom Remote-Sensing VLM Endpoint</option>
                  <option value="local">Built-in SatQuery RS Specialist Engine</option>
                </select>
              </label>

              {aiProvider === 'openrouter' && (
                <>
                  <label>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Key size={14} /> OpenRouter API Key</span>
                    <input
                      type="password"
                      placeholder="sk-or-v1-..."
                      value={openRouterKey}
                      onChange={e => setOpenRouterKey(e.target.value)}
                      style={{ width: '100%', marginTop: '4px', padding: '8px', background: 'var(--bg-card, #1e2433)', color: '#fff', border: '1px solid #334155', borderRadius: '6px' }}
                    />
                  </label>
                  <label>
                    <strong>Select Multimodal Model</strong>
                    <select
                      value={openRouterModel}
                      onChange={e => setOpenRouterModel(e.target.value)}
                      style={{ width: '100%', marginTop: '4px', padding: '8px', background: 'var(--bg-card, #1e2433)', color: '#fff', border: '1px solid #334155', borderRadius: '6px' }}
                    >
                      {POPULAR_OPENROUTER_MODELS.map(m => (
                        <option key={m.id} value={m.id}>{m.label} ({m.id})</option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              {aiProvider === 'gemini' && (
                <label>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Key size={14} /> Gemini API Key</span>
                  <input
                    type="password"
                    placeholder="AIzaSy..."
                    value={geminiKey}
                    onChange={e => setGeminiKey(e.target.value)}
                    style={{ width: '100%', marginTop: '4px', padding: '8px', background: 'var(--bg-card, #1e2433)', color: '#fff', border: '1px solid #334155', borderRadius: '6px' }}
                  />
                </label>
              )}

              {aiProvider === 'custom' && (
                <label>
                  <strong>Model Endpoint URL</strong>
                  <input
                    type="url"
                    placeholder="https://your-custom-model.api/v1/analyze"
                    value={customModelUrl}
                    onChange={e => setCustomModelUrl(e.target.value)}
                    style={{ width: '100%', marginTop: '4px', padding: '8px', background: 'var(--bg-card, #1e2433)', color: '#fff', border: '1px solid #334155', borderRadius: '6px' }}
                  />
                </label>
              )}

              {aiProvider === 'local' && (
                <div className="notice" style={{ padding: '10px', background: 'rgba(59, 130, 246, 0.1)', borderLeft: '3px solid #3b82f6', borderRadius: '4px' }}>
                  <strong>Built-in Agentic Specialist Engine Active:</strong> Runs BigEarthNet 19-class Corine Land Cover alignment, CDVQA change detection, and optical-SAR polarimetric fusion locally without external API dependencies.
                </div>
              )}

              {modelSuccessMsg && (
                <p style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '6px', margin: 0 }}>
                  <Check size={16} /> {modelSuccessMsg}
                </p>
              )}
              {error && <p className="modal-error">{error}</p>}

              <button
                className="button primary"
                disabled={savingModel}
                onClick={saveAiConfiguration}
                style={{ justifySelf: 'start', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                {savingModel ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
                Save & Apply Model Configuration
              </button>
            </div>
          </div>
        )}

        {aiTab === 'sentinel' && (
          <div>
            <h3>Connect Copernicus Sentinel Hub</h3>
            <p>
              Set <code>SENTINEL_CLIENT_ID</code> and <code>SENTINEL_CLIENT_SECRET</code> in the server’s <code>.env</code>.
            </p>
            <p>
              Provides real-time search & raster acquisition for <strong>Sentinel-2 (Multispectral Level-2A)</strong> and <strong>Sentinel-1 (SAR GRD C-Band)</strong> anywhere on Earth.
            </p>
            <a className="text-link" href="https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html" target="_blank" rel="noreferrer">
              Copernicus Data Space Guide <ArrowUpRight size={14} />
            </a>
          </div>
        )}

        {aiTab === 'benchmarks' && (
          <div>
            <h3>Problem Statement 26167 Benchmarks</h3>
            <ul style={{ paddingLeft: '1.2rem', lineHeight: '1.6' }}>
              <li><strong>BigEarthNet.txt</strong>: Primary dataset for remote-sensing adaptation using co-registered Sentinel-1 SAR, Sentinel-2 multispectral imagery, and 19-class Corine Land Cover taxonomy.</li>
              <li><strong>VRSBench & RSVQA</strong>: Single-image captioning, grounding bounding boxes, and visual question answering.</li>
              <li><strong>CDVQA</strong>: Multitemporal change-based visual question answering and spatial change description.</li>
              <li><strong>ISRO-SAC Evaluation Set</strong>: Co-registered Cartosat-2S optical (0.65m) and RISAT SAR (C-band hybrid-pol) imagery.</li>
            </ul>
          </div>
        )}
      </dialog>
    </>
  );
}

