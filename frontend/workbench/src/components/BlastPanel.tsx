import React, { useEffect, useMemo, useState } from "react";
import type { AnnotationProp } from "seqviz/dist/elements";
import { SeqvizViewer } from "./SeqvizViewer";
import { BlastHitTrack } from "./BlastHitTrack";
import {
  ensemblGeneUrl,
  navigatorGeneUrl,
  isLocalOnlyDb,
  ensemblLocationUrl,
  navigatorLocationUrl,
  ensemblTranscriptExportUrl,
  ensemblTranscriptSummaryUrl,
  inferEnsemblPlantsSpecies,
  inferEnsemblTranscriptId,
} from "../utils/ensembl";
import { EnsemblLinksInline } from "./EnsemblLinksInline";

import { bioapiClient } from "../api/bioapiClient";
import type { BlastHit, BlastResponse, NCBITarget } from "../types/blast";
import type { BlastLiftoverResult } from "../types/convert";
import { downloadFasta, downloadMarkdown, openPrintViewForMarkdown } from "../utils/exportReport";
import { useWorkbench } from "../utils/workbenchContext";
import { pollJobUntilDone } from "../utils/jobPolling";
import { JobProgressCard } from "./JobProgressCard";
import { useToast } from "./ToastProvider";
import {
  DEFAULT_BLAST_DB_BASE,
  query_TO_ref_VIRTUAL_DB_LABEL,
  query_TO_ref_VIRTUAL_DB_VALUE,
  withqueryTorefVirtualDbOption,
  labelForDbPath,
  relabelLocalBlastHits,
  useLocalBlastDbOptions,
  usePreferredLocalDbPaths,
  normalizeLocalDbValue,
} from "../utils/localBlastDbs";
import { useLocalBlastMode } from "../utils/localBlastMode";
import { DEFAULT_NCBI_TARGETS } from "../config/referencePresets";
import type { JobInfo } from "../types/jobs";
import {
  loadqueryrefBestGeneMap,
  normalizequeryrefGeneId,
  type queryrefBestGeneMapping,
} from "../utils/queryrefExcelMapping";

type BlastBackend = "local" | "ncbi" | "ensembl";

const SOURCE_COLORS: Record<string, string> = {
  local: "#1b7f5c",
  ncbi: "#f59e0b",
  ensembl: "#3b82f6",
  other: "#6366f1",
};

const MAX_DISPLAY_HITS = 50;

const QUALITY_GRADES = [
  { label: "S", className: "quality-badge grade-s", pident: 99.5, length: 300, evalue: 1e-40 },
  { label: "A", className: "quality-badge grade-a", pident: 98.0, length: 200, evalue: 1e-20 },
  { label: "B", className: "quality-badge grade-b", pident: 96.0, length: 120, evalue: 1e-8 },
  { label: "C", className: "quality-badge grade-c", pident: 94.0, length: 60, evalue: 1e-4 },
  { label: "D", className: "quality-badge grade-d", pident: 0, length: 0, evalue: Number.POSITIVE_INFINITY },
];

const colorForSource = (source?: string) => {
  if (!source) return SOURCE_COLORS.other;
  if (source.startsWith("local")) return SOURCE_COLORS.local;
  if (source.startsWith("ncbi")) return SOURCE_COLORS.ncbi;
  if (source.startsWith("ensembl")) return SOURCE_COLORS.ensembl;
  return SOURCE_COLORS[source] || SOURCE_COLORS.other;
};

const wrapSeq = (seq: string, width = 60): string => {
  const s = (seq || "").replace(/\s+/g, "");
  if (!s) return "";
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
  return lines.join("\n");
};

const toFasta = (header: string, seq: string): string => {
  const h = (header || "sequence").replace(/\s+/g, " ").trim();
  return `>${h}\n${wrapSeq(seq)}\n`;
};

// BLAST 実行 + ヒットのシンプルトラック表示
export const BlastPanel: React.FC = () => {
  const { showToast } = useToast();
  const { options: localDbOptions } = useLocalBlastDbOptions();
  const localDbOptionsWithVirtual = useMemo(
    () => withqueryTorefVirtualDbOption(localDbOptions),
    [localDbOptions],
  );
  const [sequence, setSequence] = useState<string>("");
  const [normalizedQuery, setNormalizedQuery] = useState<string>("");
  const { presetBlastQuery, setPresetBlastQuery, setActiveTab, setPresetGenomeSlice } = useWorkbench();
  const [selectedLocalDbs, setSelectedLocalDbs] = usePreferredLocalDbPaths();
  const [customLocalDb, setCustomLocalDb] = useState<string>("");
  const [localMode, setLocalMode] = useLocalBlastMode();
  const [blastEngine] = useState<"blast" | "cuda">("blast");

  type LocalDbView = {
    label: string;
    value: string;
    path: string;
    kind: "db" | "query_to_ref";
  };

  const queryDbPath = useMemo(() => {
    const hit = localDbOptions.find((o) => o.label.toLowerCase() === "UserDB_query");
    return hit?.value || "UserDB_query";
  }, [localDbOptions]);

  const localDbViews = useMemo<LocalDbView[]>(() => {
    const manual = normalizeLocalDbValue(customLocalDb);
    const out: LocalDbView[] = [];
    const seen = new Set<string>();
    const push = (v: LocalDbView) => {
      const key = `${v.kind}|${v.label}|${v.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(v);
    };

    selectedLocalDbs.forEach((value) => {
      if (value === query_TO_ref_VIRTUAL_DB_VALUE) {
        push({ value, label: query_TO_ref_VIRTUAL_DB_LABEL, path: queryDbPath, kind: "query_to_ref" });
        return;
      }
      push({ value, label: labelForDbPath(value, localDbOptions), path: value, kind: "db" });
    });

    if (manual) {
      push({ value: manual, label: labelForDbPath(manual, localDbOptions), path: manual, kind: "db" });
    }

    return out;
  }, [customLocalDb, localDbOptions, selectedLocalDbs, queryDbPath]);

  const localDbPathsToQuery = useMemo(
    () => Array.from(new Set(localDbViews.map((v) => v.path))).filter(Boolean),
    [localDbViews],
  );

  const wantsqueryTorefView = useMemo(
    () => localDbViews.some((v) => v.kind === "query_to_ref"),
    [localDbViews],
  );
  const [ncbiDb, setNcbiDb] = useState<string>("nt");
  const [ncbiQuery, setNcbiQuery] = useState<string>(
    "Arabidopsis thaliana[Organism]",
  );
  const [useNcbiPresetTargets, setUseNcbiPresetTargets] = useState<boolean>(true);
  const [useArabidopsis, setUseArabidopsis] = useState<boolean>(true);
  const [maxHits, setMaxHits] = useState<number>(10);
  const [blastTask, setBlastTask] = useState<string>("megablast");
  const [blastEvalue, setBlastEvalue] = useState<number>(1e-5);
  const [blastMaxHsps, setBlastMaxHsps] = useState<number | null>(null);
  const [blastNumThreads, setBlastNumThreads] = useState<number | null>(null);
  const [blastMaxParallelDbs, setBlastMaxParallelDbs] = useState<number | null>(null);
  const [useLocal, setUseLocal] = useState<boolean>(true);
  const [useNcbi, setUseNcbi] = useState<boolean>(false);
  const [useEnsembl, setUseEnsembl] = useState<boolean>(false);
  const [ensemblSpecies, setEnsemblSpecies] = useState<string>("homo_sapiens");
  const [resultTab, setResultTab] = useState<"local" | "ncbi" | "ensembl">("local");

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [localJobId, setLocalJobId] = useState<string | null>(null);
  const [localJobInfo, setLocalJobInfo] = useState<JobInfo | null>(null);
  const [localResult, setLocalResult] = useState<BlastResponse | null>(null);
  const [localResultsByDb, setLocalResultsByDb] = useState<Record<string, BlastResponse>>({});
  const [ncbiResult, setNcbiResult] = useState<BlastResponse | null>(null);
  const [ensemblResult, setEnsemblResult] = useState<BlastResponse | null>(null);

  const [queryTorefLoading, setqueryTorefLoading] = useState<boolean>(false);
  const [queryTorefError, setqueryTorefError] = useState<string | null>(null);
  const [queryTorefResults, setqueryTorefResults] = useState<Record<string, BlastLiftoverResult>>({});
  const [queryTorefXlsxLoading, setqueryTorefXlsxLoading] = useState<boolean>(false);
  const [queryTorefXlsxError, setqueryTorefXlsxError] = useState<string | null>(null);
  const [queryTorefXlsxMap, setqueryTorefXlsxMap] = useState<Map<string, queryrefBestGeneMapping> | null>(null);

  const [ensemblExportBusyKey, setEnsemblExportBusyKey] = useState<string | null>(null);
  const [ensemblExportError, setEnsemblExportError] = useState<string | null>(null);
  const [copyBusyKey, setCopyBusyKey] = useState<string | null>(null);

  const [recentNcbiQueries, setRecentNcbiQueries] = useState<string[]>([]);
  const [favoriteNcbiQueries, setFavoriteNcbiQueries] = useState<string[]>([]);

  const queryLength = normalizedQuery.length;
  const refDbPath = "UserDB_ref";
  const applyBlastPreset = (preset: "fast" | "balanced" | "sensitive" | "primer") => {
    if (loading) return;
    if (preset === "fast") {
      setBlastTask("megablast");
      setBlastEvalue(1e-20);
      setMaxHits(5);
      setBlastMaxHsps(1);
      setBlastNumThreads(null);
      setBlastMaxParallelDbs(3);
      showToast("プリセット適用: 速度優先（megablast / max_hits=5）", "success");
      return;
    }
    if (preset === "balanced") {
      setBlastTask("megablast");
      setBlastEvalue(1e-10);
      setMaxHits(10);
      setBlastMaxHsps(1);
      setBlastNumThreads(null);
      setBlastMaxParallelDbs(3);
      showToast("プリセット適用: バランス（megablast / max_hits=10）", "success");
      return;
    }
    if (preset === "sensitive") {
      setBlastTask("dc-megablast");
      setBlastEvalue(1e-5);
      setMaxHits(25);
      setBlastMaxHsps(null);
      setBlastNumThreads(null);
      setBlastMaxParallelDbs(2);
      showToast("プリセット適用: 感度優先（dc-megablast / max_hits=25）", "success");
      return;
    }
    setBlastTask("blastn-short");
    setBlastEvalue(1000);
    setMaxHits(50);
    setBlastMaxHsps(1);
    setBlastNumThreads(null);
    setBlastMaxParallelDbs(2);
    showToast("プリセット適用: 短い配列（blastn-short / max_hits=50）", "success");
  };

  const needsqueryTorefXlsxMap = useMemo(() => {
    if (!wantsqueryTorefView) return false;
    const hits = localResult?.hits ?? [];
    return hits.some((h) => {
      const genes = [
        ...(h.gene_ids ?? []),
        ...(h.gene_names ?? []),
      ].filter(Boolean);
      return genes.some((g) => /^GENE\\.reference\\.query\\./i.test(g));
    });
  }, [localResult?.hits, wantsqueryTorefView]);

  useEffect(() => {
    if (!needsqueryTorefXlsxMap) return;
    if (queryTorefXlsxLoading) return;
    if (queryTorefXlsxMap) return;

    let cancelled = false;
    setqueryTorefXlsxLoading(true);
    setqueryTorefXlsxError(null);
    loadqueryrefBestGeneMap()
      .then((m) => {
        if (cancelled) return;
        setqueryTorefXlsxMap(m);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "query→ref 対応表（Excel）の読み込みに失敗しました。";
        setqueryTorefXlsxError(msg);
      })
      .finally(() => {
        if (cancelled) return;
        setqueryTorefXlsxLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [needsqueryTorefXlsxMap, queryTorefXlsxLoading, queryTorefXlsxMap]);

  useEffect(() => {
    const preset = presetBlastQuery?.sequence?.trim();
    if (!preset) return;
    setSequence(preset);
    setPresetBlastQuery?.(null);
  }, [presetBlastQuery, setPresetBlastQuery]);

  const splitIdAndDesc = (sseqid: string): { id: string; desc: string; chr?: string } => {
    const trimmed = sseqid.trim();
    if (!trimmed) {
      return { id: "-", desc: "" };
    }
    const parts = trimmed.split(/\s+/);
    const id = parts[0] ?? "-";
    const desc = parts.slice(1).join(" ").replace(/\s+/g, " ");
    // ゆるいヒューリスティックで染色体/コンティグ名を抽出
    const chromFromDesc = desc.match(/\bchr(?:omosome)?\s*([0-9A-Za-z]+)/i);
    const chromFromId =
      id.startsWith("NC_") || id.startsWith("NW_") || id.startsWith("NZ_")
        ? id
        : null;
    const chr =
      (chromFromDesc && chromFromDesc[1]) ||
      (chromFromId ? chromFromId.replace(/\.\d+$/, "") : undefined);
    return { id, desc, chr };
  };

  // Helper to get DB label for a hit source
  const getDbLabelForSource = (source?: string) => {
    if (!source) return null;
    if (source.startsWith("local:")) {
      return source.replace("local:", "").trim();
    }
    return null;
  };


  const blastAnnotations = useMemo<AnnotationProp[]>(() => {
    const allHits: BlastHit[] = [
      ...(localResult?.hits ?? []),
      ...(ncbiResult?.hits ?? []),
      ...(ensemblResult?.hits ?? []),
    ];
    if (!allHits.length || !queryLength) {
      return [];
    }
    return allHits.map((hit) => {
      const start = Math.max(0, Math.min(hit.qstart, hit.qend) - 1);
      const unclampedEnd = Math.max(start + 1, Math.max(hit.qstart, hit.qend));
      const end = Math.min(queryLength, unclampedEnd);
      return {
        start,
        end,
        name: `${splitIdAndDesc(hit.sseqid).id} ${hit.pident.toFixed(1)}%`,
        direction: hit.qstart <= hit.qend ? 1 : -1,
        color: colorForSource(hit.source),
      };
    });
  }, [ensemblResult, localResult, ncbiResult, queryLength]);

  const labelForDb = (path: string) =>
    labelForDbPath(path, localDbOptions);

  const toggleLocalDb = (path: string) => {
    setSelectedLocalDbs((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  };

  const compactHits = useMemo(() => {
    const merged: BlastHit[] = [
      ...(localResult?.hits ?? []),
      ...(ncbiResult?.hits ?? []),
      ...(ensemblResult?.hits ?? []),
    ];
    return merged
      .slice()
      .sort((a, b) => (a.evalue ?? 1) - (b.evalue ?? 1) || (b.pident ?? 0) - (a.pident ?? 0))
      .map((h, idx) => ({
        idx: idx + 1,
        source: h.source || "ncbi",
        id: splitIdAndDesc(h.sseqid).id,
        desc: splitIdAndDesc(h.sseqid).desc,
        pident: h.pident,
        length: h.length,
        evalue: h.evalue,
        qrange: `${Math.min(h.qstart, h.qend)}–${Math.max(h.qstart, h.qend)}`,
        sstart: h.sstart,
        send: h.send,
      }))
      .slice(0, 50);
  }, [ensemblResult, localResult, ncbiResult]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const recentRaw = window.localStorage.getItem("seqwb_blast_ncbi_recent");
      const favRaw = window.localStorage.getItem("seqwb_blast_ncbi_favorites");
      if (recentRaw) {
        const parsed = JSON.parse(recentRaw);
        if (Array.isArray(parsed)) {
          setRecentNcbiQueries(parsed.filter((v) => typeof v === "string"));
        }
      }
      if (favRaw) {
        const parsed = JSON.parse(favRaw);
        if (Array.isArray(parsed)) {
          setFavoriteNcbiQueries(parsed.filter((v) => typeof v === "string"));
        }
      }
    } catch {
      // localStorage が使えない環境では何もしない
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const recent = recentNcbiQueries.slice(0, 10);
      const fav = favoriteNcbiQueries.slice(0, 20);
      window.localStorage.setItem("seqwb_blast_ncbi_recent", JSON.stringify(recent));
      window.localStorage.setItem("seqwb_blast_ncbi_favorites", JSON.stringify(fav));
    } catch {
      // 保存に失敗しても致命的ではないので黙殺
    }
  }, [recentNcbiQueries, favoriteNcbiQueries]);

  const rememberNcbiQuery = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecentNcbiQueries((prev) => {
      const next = [trimmed, ...prev.filter((v) => v !== trimmed)];
      return next.slice(0, 10);
    });
  };

  const toggleFavoriteNcbiQuery = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setFavoriteNcbiQueries((prev) =>
      prev.includes(trimmed) ? prev.filter((v) => v !== trimmed) : [trimmed, ...prev],
    );
  };

  const isCurrentQueryFavorite = favoriteNcbiQueries.includes(ncbiQuery.trim());

  const cancelLocalJob = async () => {
    if (!localJobId) return;
    try {
      const info = await bioapiClient.cancelJob(localJobId);
      setLocalJobInfo(info);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "キャンセルに失敗しました。";
      setError(msg);
    }
  };

  const localDbLabelToPath = useMemo(() => {
    const map = new Map<string, string>();
    localDbViews.forEach((view) => {
      const base = view.path.split(/[/\\]/).filter(Boolean).pop() ?? view.path;
      map.set(base, view.path);
      map.set(view.label, view.path);
    });
    return map;
  }, [localDbViews]);

  const liftoverKey = (srcDb: string, entry: string, start: number, end: number) =>
    `${srcDb}|${entry}|${Math.min(start, end)}|${Math.max(start, end)}`;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!wantsqueryTorefView) return;
      if (queryTorefLoading) return;
      if (!localResult?.hits?.length) return;

      const queryLabel = labelForDbPath(queryDbPath, localDbOptions);
      const queryHits = localResult.hits
        .filter((h) => {
          const src = h.source || "";
          const tag = src.startsWith("local:") ? src.slice("local:".length) : src;
          return tag === queryLabel;
        })
        .slice(0, MAX_DISPLAY_HITS);
      if (!queryHits.length) return;

      const regs: Array<{ entry: string; start: number; end: number }> = [];
      const seen = new Set<string>();
      queryHits.forEach((hit) => {
        const { id } = splitIdAndDesc(hit.sseqid);
        const s1 = Math.min(hit.sstart, hit.send);
        const s2 = Math.max(hit.sstart, hit.send);
        const key = liftoverKey(queryDbPath, id, s1, s2);
        if (queryTorefResults[key]) return;
        if (seen.has(key)) return;
        seen.add(key);
        regs.push({ entry: id, start: s1, end: s2 });
      });
      if (!regs.length) return;

      setqueryTorefLoading(true);
      setqueryTorefError(null);
      try {
        const res = await bioapiClient.liftoverBlast({
          src_db: queryDbPath,
          dst_db: refDbPath,
          regions: regs,
          task: "megablast",
          evalue: 1e-20,
          max_target_seqs: 5,
          max_hsps: 1,
          num_threads: blastNumThreads ?? undefined,
          max_len: 50_000,
          padding_bp: 0,
        });
        if (cancelled) return;
        setqueryTorefResults((prev) => {
          const next = { ...prev };
          (res.results ?? []).forEach((r) => {
            const key = liftoverKey(queryDbPath, r.src_entry, r.src_start, r.src_end);
            next[key] = r;
          });
          return next;
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "query→ref 変換（BLAST）に失敗しました。";
        setqueryTorefError(msg);
      } finally {
        if (!cancelled) setqueryTorefLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    blastNumThreads,
    localDbOptions,
    localResult,
    refDbPath,
    queryDbPath,
    queryTorefLoading,
    queryTorefResults,
    wantsqueryTorefView,
  ]);

  const ncbiSortedHits = useMemo(() => {
    if (!ncbiResult?.hits?.length) return [];
    return ncbiResult.hits
      .slice()
      .sort((a, b) => (a.evalue ?? 1) - (b.evalue ?? 1) || (b.pident ?? 0) - (a.pident ?? 0))
      .map((h, idx) => ({ ...h, _idx: idx }))
      .slice(0, MAX_DISPLAY_HITS);
  }, [ncbiResult]);

  const buildMarkdownReport = (): string => {
    if (!normalizedQuery) return "";
    if (!localResult && !ncbiResult && !ensemblResult) return "";
    const dt = new Date();
    const lines: string[] = [];
    lines.push("# BLAST 解析レポート");
    lines.push("");
    lines.push(`- 作成時刻: ${dt.toLocaleString()}`);
    lines.push(`- クエリ配列長: ${normalizedQuery.length} bp`);
    lines.push(
      `- 実行先: local=${useLocal ? "ON" : "OFF"}, NCBI=${useNcbi ? "ON" : "OFF"}, Ensembl=${useEnsembl ? "ON" : "OFF"}`,
    );
    if (useLocal) {
      lines.push(
        `- ローカル DB: ${localDbViews.length ? localDbViews.map((v) => v.label).join(", ") : "(未選択)"
        }`,
      );
      lines.push("- ローカル mode: CPU（通常）");
    }
    if (useNcbi) {
      lines.push(
        `- NCBI: db=\`${ncbiDb}\`, ENTREZ query=\`${ncbiQuery}\``,
      );
    }
    if (useEnsembl) {
      lines.push(`- Ensembl species: \`${ensemblSpecies}\``);
    }
    lines.push(
      `- パラメータ: task=\`${blastTask}\`, evalue=\`${blastEvalue}\`, max_target_seqs=\`${maxHits}\``,
    );
    lines.push("");

    const allHits: BlastHit[] = [
      ...(localResult?.hits ?? []),
      ...(ncbiResult?.hits ?? []),
      ...(ensemblResult?.hits ?? []),
    ];
    if (allHits.length) {
      lines.push("## ヒット一覧（主要スコア順, 最大 50 件）");
      lines.push("");
      lines.push(
        "| # | source | ヒット ID | %id | 長さ | E-value | query 範囲 |",
      );
      lines.push("| ---: | --- | --- | ---: | ---: | ---: | --- |");
      compactHits.forEach((h, idx) => {
        lines.push(
          `| ${idx + 1} | ${h.source} | \`${h.id}\` | ${h.pident.toFixed(
            1,
          )} | ${h.length} | ${h.evalue.toExponential(
            2,
          )} | ${h.qrange} |`,
        );
      });
      lines.push("");
    }

    lines.push("## クエリ配列");
    lines.push("");
    lines.push("```");
    lines.push(normalizedQuery);
    lines.push("```");
    lines.push("");

    return lines.join("\n");
  };

  const handleRunBlast = async () => {
    const trimmed = sequence.trim();
    const normalized = trimmed.replace(/\s+/g, "").toUpperCase();
    if (!normalized) {
      setError("クエリとなる配列を入力してください。");
      return;
    }
    if (!useLocal && !useNcbi && !useEnsembl) {
      setError("少なくとも 1 つは実行先を選んでください。");
      return;
    }

    if (useLocal && localDbPathsToQuery.length === 0) {
      setError("ローカル BLAST+ を使う場合、データベースを 1 つ以上選択してください。");
      return;
    }

    setLoading(true);
    setError(null);
    setLocalResult(null);
    setLocalResultsByDb({});
    setNcbiResult(null);
    setEnsemblResult(null);
    setLocalJobId(null);
    setLocalJobInfo(null);
    setResultTab("local");
    setNormalizedQuery(normalized);
    setqueryTorefResults({});
    setqueryTorefError(null);
    setEnsemblExportBusyKey(null);
    setEnsemblExportError(null);

    const presetTargets: NCBITarget[] = useArabidopsis
      ? DEFAULT_NCBI_TARGETS.map((target) => ({ ...target, database: ncbiDb }))
      : [];
    const ncbiTargets: NCBITarget[] | undefined = useNcbiPresetTargets
      ? presetTargets
      : undefined;

    try {
      if (useLocal) {
        const job = await bioapiClient.createBlastBatchLocalJob({
          sequences: [normalized],
          dbs: localDbPathsToQuery,
          local_mode: "cpu",
          task: blastTask,
          evalue: blastEvalue,
          max_target_seqs: maxHits,
          max_hsps: blastMaxHsps ?? undefined,
          num_threads: blastNumThreads ?? undefined,
          max_parallel_dbs: blastMaxParallelDbs ?? undefined,
          engine: blastEngine,
        });
        setLocalJobId(job.job_id);

        const info = await pollJobUntilDone(job.job_id, {
          onUpdate: (i) => setLocalJobInfo(i),
          intervalMs: 900,
        });
        if (info.status !== "succeeded") {
          throw new Error(info.error ?? "ローカル BLAST ジョブに失敗しました。");
        }
        const batch = await bioapiClient.getJobResult<{ results: BlastResponse[] }>(job.job_id);
        const merged = batch.results?.[0] ?? { num_hits: 0, hits: [] };
        const hits = relabelLocalBlastHits(merged.hits ?? [], localDbPathsToQuery, localDbOptions);
        const perDb: Record<string, BlastResponse> = {};
        hits.forEach((hit) => {
          const src = hit.source ?? "local";
          const tag = src.startsWith("local:") ? src.slice("local:".length) : src;
          if (!perDb[tag]) perDb[tag] = { num_hits: 0, hits: [] };
          perDb[tag].hits.push(hit);
          perDb[tag].num_hits += 1;
        });
        if (wantsqueryTorefView) {
          const queryLabel = labelForDbPath(queryDbPath, localDbOptions);
          const base = perDb[queryLabel];
          if (base && base.hits.length > 0) {
            const converted = base.hits.map((h) => ({
              ...h,
              source: `local:${query_TO_ref_VIRTUAL_DB_LABEL}`,
            }));
            perDb[query_TO_ref_VIRTUAL_DB_LABEL] = { num_hits: converted.length, hits: converted };
          }
        }

        const requestedLabels = new Set(localDbViews.map((v) => v.label));
        const filteredPerDb: Record<string, BlastResponse> = {};
        Object.entries(perDb).forEach(([tag, res]) => {
          if (requestedLabels.has(tag)) filteredPerDb[tag] = res;
        });

        Object.values(filteredPerDb).forEach((r) =>
          r.hits.sort((a, b) => (b.bitscore ?? 0) - (a.bitscore ?? 0)),
        );
        setLocalResultsByDb(filteredPerDb);
        setLocalResult({ num_hits: hits.length, hits });
        setLocalJobId(null);
      } else {
        setLocalResult(null);
        setLocalResultsByDb({});
      }

      if (useNcbi) {
        const ncbiProgram = blastTask === "blastp" ? "blastp" : "blastn";
        const resNcbi = await bioapiClient.runBlastMulti({
          sequence: normalized,
          db: localDbPathsToQuery[0] ?? "",
          max_target_seqs: maxHits,
          task: ncbiProgram,
          evalue: blastEvalue,
          max_hsps: blastMaxHsps ?? undefined,
          num_threads: blastNumThreads ?? undefined,
          engine: blastEngine,
          backends: ["ncbi"],
          ncbi_database: ncbiDb,
          ncbi_entrez_query: useNcbiPresetTargets ? undefined : ncbiQuery.trim() || undefined,
          ncbi_targets: ncbiTargets,
        });
        setNcbiResult({
          ...resNcbi,
          hits: (resNcbi.hits ?? []).map((h) => ({ ...h, source: h.source || "ncbi" })),
        });
        if (!useNcbiPresetTargets && ncbiQuery.trim()) {
          rememberNcbiQuery(ncbiQuery);
        }
      } else {
        setNcbiResult(null);
      }

      if (useEnsembl) {
        const ensemblProgram = blastTask === "blastp" ? "blastp" : "blastn";
        const resEnsembl = await bioapiClient.runBlastMulti({
          sequence: normalized,
          db: localDbPathsToQuery[0] ?? "",
          max_target_seqs: maxHits,
          task: ensemblProgram,
          evalue: blastEvalue,
          max_hsps: blastMaxHsps ?? undefined,
          num_threads: blastNumThreads ?? undefined,
          engine: blastEngine,
          backends: ["ensembl"],
          ensembl_species: ensemblSpecies.trim() || "homo_sapiens",
        });
        setEnsemblResult({
          ...resEnsembl,
          hits: (resEnsembl.hits ?? []).map((h) => ({ ...h, source: h.source || "ensembl" })),
        });
      } else {
        setEnsemblResult(null);
      }
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "BLAST 実行中に思わぬエラーが起きました。";
      setError(msg);
    } finally {
      setLoading(false);
      setLocalJobId(null);
    }
  };

  const downloadEnsemblExportFasta = async (opts: {
    speciesPath: string;
    transcriptId: string;
    geneId?: string | null;
    region?: string | null;
    fileBase?: string;
  }) => {
    const speciesPath = (opts.speciesPath || "").trim();
    const transcriptId = (opts.transcriptId || "").trim();
    if (!speciesPath || !transcriptId) return;

    const busyKey = `${speciesPath}|${transcriptId}`;
    if (ensemblExportBusyKey === busyKey) return;
    setEnsemblExportBusyKey(busyKey);
    setEnsemblExportError(null);
    try {
      const fasta = await bioapiClient.fetchEnsemblTranscriptExportFasta({
        species_path: speciesPath,
        transcript_id: transcriptId,
        gene_id: opts.geneId?.trim() || undefined,
        region: opts.region?.trim() || undefined,
      });
      downloadFasta(fasta, opts.fileBase || `ensembl_${transcriptId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "外部 FASTA 取得に失敗しました。";
      setEnsemblExportError(msg);
    } finally {
      setEnsemblExportBusyKey(null);
    }
  };

  const copyLocalHitSequence = async (params: {
    db: string;
    entry: string;
    start: number;
    end: number;
    strand: "plus" | "minus";
  }) => {
    const db = (params.db || "").trim();
    const entry = (params.entry || "").trim();
    if (!db || !entry) return;
    const s = Math.min(params.start, params.end);
    const e = Math.max(params.start, params.end);
    const key = `${db}|${entry}|${s}|${e}|${params.strand}`;
    if (copyBusyKey === key) return;
    setCopyBusyKey(key);
    try {
      const res = await bioapiClient.fetchLocalDbSequence({
        db,
        entry,
        start: s,
        end: e,
        strand: params.strand,
      });
      const header = `${entry}:${s}-${e} (${params.strand})`;
      const fasta = toFasta(header, res.sequence);
      await navigator.clipboard.writeText(fasta.trim());
      showToast("subject 配列（FASTA）をコピーしました", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "配列コピーに失敗しました。";
      showToast(msg, "error");
    } finally {
      setCopyBusyKey(null);
    }
  };

  const sendHitToGenomeSlice = (params: {
    db: string;
    entry: string;
    start: number;
    end: number;
    strand: "plus" | "minus";
  }) => {
    const db = (params.db || "").trim();
    const entry = (params.entry || "").trim();
    if (!db || !entry) return;
    setPresetGenomeSlice?.({
      db,
      entry,
      start: Math.min(params.start, params.end),
      end: Math.max(params.start, params.end),
      strand: params.strand,
      label: entry,
    });
    setActiveTab?.("genome_slice");
  };

  const truncateText = (text: string, max = 60) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

  const qualityLabel = (hit: BlastHit): { text: string; className: string } => {
    for (const g of QUALITY_GRADES) {
      if (hit.pident >= g.pident && hit.length >= g.length && hit.evalue <= g.evalue) {
        return { text: g.label, className: g.className };
      }
    }
    return { text: "D", className: "quality-badge grade-d" };
  };

  const formatSubjectRange = (hit: BlastHit) => {
    const { chr } = splitIdAndDesc(hit.sseqid);
    const chrom = hit.subject_chrom || chr || hit.sseqid || "-";
    if (hit.sstart == null || hit.send == null) return chrom;
    const forward = hit.sstart <= hit.send;
    const left = forward ? hit.sstart : hit.send;
    const right = forward ? hit.send : hit.sstart;
    const arrow = forward ? "→" : "←";
    const strand = forward ? "(+)" : "(-)";
    return `${chrom}:${left.toLocaleString()}${arrow}${right.toLocaleString()} ${strand}`;
  };

  const formatMappedrefRange = (dst: NonNullable<BlastLiftoverResult["dst"]>) => {
    const chromLabel =
      dst.subject_chrom && dst.entry && dst.subject_chrom !== dst.entry
        ? `${dst.subject_chrom} (${dst.entry})`
        : dst.subject_chrom || dst.entry;
    const isMinus = dst.strand === "minus";
    const left = isMinus ? dst.end : dst.start;
    const right = isMinus ? dst.start : dst.end;
    const arrow = isMinus ? "←" : "→";
    const strand = isMinus ? "(-)" : "(+)";
    return `${chromLabel}:${left.toLocaleString()}${arrow}${right.toLocaleString()} ${strand}`;
  };

  const formatMappedrefRangeFromXlsx = (m: queryrefBestGeneMapping) => {
    const strandRaw = (m.v1Strand || "").trim();
    const isMinus = strandRaw === "-" || /minus/i.test(strandRaw);
    const left = isMinus ? m.v1End : m.v1Start;
    const right = isMinus ? m.v1Start : m.v1End;
    const arrow = isMinus ? "←" : "→";
    const strand = isMinus ? "(-)" : "(+)";
    return `${m.v1Chr}:${left.toLocaleString()}${arrow}${right.toLocaleString()} ${strand}`;
  };

  const renderHitRow = (hit: BlastHit, index: number) => {
    const { id, desc, chr } = splitIdAndDesc(hit.sseqid);
    const displayChr = hit.subject_chrom ?? chr ?? "-";
    const allGenes = [
      ...(hit.gene_ids ?? []),
      ...(hit.gene_names ?? []),
    ].filter(Boolean);
    const uniqGenes = Array.from(new Set(allGenes));
    const queryGeneCandidates = uniqGenes.filter((g) => /^GENE\\.reference\\.query\\./i.test(g));
    const queryGene = queryGeneCandidates[0] ?? null;
    const sourceLabel = (hit.source || "").startsWith("local:")
      ? (hit.source || "").slice("local:".length)
      : null;
    const isConvertedView = sourceLabel === query_TO_ref_VIRTUAL_DB_LABEL;
    const isLocalquery = !!sourceLabel && /query/i.test(sourceLabel);
    const srcDbPath = sourceLabel ? localDbLabelToPath.get(sourceLabel) : null;
    const hitS1 = Math.min(hit.sstart, hit.send);
    const hitS2 = Math.max(hit.sstart, hit.send);
    const liftover =
      wantsqueryTorefView && isLocalquery && srcDbPath
        ? queryTorefResults[liftoverKey(srcDbPath, id, hitS1, hitS2)]
        : null;
    const dst = liftover?.dst ?? null;
    const dstGenes = [
      ...(dst?.gene_names ?? []),
      ...(dst?.gene_ids ?? []),
    ].filter(Boolean);
    const dstGene = dstGenes[0] ?? null;
    const xlsxMapping =
      wantsqueryTorefView && queryGene && queryTorefXlsxMap ? queryTorefXlsxMap.get(normalizequeryrefGeneId(queryGene)) : null;
    const xlsxV1Gene = xlsxMapping?.v1Gene ?? null;

    const kiwGenes = uniqGenes.filter((g) => /^GENEALT[0-9A-Za-z_]+/.test(g));
    const geneGenes = uniqGenes.filter((g) => /^GENE[0-9A-Za-z]+/i.test(g));
    const genes =
      kiwGenes.length > 0
        ? kiwGenes
        : geneGenes.length > 0
          ? geneGenes
          : uniqGenes;
    // 説明欄は遺伝子注釈を優先し、なければ defline を短くして表示
    const descText = genes.length > 0 ? genes.join(", ") : "-";
    const displayDesc = descText ? truncateText(descText, 90) : "-";
    const quality = qualityLabel(hit);

    const locDbLabel = getDbLabelForSource(hit.source);
    const locIsLocal = isLocalOnlyDb(locDbLabel);
    const locLinkText = locIsLocal ? "Navigator" : "External";

    const species = inferEnsemblPlantsSpecies({ geneId: genes[0] ?? null, dbLabel: hit.source ?? null });
    const locUrl = locIsLocal
      ? navigatorLocationUrl({
        dbLabel: locDbLabel,
        chrom: displayChr !== "-" ? displayChr : id,
        start: hit.sstart,
        end: hit.send,
      })
      : ensemblLocationUrl({
        species,
        chrom: displayChr !== "-" ? displayChr : id,
        start: hit.sstart,
        end: hit.send,
      });

    const txGeneId = genes[0] ?? null;
    const txGeneName =
      txGeneId && /^GENEALT[0-9A-Za-z_]+/.test(txGeneId) ? (geneGenes[0] ?? null) : null;
    const transcriptId = inferEnsemblTranscriptId({ geneId: txGeneId, geneName: txGeneName });
    const txSummaryUrl =
      transcriptId && txGeneId
        ? ensemblTranscriptSummaryUrl({
          species,
          geneId: txGeneId,
          transcriptId,
          chrom: id,
          start: hitS1,
          end: hitS2,
        })
        : null;
    const txExportUrl =
      transcriptId && txGeneId
        ? ensemblTranscriptExportUrl({
          species,
          geneId: txGeneId,
          transcriptId,
          chrom: id,
          start: hitS1,
          end: hitS2,
        })
        : null;

    const locUrlref = dst
      ? ensemblLocationUrl({
        species:
          inferEnsemblPlantsSpecies({ geneId: dstGene, dbLabel: "UserDB_ref" }) ||
          inferEnsemblPlantsSpecies({ geneId: genes[0] ?? null, dbLabel: "UserDB_ref" }) ||
          "",
        chrom: dst.entry || dst.subject_chrom,
        start: dst.start,
        end: dst.end,
      })
      : null;
    const dstTranscriptId = dstGene ? inferEnsemblTranscriptId({ geneId: dstGene }) : null;
    const dstTxSummaryUrl =
      dst && dstGene && dstTranscriptId
        ? ensemblTranscriptSummaryUrl({
          species:
            inferEnsemblPlantsSpecies({ geneId: dstGene, dbLabel: "UserDB_ref" }) ||
            inferEnsemblPlantsSpecies({ geneId: txGeneId, dbLabel: "UserDB_ref" }) ||
            "",
          geneId: dstGene,
          transcriptId: dstTranscriptId,
          chrom: dst.entry || dst.subject_chrom,
          start: dst.start,
          end: dst.end,
        })
        : null;
    const dstTxExportUrl =
      dst && dstGene && dstTranscriptId
        ? ensemblTranscriptExportUrl({
          species:
            inferEnsemblPlantsSpecies({ geneId: dstGene, dbLabel: "UserDB_ref" }) ||
            inferEnsemblPlantsSpecies({ geneId: txGeneId, dbLabel: "UserDB_ref" }) ||
            "",
          geneId: dstGene,
          transcriptId: dstTranscriptId,
          chrom: dst.entry || dst.subject_chrom,
          start: dst.start,
          end: dst.end,
        })
        : null;

    const xlsxLocUrlref = xlsxMapping
      ? ensemblLocationUrl({
        species:
          inferEnsemblPlantsSpecies({ geneId: xlsxV1Gene, dbLabel: "UserDB_ref" }) ||
          inferEnsemblPlantsSpecies({ geneId: genes[0] ?? null, dbLabel: "UserDB_ref" }) ||
          "",
        chrom: xlsxMapping.v1Chr,
        start: xlsxMapping.v1Start,
        end: xlsxMapping.v1End,
      })
      : null;
    const xlsxTranscriptId = xlsxV1Gene ? inferEnsemblTranscriptId({ geneId: xlsxV1Gene }) : null;
    const xlsxTxSummaryUrl =
      xlsxMapping && xlsxV1Gene && xlsxTranscriptId
        ? ensemblTranscriptSummaryUrl({
          species:
            inferEnsemblPlantsSpecies({ geneId: xlsxV1Gene, dbLabel: "UserDB_ref" }) ||
            inferEnsemblPlantsSpecies({ geneId: txGeneId, dbLabel: "UserDB_ref" }) ||
            "",
          geneId: xlsxV1Gene,
          transcriptId: xlsxTranscriptId,
          chrom: xlsxMapping.v1Chr,
          start: xlsxMapping.v1Start,
          end: xlsxMapping.v1End,
        })
        : null;
    const xlsxTxExportUrl =
      xlsxMapping && xlsxV1Gene && xlsxTranscriptId
        ? ensemblTranscriptExportUrl({
          species:
            inferEnsemblPlantsSpecies({ geneId: xlsxV1Gene, dbLabel: "UserDB_ref" }) ||
            inferEnsemblPlantsSpecies({ geneId: txGeneId, dbLabel: "UserDB_ref" }) ||
            "",
          geneId: xlsxV1Gene,
          transcriptId: xlsxTranscriptId,
          chrom: xlsxMapping.v1Chr,
          start: xlsxMapping.v1Start,
          end: xlsxMapping.v1End,
        })
        : null;
    const txRegion = id && hitS1 && hitS2 ? `${id}:${hitS1}-${hitS2}` : null;
    const dstRegion =
      dst && (dst.entry || dst.subject_chrom) ? `${dst.entry || dst.subject_chrom}:${dst.start}-${dst.end}` : null;
    const xlsxRegion = xlsxMapping ? `${xlsxMapping.v1Chr}:${xlsxMapping.v1Start}-${xlsxMapping.v1End}` : null;
    const localStrand: "plus" | "minus" = hit.sstart <= hit.send ? "plus" : "minus";
    const canFetchLocalSeq = !!srcDbPath && id !== "-" && Number.isFinite(hitS1) && Number.isFinite(hitS2);
    const localCopyKey = canFetchLocalSeq ? `${srcDbPath}|${id}|${hitS1}|${hitS2}|${localStrand}` : null;
    const localCopyBusy = !!localCopyKey && copyBusyKey === localCopyKey;
    return (
      <tr key={`${hit.qseqid}-${hit.sseqid}-${index}`}>
        <td>{index + 1}</td>
        <td>
          <span className="blast-id">{id}</span>
          {hit.source && (
            <span className="blast-source-tag">{hit.source}</span>
          )}
        </td>
        <td
          className="blast-desc"
          title={(() => {
            if (dst) {
              const lines = [
                `query: ${queryGene || "(unknown)"}`,
                `ref(BLAST): ${dstGene || "(unknown)"} (${formatMappedrefRange(dst)})`,
              ];
              if (xlsxMapping) {
                lines.push(
                  `ref(Excel): ${xlsxV1Gene || "(unknown)"} (${formatMappedrefRangeFromXlsx(xlsxMapping)}) conf=${xlsxMapping.confidence}${xlsxMapping.ambiguous ? ", ambiguous" : ""
                  }`,
                );
              }
              return lines.join("\n");
            }
            if (xlsxMapping) {
              return `query: ${queryGene || "(unknown)"}\nref(Excel): ${xlsxV1Gene || "(unknown)"} (${formatMappedrefRangeFromXlsx(xlsxMapping)}) conf=${xlsxMapping.confidence}${xlsxMapping.ambiguous ? ", ambiguous" : ""
                }`;
            }
            return genes.join(", ") || "";
          })()}
          style={{ whiteSpace: "normal" }}
        >
          {(() => {
            if (dst) {
              const g = dstGene;
              // dst (Destination) is typically ref/Ensembl, so we keep ensemblGeneUrl unless we map to something else.
              // Logic: dst usually implies liftover to ref.
              const url = g ? ensemblGeneUrl(g) : null;
              const label = truncateText(g || "(ref)", 18);
              return (
                <>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    <span>{label}</span>
                  )}
                  {queryGene ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      query: {truncateText(queryGene, 24)}
                    </div>
                  ) : null}
                  {xlsxMapping && xlsxV1Gene && xlsxV1Gene !== dstGene ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      excel: {truncateText(xlsxV1Gene, 24)}（{xlsxMapping.confidence}
                      {xlsxMapping.ambiguous ? ", ambiguous" : ""}）
                    </div>
                  ) : null}
                  {dstTxSummaryUrl || dstTxExportUrl ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      {dstTxSummaryUrl ? (
                        <a href={dstTxSummaryUrl} target="_blank" rel="noreferrer">
                          Transcript
                        </a>
                      ) : null}
                      {dstTxSummaryUrl && dstTxExportUrl ? " / " : null}
                      {dstTxExportUrl ? (
                        <a href={dstTxExportUrl} target="_blank" rel="noreferrer">
                          配列取得(FASTA)
                        </a>
                      ) : null}
                      {dstTxExportUrl ? (
                        <>
                          {" "}
                          (
                          <button
                            type="button"
                            className="link-button"
                            disabled={
                              ensemblExportBusyKey ===
                              `${(inferEnsemblPlantsSpecies({ geneId: dstGene, dbLabel: "UserDB_ref" }) || "").trim()}|${dstTranscriptId}`
                            }
                            onClick={() => {
                              const sp =
                                inferEnsemblPlantsSpecies({ geneId: dstGene, dbLabel: "UserDB_ref" }) ||
                                "";
                              void downloadEnsemblExportFasta({
                                speciesPath: sp,
                                transcriptId: dstTranscriptId || "",
                                geneId: dstGene,
                                region: dstRegion,
                                fileBase: `ensembl_${dstGene}_${dstTranscriptId || "tx"}`,
                              });
                            }}
                          >
                            APIで保存
                          </button>
                          )
                        </>
                      ) : null}
                      {dstTxSummaryUrl && dstTxExportUrl ? (
                        <>
                          {" "}
                          (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              window.open(dstTxSummaryUrl, "_blank", "noopener,noreferrer");
                              window.open(dstTxExportUrl, "_blank", "noopener,noreferrer");
                            }}
                          >
                            両方
                          </button>
                          )
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {liftover?.note ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      注意: {liftover.note}
                    </div>
                  ) : null}
                  {liftover?.error ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      変換失敗: {truncateText(liftover.error, 60)}
                    </div>
                  ) : null}
                </>
              );
            }

            if (xlsxMapping) {
              const g = xlsxV1Gene;
              // Excel mapping is specifically to the configured reference.
              const url = g ? ensemblGeneUrl(g) : null;
              const label = truncateText(g || "(ref)", 18);
              const locusText = formatMappedrefRangeFromXlsx(xlsxMapping);
              return (
                <>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    <span>{label}</span>
                  )}
                  <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                    excel: {locusText}（{xlsxMapping.confidence}
                    {xlsxMapping.ambiguous ? ", ambiguous" : ""}）
                  </div>
                  {queryGene ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      query: {truncateText(queryGene, 24)}
                    </div>
                  ) : null}
                  {xlsxTxSummaryUrl || xlsxTxExportUrl ? (
                    <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                      {xlsxTxSummaryUrl ? (
                        <a href={xlsxTxSummaryUrl} target="_blank" rel="noreferrer">
                          Transcript
                        </a>
                      ) : null}
                      {xlsxTxSummaryUrl && xlsxTxExportUrl ? " / " : null}
                      {xlsxTxExportUrl ? (
                        <a href={xlsxTxExportUrl} target="_blank" rel="noreferrer">
                          配列取得(FASTA)
                        </a>
                      ) : null}
                      {xlsxTxExportUrl && xlsxTranscriptId ? (
                        <>
                          {" "}
                          (
                          <button
                            type="button"
                            className="link-button"
                            disabled={
                              ensemblExportBusyKey ===
                              `${(inferEnsemblPlantsSpecies({ geneId: xlsxV1Gene, dbLabel: "UserDB_ref" }) || "").trim()}|${xlsxTranscriptId}`
                            }
                            onClick={() => {
                              const sp =
                                inferEnsemblPlantsSpecies({ geneId: xlsxV1Gene, dbLabel: "UserDB_ref" }) ||
                                "";
                              void downloadEnsemblExportFasta({
                                speciesPath: sp,
                                transcriptId: xlsxTranscriptId,
                                geneId: xlsxV1Gene,
                                region: xlsxRegion,
                                fileBase: `ensembl_${xlsxV1Gene}_${xlsxTranscriptId}`,
                              });
                            }}
                          >
                            APIで保存
                          </button>
                          )
                        </>
                      ) : null}
                      {xlsxTxSummaryUrl && xlsxTxExportUrl ? (
                        <>
                          {" "}
                          (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              window.open(xlsxTxSummaryUrl, "_blank", "noopener,noreferrer");
                              window.open(xlsxTxExportUrl, "_blank", "noopener,noreferrer");
                            }}
                          >
                            両方
                          </button>
                          )
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </>
              );
            }

            if (!genes.length) return "-";
            const g = genes[0];
            const extra = genes.length - 1;

            const dbLabel = getDbLabelForSource(hit.source);
            const isLocal = isLocalOnlyDb(dbLabel);
            const url = isLocal ? navigatorGeneUrl({ geneId: g, dbLabel }) : ensemblGeneUrl(g);

            const baseLabel = extra > 0 ? `${g} (+${extra})` : g;
            const label = truncateText(baseLabel, 18);
            return url ? (
              <>
                <a href={url} target="_blank" rel="noreferrer">
                  {label}
                </a>
                {txSummaryUrl || txExportUrl ? (
                  <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                    {txSummaryUrl ? (
                      <a href={txSummaryUrl} target="_blank" rel="noreferrer">
                        Transcript
                      </a>
                    ) : null}
                    {txSummaryUrl && txExportUrl ? " / " : null}
                    {txExportUrl ? (
                      <a href={txExportUrl} target="_blank" rel="noreferrer">
                        配列取得(FASTA)
                      </a>
                    ) : null}
                    {txExportUrl && species && transcriptId ? (
                      <>
                        {" "}
                        (
                        <button
                          type="button"
                          className="link-button"
                          disabled={ensemblExportBusyKey === `${species}|${transcriptId}`}
                          onClick={() => {
                            void downloadEnsemblExportFasta({
                              speciesPath: species,
                              transcriptId,
                              geneId: txGeneId,
                              region: txRegion,
                              fileBase: `ensembl_${txGeneId}_${transcriptId}`,
                            });
                          }}
                        >
                          APIで保存
                        </button>
                        )
                      </>
                    ) : null}
                    {txSummaryUrl && txExportUrl ? (
                      <>
                        {" "}
                        (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            window.open(txSummaryUrl, "_blank", "noopener,noreferrer");
                            window.open(txExportUrl, "_blank", "noopener,noreferrer");
                          }}
                        >
                          両方
                        </button>
                        )
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <span>{label}</span>
                {txSummaryUrl || txExportUrl ? (
                  <div className="seq-hint" style={{ fontSize: "0.78rem" }}>
                    {txSummaryUrl ? (
                      <a href={txSummaryUrl} target="_blank" rel="noreferrer">
                        Transcript
                      </a>
                    ) : null}
                    {txSummaryUrl && txExportUrl ? " / " : null}
                    {txExportUrl ? (
                      <a href={txExportUrl} target="_blank" rel="noreferrer">
                        配列取得(FASTA)
                      </a>
                    ) : null}
                    {txExportUrl && species && transcriptId ? (
                      <>
                        {" "}
                        (
                        <button
                          type="button"
                          className="link-button"
                          disabled={ensemblExportBusyKey === `${species}|${transcriptId}`}
                          onClick={() => {
                            void downloadEnsemblExportFasta({
                              speciesPath: species,
                              transcriptId,
                              geneId: txGeneId,
                              region: txRegion,
                              fileBase: `ensembl_${txGeneId}_${transcriptId}`,
                            });
                          }}
                        >
                          APIで保存
                        </button>
                        )
                      </>
                    ) : null}
                    {txSummaryUrl && txExportUrl ? (
                      <>
                        {" "}
                        (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            window.open(txSummaryUrl, "_blank", "noopener,noreferrer");
                            window.open(txExportUrl, "_blank", "noopener,noreferrer");
                          }}
                        >
                          両方
                        </button>
                        )
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            );
          })()}
        </td>
        <td>{hit.pident.toFixed(1)}</td>
        <td>
          {isConvertedView ? (
            <>
              {dst ? (
                <>
                  {formatMappedrefRange(dst)}
                  {locUrlref ? (
                    <>
                      {" "}
                      (
                      <a href={locUrlref} target="_blank" rel="noreferrer">
                        Ensembl
                      </a>
                      )
                    </>
                  ) : null}
                  <div className="seq-hint" style={{ marginTop: "0.15rem" }}>
                    query: {formatSubjectRange(hit)}
                    {locUrl ? (
                      <>
                        {" "}
                        (
                        <a href={locUrl} target="_blank" rel="noreferrer">
                          {locLinkText}
                        </a>
                        )
                      </>
                    ) : null}
                  </div>
                </>
              ) : xlsxMapping ? (
                <>
                  excel: {formatMappedrefRangeFromXlsx(xlsxMapping)}
                  {xlsxLocUrlref ? (
                    <>
                      {" "}
                      (
                      <a href={xlsxLocUrlref} target="_blank" rel="noreferrer">
                        Ensembl
                      </a>
                      )
                    </>
                  ) : null}
                  <div className="seq-hint" style={{ marginTop: "0.15rem" }}>
                    query: {formatSubjectRange(hit)}
                    {locUrl ? (
                      <>
                        {" "}
                        (
                        <a href={locUrl} target="_blank" rel="noreferrer">
                          Ensembl
                        </a>
                        )
                      </>
                    ) : null}
                  </div>
                  <div className="seq-hint" style={{ marginTop: "0.15rem" }}>
                    BLAST:{" "}
                    {queryTorefLoading
                      ? "変換中..."
                      : liftover?.error
                        ? `変換失敗: ${truncateText(liftover.error, 60)}`
                        : "未変換"}
                  </div>
                </>
              ) : (
                <>
                  {formatSubjectRange(hit)}
                  {locUrl ? (
                    <>
                      {" "}
                      (
                      <a href={locUrl} target="_blank" rel="noreferrer">
                        Ensembl
                      </a>
                      )
                    </>
                  ) : null}
                  <div className="seq-hint" style={{ marginTop: "0.15rem" }}>
                    ref:{" "}
                    {queryTorefLoading
                      ? "変換中..."
                      : liftover?.error
                        ? `変換失敗: ${truncateText(liftover.error, 60)}`
                        : "未変換"}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {formatSubjectRange(hit)}
              {locUrl && !dst ? (
                <>
                  {" "}
                  (
                  <a href={locUrl} target="_blank" rel="noreferrer">
                    Ensembl
                  </a>
                  )
                </>
              ) : null}
              {xlsxMapping && !dst ? (
                <div className="seq-hint" style={{ marginTop: "0.15rem" }}>
                  ref(excel): {formatMappedrefRangeFromXlsx(xlsxMapping)}
                  {xlsxLocUrlref ? (
                    <>
                      {" "}
                      (
                      <a href={xlsxLocUrlref} target="_blank" rel="noreferrer">
                        Ensembl
                      </a>
                      )
                    </>
                  ) : null}
                </div>
              ) : null}
              {dst ? (
                <div className="seq-hint" style={{ marginTop: "0.15rem" }}>
                  ref: {formatMappedrefRange(dst)}
                  {locUrlref ? (
                    <>
                      {" "}
                      (
                      <a href={locUrlref} target="_blank" rel="noreferrer">
                        Ensembl
                      </a>
                      )
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          <details className="blast-details">
            <summary>詳細</summary>
            <div className="blast-detail-row">alignment length: {hit.length}</div>
            <div className="blast-detail-row">E-value: {hit.evalue.toExponential(2)}</div>
            <div className="blast-detail-row">bit score: {hit.bitscore.toFixed(1)}</div>
            <div className="blast-detail-row">
              query range: {hit.qstart}–{hit.qend}
            </div>
            <div className="blast-detail-row">
              subject range: {hit.sstart}–{hit.send}
            </div>
            {canFetchLocalSeq ? (
              <div className="primer-row" style={{ justifyContent: "flex-start", marginTop: "0.25rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="seq-button secondary"
                  disabled={localCopyBusy}
                  onClick={() =>
                    void copyLocalHitSequence({
                      db: srcDbPath || "",
                      entry: id,
                      start: hitS1,
                      end: hitS2,
                      strand: localStrand,
                    })
                  }
                >
                  {localCopyBusy ? "コピー中..." : "subject配列コピー"}
                </button>
                <button
                  type="button"
                  className="seq-button secondary"
                  onClick={() =>
                    sendHitToGenomeSlice({
                      db: srcDbPath || "",
                      entry: id,
                      start: hitS1,
                      end: hitS2,
                      strand: localStrand,
                    })
                  }
                >
                  切り出しへ
                </button>
              </div>
            ) : null}
            {dst && (
              <div className="blast-detail-row">
                query→ref(BLAST): {formatMappedrefRange(dst)}{" "}
                / pident={dst.pident.toFixed(1)}% cov={dst.coverage.toFixed(2)}{" "}
                {liftover?.note ? `/ note=${liftover.note}` : ""}
              </div>
            )}
            {xlsxMapping && (
              <div className="blast-detail-row">
                query→ref(Excel): {formatMappedrefRangeFromXlsx(xlsxMapping)} / gene={xlsxV1Gene || "-"} / conf=
                {xlsxMapping.confidence}
                {xlsxMapping.ambiguous ? " (ambiguous)" : ""}
                {xlsxMapping.note ? ` / note=${xlsxMapping.note}` : ""}
              </div>
            )}
            {hit.mismatch != null && (
              <div className="blast-detail-row">mismatch: {hit.mismatch}</div>
            )}
            {hit.gapopen != null && (
              <div className="blast-detail-row">gapopen: {hit.gapopen}</div>
            )}
          </details>
        </td>
        <td>
          <span className={quality.className}>{quality.text}</span>
        </td>
      </tr>
    );
  };

  // buildMarkdownReport はこの下の定義を利用する

  return (
    <section className="seq-result-block">
      <h2 className="panel-title">BLAST 検索（local）</h2>
      <p className="panel-hint">
        ユーザーが用意した makeblastdb パスを選択または手動入力して、ローカル BLAST+ で検索します。
      </p>
      <div className="blast-grid">
        <div className="blast-controls">
          <label className="seq-label">
            クエリ配列（DNA）:
            <textarea
              className="seq-textarea"
              rows={5}
              placeholder="例: ATGCGT..."
              value={sequence}
              onChange={(e) => setSequence(e.target.value)}
            />
          </label>

          {useLocal && (
            <div className="seq-label">
              <div className="blast-backend-row checklist-grid">
                <span>ローカル DB（複数選択可）:</span>
                {localDbOptionsWithVirtual.map((opt) => (
                  <label key={opt.value}>
                    <input
                      type="checkbox"
                      checked={selectedLocalDbs.includes(opt.value)}
                      onChange={() => toggleLocalDb(opt.value)}
                    />{" "}
                    {opt.label}
                  </label>
                ))}
              </div>
              <div className="primer-row">
                <input
                  type="text"
                  className="seq-input"
                  placeholder="追加の makeblastdb prefix (任意)"
                  value={customLocalDb}
                  onChange={(e) => setCustomLocalDb(e.target.value)}
                />
              </div>
              <div className="primer-row" style={{ alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <span className="tag-label">ローカルモード</span>
                <span className="seq-hint">CPU（通常）</span>
              </div>
              <div className="tag-row">
                <span className="tag-label">選択中</span>
                <code className="tag-db">
                  {localDbViews.length ? localDbViews.map((v) => v.label).join(", ") : "-"}
                </code>
              </div>
              <span className="seq-hint">
                BLAST DB base: {DEFAULT_BLAST_DB_BASE} ／ num_threads:{" "}
                {blastNumThreads != null ? blastNumThreads : "自動 (CPU に応じて最大24、複数DBは自動で割り当て)"}
              </span>
              {wantsqueryTorefView ? (
                <span className="seq-hint">
                  {query_TO_ref_VIRTUAL_DB_LABEL} は UserDB_query のヒットを ref 座標へ BLAST で対応づけて表示する仮想DBです（検索自体は UserDB_query を使います）。
                </span>
              ) : null}
            </div>
          )}

          <details className="ui-details">
            <summary>詳細設定（BLAST パラメータ）</summary>
            <div className="ui-details-body">
              <div className="primer-row" style={{ alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span className="tag-label">プリセット</span>
                <button
                  type="button"
                  className="seq-button secondary"
                  onClick={() => applyBlastPreset("fast")}
                  disabled={loading}
                >
                  速度優先
                </button>
                <button
                  type="button"
                  className="seq-button secondary"
                  onClick={() => applyBlastPreset("balanced")}
                  disabled={loading}
                >
                  バランス
                </button>
                <button
                  type="button"
                  className="seq-button secondary"
                  onClick={() => applyBlastPreset("sensitive")}
                  disabled={loading}
                >
                  感度優先
                </button>
                <button
                  type="button"
                  className="seq-button secondary"
                  onClick={() => applyBlastPreset("primer")}
                  disabled={loading}
                >
                  短い配列
                </button>
              </div>
              <span className="seq-hint">
                目安: 同一種/近縁は megablast が最速。遠縁も拾いたいなら dc-megablast / blastn。プライマー（~50bp）は blastn-short。
              </span>

              <label className="seq-label">
                取得する最大ヒット数:
                <input
                  type="number"
                  className="seq-input"
                  min={1}
                  max={100}
                  value={maxHits}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMaxHits(Number.isNaN(v) ? 10 : v);
                  }}
                />
              </label>

              <div className="blast-backend-row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
                <label className="seq-label" style={{ maxWidth: "180px" }}>
                  task:
                  <select
                    className="seq-input"
                    value={blastTask}
                    onChange={(e) => setBlastTask(e.target.value)}
                    disabled={loading}
                  >
                    <option value="blastn">blastn</option>
                    <option value="dc-megablast">dc-megablast</option>
                    <option value="megablast">megablast</option>
                    <option value="blastn-short">blastn-short</option>
                  </select>
                </label>
                <label className="seq-label" style={{ maxWidth: "180px" }}>
                  E-value:
                  <input
                    type="number"
                    className="seq-input"
                    step="any"
                    value={blastEvalue}
                    onChange={(e) => setBlastEvalue(Number(e.target.value) || 1e-5)}
                    disabled={loading}
                  />
                </label>
                <label className="seq-label" style={{ maxWidth: "180px" }}>
                  max_hsps:
                  <input
                    type="number"
                    className="seq-input"
                    min={1}
                    value={blastMaxHsps ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setBlastMaxHsps(Number.isNaN(v) ? null : Math.max(1, v));
                    }}
                    placeholder="BLASTデフォルト"
                    disabled={loading}
                  />
                </label>
                <label className="seq-label" style={{ maxWidth: "200px" }}>
                  num_threads:
                  <input
                    type="number"
                    className="seq-input"
                    min={1}
                    value={blastNumThreads ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setBlastNumThreads(Number.isNaN(v) ? null : Math.max(1, v));
                    }}
                    placeholder="自動"
                    disabled={loading}
                  />
                  <span className="seq-hint">未指定なら CPU に応じて自動</span>
                </label>
                <label className="seq-label" style={{ maxWidth: "220px" }}>
                  max_parallel_dbs:
                  <input
                    type="number"
                    className="seq-input"
                    min={1}
                    max={16}
                    value={blastMaxParallelDbs ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setBlastMaxParallelDbs(Number.isNaN(v) ? null : Math.max(1, Math.min(16, v)));
                    }}
                    placeholder="自動（推奨=3）"
                    disabled={loading}
                  />
                  <span className="seq-hint">複数DBが遅いなら 2〜3（I/O競合を減らす）</span>
                </label>
              </div>

            </div>
          </details>

          <button
            type="button"
            className="seq-button"
            onClick={handleRunBlast}
            disabled={loading}
          >
            {loading ? "BLAST 実行中..." : "BLAST を実行する"}
          </button>

          {(localJobId || localJobInfo) && (
            <div style={{ marginTop: "0.6rem" }}>
              <JobProgressCard
                title="ローカル BLAST"
                jobId={localJobId}
                job={localJobInfo}
                onCancel={localJobId ? cancelLocalJob : null}
                cancelDisabled={!localJobId}
              />
            </div>
          )}

          {error && <p className="seq-error">エラー: {error}</p>}
        </div>

        <div className="blast-results">
          <div className="primer-row" style={{ marginBottom: "0.4rem", alignItems: "center" }}>
            {wantsqueryTorefView ? (
              <span className="seq-hint">
                {query_TO_ref_VIRTUAL_DB_LABEL}:{" "}
                {queryTorefLoading ? "BLAST変換中..." : queryTorefError ? "BLAST変換失敗" : "BLAST表示ON"}
                {needsqueryTorefXlsxMap
                  ? ` / Excel: ${queryTorefXlsxLoading ? "読込中..." : queryTorefXlsxError ? "読込失敗" : queryTorefXlsxMap ? "OK" : "未読込"
                  }`
                  : ""}
              </span>
            ) : null}
            <details className="ui-details" style={{ marginLeft: "auto" }}>
              <summary>エクスポート</summary>
              <div className="ui-details-body">
                <div className="primer-row">
                  <button
                    type="button"
                    className="seq-button secondary"
                    onClick={() => {
                      const md = buildMarkdownReport();
                      if (!md) return;
                      downloadMarkdown(md, "blast_report");
                    }}
                    disabled={
                      !normalizedQuery ||
                      (!localResult && !ncbiResult && !ensemblResult)
                    }
                  >
                    Markdown
                  </button>
                  <button
                    type="button"
                    className="seq-button secondary"
                    onClick={() => {
                      const md = buildMarkdownReport();
                      if (!md) return;
                      openPrintViewForMarkdown(md, "BLAST 解析レポート");
                    }}
                    disabled={
                      !normalizedQuery ||
                      (!localResult && !ncbiResult && !ensemblResult)
                    }
                  >
                    印刷（PDF）
                  </button>
                </div>
              </div>
            </details>
          </div>
          {queryTorefError && <p className="seq-error">エラー: {queryTorefError}</p>}
          {queryTorefXlsxError && <p className="seq-error">エラー: {queryTorefXlsxError}</p>}
          {ensemblExportError && <p className="seq-error">エラー: {ensemblExportError}</p>}
          <p className="blast-summary">
            クエリ長: {queryLength || "-"} bp ／ local:{" "}
            {localResult?.num_hits ?? 0}
            {useLocal ? ` (${localMode === "gpu" ? "GPU" : "CPU"})` : ""}
          </p>
          {(localResult?.hits?.length ||
            ncbiResult?.hits?.length ||
            ensemblResult?.hits?.length) &&
            queryLength > 0 && (
              <>
                {compactHits.length > 0 && (
                  <div className="table-scroll" style={{ marginBottom: "1rem" }}>
                    <table className="seq-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>source</th>
                          <th>ヒット ID</th>
                          <th>Genes (local)</th>
                          <th>% id</th>
                          <th>長さ</th>
                          <th>E-value</th>
                          <th>query 範囲</th>
                          <th>subject 範囲</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compactHits.map((h) => (
                          <tr key={`${h.source}-${h.idx}-${h.id}`}>
                            <td>{h.idx}</td>
                            <td>{h.source}</td>
                            <td>{h.id}</td>
                            <td className="blast-desc">{h.desc}</td>
                            <td>{h.pident.toFixed(1)}</td>
                            <td>{h.length}</td>
                            <td>{h.evalue.toExponential(2)}</td>
                            <td>{h.qrange}</td>
                            <td>
                              {h.sstart != null && h.send != null
                                ? `${Math.min(h.sstart, h.send)}–${Math.max(h.sstart, h.send)}`
                                : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <BlastHitTrack
                  hits={[
                    ...(localResult?.hits ?? []),
                  ]}
                  queryLength={queryLength}
                />
                <div className="seqviz-wrapper">
                  <SeqvizViewer
                    sequence={normalizedQuery}
                    name="BLAST query"
                    annotations={blastAnnotations}
                    viewer="linear"
                    height={320}
                  />
                </div>
              </>
            )}

          {localResult && (
            <div className="primer-tabs" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                className={`primer-tab-btn ${resultTab === "local" ? "is-active" : ""}`}
                onClick={() => setResultTab("local")}
              >
                Local
              </button>
            </div>
          )}

          {resultTab === "local" && (
            <div className="blast-two-col">
              {Object.entries(localResultsByDb).map(([tag, res]) => (
                <div className="blast-table-block" key={tag}>
                  <h3 className="blast-table-title">local ({tag})</h3>
                  {res.hits.length === 0 ? (
                    <p className="seq-hint">ヒットなし</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="seq-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>ヒット ID</th>
                            <th>Genes (local)</th>
                            <th>%id</th>
                            <th>subject 範囲</th>
                            <th>品質</th>
                          </tr>
                        </thead>
                        <tbody>{res.hits.slice(0, MAX_DISPLAY_HITS).map(renderHitRow)}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}


          {!localResult && !ncbiResult && !ensemblResult && !loading && !error && (
            <p className="seq-hint">
              クエリ配列と BLAST データベースのパスを入力し、「BLAST を実行する」を押すとここに結果が表示されます。
            </p>
          )}
        </div>
      </div>
    </section>
  );
};



