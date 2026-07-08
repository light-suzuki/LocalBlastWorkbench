import React from "react";
import type { BlastHit } from "../types/blast";

const SOURCE_COLORS: Record<string, string> = {
  local: "#1b7f5c",
  ncbi: "#f59e0b",
  ensembl: "#3b82f6",
  other: "#6366f1",
};

interface Props {
  hits: BlastHit[];
  queryLength: number;
}

const colorForSource = (source?: string) =>
  SOURCE_COLORS[source ?? ""] || SOURCE_COLORS.other;

// BLAST ヒットをシンプルなトラック（JBrowse 風）で重ねる
export const BlastHitTrack: React.FC<Props> = ({ hits, queryLength }) => {
  if (!queryLength || hits.length === 0) {
    return null;
  }

  const trimmedHits = hits.slice(0, 40);

  return (
    <div className="blast-track">
      <div className="blast-track-scale">
        <span>0</span>
        <span>{queryLength} bp</span>
      </div>
      <div className="blast-track-bar">
        {trimmedHits.map((hit, idx) => {
          const start = Math.max(0, Math.min(hit.qstart, hit.qend) - 1);
          const end = Math.max(start + 1, Math.max(hit.qstart, hit.qend));
          const leftPct = (100 * start) / queryLength;
          const widthPct = (100 * (end - start)) / queryLength;
          return (
            <div
              key={`${hit.sseqid}-${idx}`}
              className="blast-track-hit"
              style={{
                left: `${leftPct}%`,
                width: `${Math.min(widthPct, 100 - leftPct)}%`,
                backgroundColor: colorForSource(hit.source),
              }}
              title={`${hit.sseqid} (${hit.pident.toFixed(
                1,
              )}%, ${hit.qstart}-${hit.qend})`}
            />
          );
        })}
      </div>
      <div className="blast-track-legend">
        {Object.entries(SOURCE_COLORS).map(([key, color]) => (
          <span key={key} className="legend-item">
            <span className="legend-box" style={{ backgroundColor: color }} />
            {key}
          </span>
        ))}
      </div>
    </div>
  );
};
