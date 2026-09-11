import { useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import type { AnalysisResult, Observation } from '../types/workspace';
export function WorkspaceResults({ result, observations: allObservations }: { result: AnalysisResult; observations: Observation[] }) {
  const observations = allObservations.filter(o => result.observationIds.includes(o.id));
  const [tab, setTab] = useState<'answer' | 'evidence' | 'trace'>('answer');
  function downloadReport() {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...result, observations: observations.map(({ preview: _preview, file: _file, ...o }) => o) }, null, 2)], { type: 'application/json' }));
    a.href = url; a.download = 'satquery-analysis.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="analysis-result" aria-live="polite"><div className="result-title"><span>{result.mode === 'model' ? 'Model analysis' : 'Image inspection'}</span><button aria-label="Download analysis report" title="Download JSON report" onClick={downloadReport}><ArrowDownToLine size={16}/></button></div><div className="result-tabs">{(['answer', 'evidence', 'trace'] as const).map(t => <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>{t}</button>)}</div>
    {tab === 'answer' && <><p className="answer-text">{result.answer}</p><div className="confidence">Confidence <strong>{result.confidence == null ? 'Not estimated' : `${(result.confidence * 100).toFixed(1)}%`}</strong></div><ul className="findings">{result.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>{result.warnings.map((w, i) => <p className="result-warning" key={i}>{w}</p>)}</>}
    {tab === 'trace' && <ol className="trace-list">{result.trace.map((t, i) => <li key={i}><span className="trace-number">{i + 1}</span><div><strong>{t.tool}</strong><small>{t.status}</small><p>{t.detail}</p></div></li>)}</ol>}
    {tab === 'evidence' && <div className="evidence-list"><p className="field-hint">Measured file information. Band statistics are sampled raw values, not land-cover predictions.</p>{observations.map(o => <div key={o.id}><strong>{o.name}</strong><p>{o.width} × {o.height} · {o.bands} bands · {o.crs || 'CRS unknown'}</p>{o.stats.length > 0 && <table><thead><tr><th>Band</th><th>Min</th><th>Max</th><th>Mean</th></tr></thead><tbody>{o.stats.map(s => <tr key={s.band}><td>{s.band}</td><td>{s.validPixels ? s.min.toFixed(2) : '—'}</td><td>{s.validPixels ? s.max.toFixed(2) : '—'}</td><td>{s.validPixels ? s.mean.toFixed(2) : '—'}</td></tr>)}</tbody></table>}</div>)}</div>}
  </div>;
}

