import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, ArrowUpRight, CalendarDays, Check, CircleHelp, Compass, Crosshair, Database, FileImage, Focus, Layers3, LoaderCircle, Map, MapPin, Maximize2, Minus, Orbit, Plus, Radar, Satellite, Search, Send, Settings2, ShieldCheck, Sparkles, Trash2, Upload, Waves, X } from 'lucide-react';
import type { AnalysisResult, Bounds, CatalogScene, LocationMatch, Observation, SearchResult, Sensor } from './types/workspace';
import { SENSOR_LABELS } from './types/workspace';
import { readObservation } from './services/observationReader';
import { planFusion } from './services/fusionPlan';
import { analyzeWorkspace } from './services/workspaceAnalysis';
import { WorkspaceDialogs } from './components/WorkspaceDialogs';
import { WorkspaceResults } from './components/WorkspaceResults';
import './App.css';
import './location.css';

const today = () => new Date().toISOString().slice(0, 10);
const dateLabel = (value: string) => value ? new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Date unknown';
const suggestions = ['Describe the land-cover in this image.', 'What changed between these two dates?', 'Fuse the available sensors to identify water and built-up areas.'];

export default function App() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [selected, setSelected] = useState('');
  const [source, setSource] = useState<'upload' | 'sentinel'>('upload');
  const [view, setView] = useState<'workspace' | 'fusion'>('workspace');
  const [uploadOpen, setUploadOpen] = useState(false); const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<{ sentinel: boolean; model: boolean; online: boolean; aiProvider?: string; openRouterModel?: string }>({ sentinel: false, model: false, online: false });
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [boundsText, setBoundsText] = useState(['', '', '', '']);
  const [locationQuery, setLocationQuery] = useState('');
  const [locationMatches, setLocationMatches] = useState<LocationMatch[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<LocationMatch | null>(null);
  const [locating, setLocating] = useState(false);
  const [mode, setMode] = useState<'latest' | 'range'>('latest');
  const [start, setStart] = useState(today()); const [end, setEnd] = useState(today());
  const [collections, setCollections] = useState(['sentinel-2-l2a', 'sentinel-1-grd']);
  const [catalog, setCatalog] = useState<SearchResult | null>(null);
  const [catalogBounds, setCatalogBounds] = useState<Bounds | null>(null);
  const [searching, setSearching] = useState(false); const [loadingScene, setLoadingScene] = useState('');
  const [target, setTarget] = useState(today()); const [tolerance, setTolerance] = useState(3);
  const [query, setQuery] = useState(''); const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [sessionMemory, setSessionMemory] = useState<Array<{ query: string; answer: string; observationNames: string[] }>>(() => {
    try { const saved = sessionStorage.getItem('satqueryai-session-memory'); return saved ? JSON.parse(saved) : []; } catch { return []; }
  });
  const [zoom, setZoom] = useState(1); const [compare, setCompare] = useState(false); const [split, setSplit] = useState(50);
  const [comparisonId, setComparisonId] = useState('');
  const canvasRef = useRef<HTMLDivElement>(null); const runRef = useRef<AbortController | null>(null);
  const current = observations.find(o => o.id === selected) || observations[0];
  const second = observations.find(o => o.id === comparisonId && o.id !== current?.id) || observations.find(o => o.id !== current?.id);
  const plan = planFusion(observations, target, tolerance);

  function fetchStatus() {
    fetch('/api/status')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(s => setStatus({ ...s, online: true }))
      .catch(() => {});
  }

  useEffect(() => {
    fetchStatus();
    return () => { runRef.current?.abort(); };
  }, []);

  function invalidate() { runRef.current?.abort(); setAnalyzing(false); setResult(null); }
  function addObservations(loaded: Observation[]) { invalidate(); setObservations(old => [...old, ...loaded]); setSelected(loaded[0].id); setZoom(1); if (loaded[0].date) setTarget(loaded[0].date.slice(0, 10)); }
  async function checkConnection(): Promise<boolean> {
    setCheckingConnection(true); setError(''); setConnectionChecked(false);
    try {
      const local = await fetch('/api/status');
      if (!local.ok) throw new Error('The local API is offline. Stop old terminals, then run npm start from the project folder.');
      const config = await local.json(); setStatus({ ...config, online: true });
      if (config.modelError) setError(config.modelError);
      const response = await fetch('/api/sentinel/check', { method: 'POST', signal: AbortSignal.timeout(35000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setConnectionChecked(true);
      return true;
    } catch (e) { setError(e instanceof Error && !/fetch/i.test(e.message) ? e.message : 'The local API is offline. Run npm start and open the dashboard URL, not port 8787.'); return false; }
    finally { setCheckingConnection(false); }
  }
  async function findLocation() {
    setLocating(true); setError(''); setLocationMatches([]);
    try {
      const response = await fetch(`/api/location/search?q=${encodeURIComponent(locationQuery)}`, { signal: AbortSignal.timeout(12000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Location search failed.');
      if (!Array.isArray(data.matches) || !data.matches.length) throw new Error('No matching location was found. Try city, state, and country.');
      setLocationMatches(data.matches);
    } catch (e) { setError(e instanceof Error ? e.message : 'Location search failed.'); }
    finally { setLocating(false); }
  }
  function chooseLocation(location: LocationMatch) {
    setSelectedLocation(location); setLocationQuery(location.name);
    setBoundsText(location.bounds.map(v => v.toFixed(5)));
    setLocationMatches([]); setCatalog(null); setCatalogBounds(location.bounds);
  }
  async function searchScenes(): Promise<SearchResult | null> {
    setError(''); setSearching(true); setCatalog(null);
    try {
      if (boundsText.some(v => !v.trim())) throw new Error('Fill in all four AOI coordinates.');
      const bounds = boundsText.map(Number) as Bounds;
      const response = await fetch('/api/sentinel/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bounds, collections, mode, start, end }), signal: AbortSignal.timeout(180000) });
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('The local API is offline or not responding. Run npm start and open http://127.0.0.1:5173.');
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setCatalog(data); setCatalogBounds(bounds); setConnectionChecked(true); setStatus(old => ({ ...old, online: true, sentinel: true })); return data;
    } catch (e) { setError(e instanceof Error ? e.message : 'Catalogue search failed.'); return null; } finally { setSearching(false); }
  }
  async function loadLatestPair(searchResult: SearchResult | null = catalog) {
    if (!searchResult) return;
    const preferred = ['sentinel-1-grd', 'sentinel-2-l2a'].flatMap(collection => {
      const candidates = searchResult.scenes.filter(scene => scene.collection === collection && !observations.some(o => o.sceneId === scene.id));
      candidates.sort((a, b) => b.date.localeCompare(a.date) || (a.cloudCover ?? Number.POSITIVE_INFINITY) - (b.cloudCover ?? Number.POSITIVE_INFINITY));
      return candidates.slice(0, 1);
    });
    if (!preferred.length) { setError('The latest available scenes are already loaded.'); return; }
    for (const scene of preferred) await loadScene(scene);
  }
  async function findNewestPair() { if (await checkConnection()) await loadLatestPair(await searchScenes()); }
  async function loadScene(scene: CatalogScene) {
    setLoadingScene(scene.id); setError('');
    try {
      const response = await fetch('/api/sentinel/raster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, bounds: catalogBounds }), signal: AbortSignal.timeout(90000) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
      const file = new File([await response.blob()], `${scene.id}.tiff`, { type: 'image/tiff' });
      const observation = await readObservation(file, scene.collection === 'sentinel-1-grd' ? 'sar' : 'multispectral', scene.date, '', scene.collection === 'sentinel-1-grd' ? [0, 0, 0] : [2, 1, 0]);
      Object.assign(observation, { source: 'sentinel', sceneId: scene.id, collection: scene.collection, cloudCover: scene.cloudCover, crs: 'EPSG:4326', bounds: catalogBounds, resolutionLabel: scene.collection === 'sentinel-1-grd' ? 'Sentinel-1 GRD nominal 10 m; displayed as 768 px AOI grid' : 'Sentinel-2 multispectral native bands 10–60 m; displayed as 768 px AOI grid', name: `${scene.collection === 'sentinel-1-grd' ? 'Sentinel-1 · SAR' : 'Sentinel-2 · Multispectral'} · ${scene.date.slice(0, 10)}` });
      const mask = observation.stats.at(-1);
      if (!mask || mask.max === 0) throw new Error('This acquisition has no valid pixels in the selected AOI. Try another scene.');
      observation.warnings.push('Processed 768 × 768 AOI raster, not native resolution. Sentinel-2 bands: B02, B03, B04, B08, B11, B12, SCL, dataMask. Sentinel-1 bands: VV, VH, dataMask.');
      addObservations([observation]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load acquisition.'); } finally { setLoadingScene(''); }
  }
  async function runAnalysis() {
    const controller = new AbortController(); runRef.current?.abort(); runRef.current = controller;
    setAnalyzing(true); setError(''); setResult(null);
    try { const next = await analyzeWorkspace(query, observations, target, tolerance, status.model, controller.signal, current?.id, sessionMemory); if (!controller.signal.aborted) { setResult(next); setSessionMemory(old => { const updated = [...old, { query: next.query, answer: next.answer.slice(0, 1800), observationNames: observations.map(o => o.name) }].slice(-8); sessionStorage.setItem('satqueryai-session-memory', JSON.stringify(updated)); return updated; }); } }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Analysis failed.'); }
    finally { if (!controller.signal.aborted) setAnalyzing(false); }
  }
  function updateObservation(id: string, changes: Partial<Observation>) { invalidate(); setObservations(old => old.map(o => o.id === id ? { ...o, ...changes } : o)); }

  const modelStatusLabel = status.model
    ? (status.aiProvider === 'openrouter' ? `OpenRouter · ${status.openRouterModel?.split('/')[1]?.split(':')[0] || 'multimodal'}` : status.aiProvider === 'gemini' ? 'Gemini 2.0 Flash VLM' : 'Remote-Sensing VLM')
    : 'SatQuery RS Specialist Engine';

  return <div className="app-shell">
    <aside className="rail" aria-label="Main navigation">
      <a className="brand-mark" href="#" aria-label="SatQuery home"><Orbit size={27}/></a>
      <button className={view === 'workspace' ? 'rail-button active' : 'rail-button'} title="Image workspace" aria-label="Image workspace" onClick={() => setView('workspace')}><Map/></button>
      <button className={view === 'fusion' ? 'rail-button active' : 'rail-button'} title="Fusion workbench" aria-label="Fusion workbench" onClick={() => setView('fusion')}><Layers3/></button>
      <button className="rail-button" title="Sentinel catalogue" aria-label="Sentinel catalogue" onClick={() => { setSource('sentinel'); setView('workspace'); }}><Satellite/></button>
      <div className="rail-spacer"/><button className="rail-button" aria-label="Connection and model setup" title="Connection and model setup" onClick={() => setHelpOpen(true)}><Settings2/></button><div className="avatar" title="Local workspace">SQ</div>
    </aside>
    <div className="app-body">
      <header className="topbar"><div className="wordmark">SatQueryAI<span className="divider"/><span className="project-label">Earth observation workspace</span></div><div className="header-actions"><span className="local-badge"><span/>{modelStatusLabel}</span><button className="button secondary small" onClick={() => setHelpOpen(true)}><CircleHelp size={15}/>Setup & Guide</button></div></header>
      <div className="workspace-heading"><div><div className="eyebrow">MISSION CONTROL <span>/</span> ANALYSIS</div><h1>{view === 'workspace' ? 'Your perspective on Earth.' : 'See more. Together.'}</h1><p>{view === 'workspace' ? 'Bring your imagery. Ask a question. Explore the evidence.' : 'Combine complementary observations of the same place.'}</p></div><button className="button primary" onClick={() => setUploadOpen(true)}><Plus size={17}/>Add imagery</button></div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
      <section className="location-search" aria-label="Location search"><label><MapPin size={15}/>Location<input value={locationQuery} onChange={e => setLocationQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void findLocation(); } }} placeholder="City, landmark, or coordinates"/></label><button className="button secondary small" onClick={() => void findLocation()} disabled={locating}>{locating ? <LoaderCircle size={15} className="spin"/> : <Search size={15}/>}Find location</button>{selectedLocation && <span className="location-summary">{selectedLocation.latitude.toFixed(5)}, {selectedLocation.longitude.toFixed(5)} · AOI selected</span>}{current?.resolutionLabel && <span className="location-summary">{current.resolutionLabel}</span>}{locationMatches.length > 0 && <div className="location-matches">{locationMatches.map(location => <button key={`${location.latitude},${location.longitude}`} onClick={() => chooseLocation(location)}><strong>{location.name}</strong><small>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</small></button>)}</div>}{selectedLocation && <button className="button primary small" disabled={searching || !!loadingScene} onClick={() => void findNewestPair()}><Satellite size={15}/>Get newest SAR + spectral pair</button>}</section>
      <main className="work-grid">
        <section className="panel sources-panel" aria-label="Data sources">
          <div className="panel-heading"><h2><Database size={17}/>Data sources</h2><span className="count">{observations.length.toString().padStart(2, '0')}</span></div>
          <div className="segmented source-tabs"><button className={source === 'upload' ? 'selected' : ''} onClick={() => setSource('upload')}>My imagery</button><button className={source === 'sentinel' ? 'selected' : ''} onClick={() => setSource('sentinel')}>Sentinel Hub</button></div>
          {source === 'upload' ? <div className="source-content"><button className="upload-zone" onClick={() => setUploadOpen(true)}><span className="upload-icon"><Upload size={22}/></span><strong>Bring your own imagery</strong><span>GeoTIFF, JP2, JPEG or PNG</span><span className="text-link">Browse files <ArrowUpRight size={13}/></span></button><div className="section-label">OBSERVATIONS <span>{observations.length} loaded</span></div>
            {!observations.length && <div className="empty-list"><Layers3 size={25}/><p>Your image collection starts here.</p><span>Add one image to explore a scene, or multiple images to compare.</span></div>}
            <div className="observation-list">{observations.map(o => <div className={`observation-card ${current?.id === o.id ? 'selected' : ''}`} key={o.id}><button className="observation-select" onClick={() => { setSelected(o.id); setZoom(1); }}><img src={o.preview} alt=""/><span><strong>{o.name}</strong><small>{SENSOR_LABELS[o.sensor]} · {dateLabel(o.date)}</small></span></button><button className="remove-observation" aria-label={`Remove ${o.name}`} onClick={() => { invalidate(); setObservations(old => old.filter(x => x.id !== o.id)); }}><Trash2 size={13}/></button></div>)}</div>
          </div> : <div className="source-content sentinel-controls"><div className={`connection ${status.sentinel ? 'connected' : ''}`}><Satellite size={15}/>{connectionChecked ? 'Copernicus connected' : status.sentinel ? 'Credentials configured' : 'Connection required'}<button aria-label="Sentinel setup" onClick={() => setHelpOpen(true)}><ArrowUpRight size={14}/></button></div><button className="button secondary full small" onClick={checkConnection} disabled={checkingConnection}>{checkingConnection ? "Checking connection…" : "Test Sentinel connection"}</button><label className="field-label">Area of interest <span>WGS84</span></label><div className="coordinate-grid">{['West', 'South', 'East', 'North'].map((label, i) => <label key={label}>{label}<input aria-label={`${label} coordinate`} type="number" step="0.01" value={boundsText[i]} onChange={e => setBoundsText(old => old.map((v, j) => i === j ? e.target.value : v))}/></label>)}</div><p className="field-hint">Enter a place name or a single "latitude, longitude" above, or type the four AOI coordinates here.</p><div className="segmented"><button className={mode === 'latest' ? 'selected' : ''} onClick={() => setMode('latest')}>Latest available</button><button className={mode === 'range' ? 'selected' : ''} onClick={() => setMode('range')}>Date range</button></div>{mode === 'range' && <div className="date-range"><label>From<input type="date" value={start} onChange={e => setStart(e.target.value)}/></label><label>To<input type="date" value={end} onChange={e => setEnd(e.target.value)}/></label></div>}<label className="field-label">Sensors</label>{[['sentinel-2-l2a', 'Sentinel-2', 'Multispectral'], ['sentinel-1-grd', 'Sentinel-1', 'SAR']].map(([id, name, label]) => <label className="sensor-check" key={id}><input type="checkbox" checked={collections.includes(id)} onChange={e => setCollections(old => e.target.checked ? [...old, id] : old.filter(c => c !== id))}/><span>{name}<small>{label}</small></span></label>)}<button className="button primary full" disabled={searching || !collections.length} onClick={searchScenes}>{searching ? <LoaderCircle className="spin" size={16}/> : <Search size={16}/>} {searching ? 'Checking availability…' : 'Find imagery'}</button><p className="field-hint"><CalendarDays size={13}/>No match? See the nearest available dates.</p>{catalog && <div className="catalog-results"><p className={catalog.fallback ? 'notice' : 'field-hint'}>{catalog.message}</p>{catalog.truncated && <p className="notice">Showing up to 12 dates per sensor and 100 scenes per date. Narrow the range for more.</p>}{catalog.scenes.map(scene => <button key={scene.id} className="scene-result" disabled={!!loadingScene || observations.some(o => o.sceneId === scene.id)} onClick={() => loadScene(scene)}><span><strong>{dateLabel(scene.date)}</strong><small>{scene.collection === 'sentinel-1-grd' ? 'Sentinel-1 · SAR' : `Sentinel-2 · ${scene.cloudCover == null ? 'cloud cover unknown' : scene.cloudCover.toFixed(0) + '% cloud'}`}</small></span>{loadingScene === scene.id ? <LoaderCircle size={16} className="spin"/> : observations.some(o => o.sceneId === scene.id) ? <Check size={16}/> : <Plus size={16}/>}</button>)}</div>}</div>}
          <div className="sources-footer"><ShieldCheck size={15}/><span>JP2 decoding uses the local API. Analysis requests execute agentic remote-sensing specialists with visual grounding.</span></div>
        </section>

        <section className="center-column">
          <div className="panel viewer-panel"><div className="viewer-heading"><div className="view-tabs"><button className={view === 'workspace' ? 'active' : ''} onClick={() => setView('workspace')}><Map size={15}/>Image workspace</button><button className={view === 'fusion' ? 'active' : ''} onClick={() => setView('fusion')}><Layers3 size={15}/>Fusion</button></div><button className="icon-button" title="Expand viewer" aria-label="Expand viewer" onClick={() => { if (document.fullscreenElement) document.exitFullscreen(); else canvasRef.current?.requestFullscreen().catch(() => setError('Fullscreen is not available in this browser.')); }}><Maximize2 size={16}/></button></div>
            <div className={`image-canvas ${current ? 'has-image' : ''}`} ref={canvasRef}>
              {current ? <><div className="raster-stage" style={{ transform: `scale(${zoom})`, '--raster-aspect': current.width / current.height } as CSSProperties}><img className="primary-raster" src={current.preview} alt={`Raster preview of ${current.name}`}/>{compare && second && <img className="compare-raster" src={second.preview} alt={`Comparison preview of ${second.name}`} style={{ clipPath: `inset(0 0 0 ${split}%)` }}/>}<svg className="evidence-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Model evidence">{!compare && result?.evidence?.filter(e => e.observationId === current.id).map((e, i) => <g key={i}><rect x={e.box[0] * 100} y={e.box[1] * 100} width={(e.box[2] - e.box[0]) * 100} height={(e.box[3] - e.box[1]) * 100}/><title>{e.label}</title></g>)}</svg></div><span className="canvas-badge"><span/>{SENSOR_LABELS[current.sensor]} · {compare ? 'Visual comparison' : 'Raster preview'}</span>{compare && second && <><div className="swipe-divider" style={{ left: `${split}%` }}><span>↔</span></div><input className="swipe-control" type="range" aria-label="Image comparison split" min="0" max="100" value={split} onChange={e => setSplit(Number(e.target.value))}/><div className="compare-disclaimer">Visual comparison only · alignment not verified</div></>}<div className="viewer-tools"><button aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(z => Math.min(3, z + .25))}><Plus size={18}/></button><button aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - .25))}><Minus size={18}/></button><button aria-label="Fit image" onClick={() => setZoom(1)}><Focus size={18}/></button></div></> : <><div className="coordinate-label top-left">EARTH OBSERVATION / NEW SESSION</div><div className="coordinate-label bottom-left">NO IMAGE LOADED</div><div className="canvas-empty"><div className="orbit-icon"><Orbit size={52} strokeWidth={1}/></div><h2>A new view starts here.</h2><p>Upload a remote-sensing image or find<br/>an acquisition from Sentinel.</p><button className="button primary" onClick={() => setUploadOpen(true)}><Upload size={16}/>Upload imagery</button><button className="canvas-link" onClick={() => setSource('sentinel')}>Explore Sentinel data <ArrowUpRight size={14}/></button></div></>}
              <div className="north-indicator"><span>N</span><Compass size={25} strokeWidth={1.3}/></div>
            </div><div className="viewer-status"><span><Crosshair size={13}/>{current?.crs || 'CRS not available'}</span><span>{current ? `${current.width.toLocaleString()} × ${current.height.toLocaleString()} px` : 'Awaiting imagery'}</span><span>{current ? `${Math.round(zoom * 100)}%` : '—'}</span></div>
          </div>
          {current && <div className="panel metadata-strip"><div><span>ACQUISITION</span><strong>{dateLabel(current.date)}</strong></div><div><span>INPUT BANDS</span><strong>{current.bands}</strong></div><div><span>SOURCE</span><strong>{current.source === 'upload' ? 'Your upload' : 'Copernicus'}</strong></div><button className={`button secondary small ${compare ? 'enabled' : ''}`} disabled={!second} onClick={() => setCompare(!compare)}><Layers3 size={14}/>{compare ? 'Single view' : 'Compare'}</button>{compare && second && <label className="compare-select">Compare with<select value={second.id} onChange={e => setComparisonId(e.target.value)}>{observations.filter(o => o.id !== current.id).map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></label>}</div>}
          <div className="panel fusion-panel"><div className="panel-heading"><h2><Layers3 size={17}/>Multisensor fusion</h2><span className="subtle-badge">{plan.eligible.length} candidates</span></div><p className="panel-description">Different sensors. A shared area. A fuller picture.</p><div className="fusion-controls"><label>Target date<input type="date" value={target} onChange={e => { invalidate(); setTarget(e.target.value); }}/></label><label>Temporal window<select value={tolerance} onChange={e => { invalidate(); setTolerance(Number(e.target.value)); }}>{[0, 1, 3, 7, 14, 30].map(d => <option value={d} key={d}>{d === 0 ? 'Same day only' : `± ${d} days`}</option>)}</select></label></div><div className="sensor-chips">{Object.entries(SENSOR_LABELS).map(([id, label]) => <span key={id} className={plan.eligible.some(o => o.sensor === id) ? 'sensor-chip present' : 'sensor-chip'}>{id === 'sar' ? <Radar size={13}/> : id === 'thermal' ? <Waves size={13}/> : <Layers3 size={13}/>} {label}</span>)}</div>
            {view === 'fusion' && <div className="fusion-details">{observations.map(o => <div className="fusion-row" key={o.id}><strong>{o.name}</strong><label>Sensor<select value={o.sensor} onChange={e => updateObservation(o.id, { sensor: e.target.value as Sensor })}>{Object.entries(SENSOR_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>Acquired<input type="date" value={o.date.slice(0, 10)} onChange={e => updateObservation(o.id, { date: e.target.value })}/></label><span className={plan.candidates.find(c => c.observation.id === o.id)?.eligible ? 'candidate-yes' : 'candidate-no'}>{plan.candidates.find(c => c.observation.id === o.id)?.eligible ? 'In window' : 'Outside window / undated'}</span></div>)}{plan.reasons.map(reason => <p className="field-hint" key={reason}>{reason}</p>)}<p className="field-hint">{plan.alignment}</p></div>}
            <div className="fusion-bottom"><span><span className={`status-dot ${plan.ready ? 'ready' : ''}`}/>{plan.ready ? 'Inputs pass spatial and temporal prechecks' : observations.length ? 'Review dates and spatial compatibility' : 'Add observations to prepare a fusion'}</span><button onClick={() => { setView('fusion'); setQuery(suggestions[2]); }} aria-label="Prepare fusion query"><ArrowUpRight size={18}/></button></div>
          </div>
        </section>

        <section className="panel assistant-panel"><div className="panel-heading"><h2><Sparkles size={18}/>SatQuery assistant</h2><span className="assistant-badge">AI</span></div><div className="assistant-context"><span className="status-dot ready"/>{modelStatusLabel}</div><div className="conversation"><div className="assistant-avatar"><Orbit size={20}/></div><h2>What would you like to discover?</h2><p>Ask about your scene, compare two dates, or bring multiple sensors into one analysis.</p><div className="suggestions">{suggestions.map((s, i) => <button key={s} onClick={() => setQuery(s)}>{i === 0 ? <Focus size={15}/> : i === 1 ? <CalendarDays size={15}/> : <Layers3 size={15}/>}<span>{i === 0 ? 'Describe this scene' : i === 1 ? 'Explore changes over time' : 'Combine sensor observations'}</span><ArrowUpRight size={13}/></button>)}</div>
            {analyzing && <div className="analysis-loading" aria-live="polite"><LoaderCircle size={20} className="spin"/><span>Running agentic remote-sensing analysis…</span><button onClick={() => { runRef.current?.abort(); setAnalyzing(false); }}>Cancel</button></div>}
            {result && <WorkspaceResults key={result.timestamp} result={result} observations={observations}/>}
          </div><form className="query-composer" onSubmit={e => { e.preventDefault(); void runAnalysis(); }}><div className="query-input"><textarea aria-label="Ask about your imagery" placeholder="Ask about your imagery…" value={query} onChange={e => setQuery(e.target.value)} maxLength={4000} rows={3}/><div className="query-bottom"><span><FileImage size={13}/>{observations.length} {observations.length === 1 ? 'image' : 'images'} in context</span><button className="send-button" aria-label="Run analysis" disabled={analyzing || !query.trim() || !observations.length} type="submit">{analyzing ? <LoaderCircle size={17} className="spin"/> : <Send size={17}/>}</button></div></div><p>Results are evidence-grounded and verifiable.</p></form></section>
      </main>
      <footer className="footer"><span><Activity size={13}/>SatQueryAI <span className="footer-slash">/</span> Remote sensing workspace</span><span>PS 26167 <span className="footer-slash">·</span> {status.online ? 'Local API online' : 'Local API offline'}</span></footer>
    </div>
    <WorkspaceDialogs uploadOpen={uploadOpen} helpOpen={helpOpen} closeUpload={() => setUploadOpen(false)} closeHelp={() => setHelpOpen(false)} onLoaded={addObservations} onModelConfigured={fetchStatus}/>
  </div>;
}



