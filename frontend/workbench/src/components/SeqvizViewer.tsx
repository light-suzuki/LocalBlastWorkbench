import React, { Suspense } from "react";
import type { AnnotationProp } from "seqviz/dist/elements";

interface Props {
  sequence: string;
  name?: string;
  annotations?: AnnotationProp[];
  height?: number;
  viewer?: "linear" | "circular" | "both";
}

const LazySeqViz = React.lazy(async () => {
  const mod = await import("seqviz");
  return { default: mod.SeqViz };
});

// SnapGene 風の viewer を提供する SeqViz の薄いラッパー
export const SeqvizViewer: React.FC<Props> = ({
  sequence,
  name,
  annotations,
  height = 420,
  viewer = "linear",
}) => {
  const normalized = sequence.replace(/\s+/g, "").toUpperCase();
  if (!normalized) {
    return null;
  }

  return (
    <div className="seqviz-container">
      <Suspense fallback={<div className="seq-hint">SeqViz ビューアを読み込み中...</div>}>
        <LazySeqViz
          name={name ?? "Sequence"}
          seq={normalized}
          viewer={viewer}
          annotations={annotations && annotations.length > 0 ? annotations : undefined}
          style={{ height: `${height}px`, width: "100%" }}
        />
      </Suspense>
    </div>
  );
};
