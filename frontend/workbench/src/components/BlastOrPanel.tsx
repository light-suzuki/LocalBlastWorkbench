import React, { useEffect, useMemo, useRef, useState } from "react";
import { bioapiClient } from "../api/bioapiClient";
import type { BlastOrHit, BlastOrResponse } from "../types/blast";
import type { RegionGeneModelGene, RegionGeneModelResponse } from "../types/blast";
import type { JobInfo } from "../types/jobs";
import { pollJobUntilDone } from "../utils/jobPolling";
import { useLocalBlastMode } from "../utils/localBlastMode";
import {
  CUSTOM_DB_VALUE,
  labelForDbPath,
  normalizeLocalDbValue,
  useLocalBlastDbOptionsByType,
  withCustomDbOption,
} from "../utils/localBlastDbs";
import { downloadElementAsHtml, openPrintViewForElement } from "../utils/exportReport";
import { useWorkbench } from "../utils/workbenchContext";
import { JobProgressCard } from "./JobProgressCard";
import { useToast } from "./ToastProvider";

const BLAST_OR_STORAGE_KEY = "seqwb_blast_or_settings_v1";
const BLAST_OR_PRINT_REPORT_CLASS = "print-blast-or-report";
const MIN_ALIGN_WIDTH = 40;
const MAX_ALIGN_WIDTH = 600;

const defaultAlignWidth = (): number => {
  if (typeof window === "undefined") return 120;
  const w = window.innerWidth || 0;
  if (w >= 1800) return 150; // FHD 想定
  if (w >= 1400) return 120;
  return 80;
};

type BlastOrSettings = {
  dbChoice: string;
  dbCustom: string;
  task: string;
  evalue: number;
  maxHits: number;
  lineWidth: number;
  autoLineWidth: boolean;
  viewMode: "dna" | "protein";
  queryAnnotEnabled: boolean;
  queryAnnotDbChoice: string;
  queryAnnotDbCustom: string;
};

const loadSettings = (): BlastOrSettings => {
  const fallback: BlastOrSettings = {
    dbChoice: "UserDB_ref",
    dbCustom: "",
    task: "megablast",
    evalue: 1e-5,
    maxHits: 10,
    lineWidth: defaultAlignWidth(),
    autoLineWidth: true,
    viewMode: "dna",
    queryAnnotEnabled: false,
    queryAnnotDbChoice: "UserDB_ref",
    queryAnnotDbCustom: "",
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(BLAST_OR_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<BlastOrSettings>;
    return {
      ...fallback,
      ...parsed,
      dbChoice:
        typeof parsed.dbChoice === "string" && parsed.dbChoice.trim()
          ? normalizeLocalDbValue(parsed.dbChoice)
          : fallback.dbChoice,
      dbCustom: typeof parsed.dbCustom === "string" ? parsed.dbCustom : fallback.dbCustom,
      task: typeof parsed.task === "string" && parsed.task.trim() ? parsed.task.trim() : fallback.task,
      evalue: typeof parsed.evalue === "number" && Number.isFinite(parsed.evalue) ? parsed.evalue : fallback.evalue,
      maxHits: typeof parsed.maxHits === "number" && Number.isFinite(parsed.maxHits) ? parsed.maxHits : fallback.maxHits,
      lineWidth:
        typeof parsed.lineWidth === "number" && Number.isFinite(parsed.lineWidth)
          ? Math.max(MIN_ALIGN_WIDTH, Math.min(MAX_ALIGN_WIDTH, Math.floor(parsed.lineWidth)))
          : fallback.lineWidth,
      autoLineWidth: typeof parsed.autoLineWidth === "boolean" ? parsed.autoLineWidth : fallback.autoLineWidth,
      viewMode: parsed.viewMode === "protein" ? "protein" : "dna",
      queryAnnotEnabled: typeof parsed.queryAnnotEnabled === "boolean" ? parsed.queryAnnotEnabled : fallback.queryAnnotEnabled,
      queryAnnotDbChoice:
        typeof parsed.queryAnnotDbChoice === "string" && parsed.queryAnnotDbChoice.trim()
          ? normalizeLocalDbValue(parsed.queryAnnotDbChoice)
          : fallback.queryAnnotDbChoice,
      queryAnnotDbCustom: typeof parsed.queryAnnotDbCustom === "string" ? parsed.queryAnnotDbCustom : fallback.queryAnnotDbCustom,
    };
  } catch {
    return fallback;
  }
};

const saveSettings = (value: BlastOrSettings): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BLAST_OR_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }
};

type ParsedFastaEntry = {
  id: string;
  header: string;
  sequence: string;
  length: number;
  kind: "dna" | "protein" | "other";
};

const normalizeSequence = (raw: string): string =>
  (raw || "").replace(/[^A-Za-z]/g, "").toUpperCase();

const classifySequence = (seq: string): ParsedFastaEntry["kind"] => {
  const s = seq.toUpperCase();
  if (!s) return "other";
  const dnaChars = s.replace(/[^ACGTN]/g, "").length;
  const total = s.length;
  const frac = total > 0 ? dnaChars / total : 0;
  if (frac >= 0.9) return "dna";
  if (frac <= 0.4) return "protein";
  return "other";
};

const parseFastaLikeText = (raw: string): ParsedFastaEntry[] => {
  const text = (raw || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const hasHeader = lines.some((l) => l.trim().startsWith(">"));

  if (!hasHeader) {
    const sequence = normalizeSequence(text);
    if (!sequence) return [];
    return [
      {
        id: "pasted",
        header: "pasted_sequence",
        sequence,
        length: sequence.length,
        kind: classifySequence(sequence),
      },
    ];
  }

  const out: ParsedFastaEntry[] = [];
  let currentHeader = "";
  let currentSeq = "";
  const flush = () => {
    const seq = normalizeSequence(currentSeq);
    if (!seq) return;
    const header = currentHeader || `entry_${out.length + 1}`;
    out.push({
      id: `fasta_${out.length}`,
      header,
      sequence: seq,
      length: seq.length,
      kind: classifySequence(seq),
    });
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith(">")) {
      if (currentHeader || currentSeq) flush();
      currentHeader = trimmed.slice(1).trim();
      currentSeq = "";
      return;
    }
    currentSeq += trimmed;
  });
  if (currentHeader || currentSeq) flush();

  return out;
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

type AlignmentChunk = {
  offset: number;
  qStart: number;
  qEnd: number;
  sStart: number;
  sEnd: number;
  qSeq: string;
  sSeq: string;
};

const splitAlignedSeq = (hit: BlastOrHit, width: number): AlignmentChunk[] => {
  const qseq = hit.qseq ?? "";
  const sseq = hit.sseq ?? "";
  const len = Math.min(qseq.length, sseq.length);
  const q = qseq.slice(0, len);
  const s = sseq.slice(0, len);

  const qStep = hit.qstart <= hit.qend ? 1 : -1;
  const sStep = hit.sstart <= hit.send ? 1 : -1;

  let qPos = hit.qstart;
  let sPos = hit.sstart;

  const out: AlignmentChunk[] = [];
  for (let i = 0; i < len; i += width) {
    const qChunk = q.slice(i, i + width);
    const sChunk = s.slice(i, i + width);
    const qBases = qChunk.split("").filter((c) => c !== "-").length;
    const sBases = sChunk.split("").filter((c) => c !== "-").length;

    const qStart = qPos;
    const sStart = sPos;
    const qEnd = qBases > 0 ? qPos + qStep * (qBases - 1) : qPos;
    const sEnd = sBases > 0 ? sPos + sStep * (sBases - 1) : sPos;

    out.push({ offset: i, qStart, qEnd, sStart, sEnd, qSeq: qChunk, sSeq: sChunk });

    qPos = qPos + qStep * qBases;
    sPos = sPos + sStep * sBases;
  }
  return out;
};

const splitIdAndDesc = (sseqid: string): { id: string; desc: string } => {
  const trimmed = (sseqid || "").trim();
  if (!trimmed) return { id: "-", desc: "" };
  const parts = trimmed.split(/\s+/);
  return { id: parts[0] ?? "-", desc: parts.slice(1).join(" ") };
};

type Range1Based = { start: number; end: number };

const normalizeRanges = (ranges: Range1Based[]): [number, number][] => {
  const cleaned: [number, number][] = [];
  ranges.forEach((r) => {
    const s = Number(r.start);
    const e = Number(r.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    if (s < 1 || e < 1) return;
    cleaned.push([Math.min(s, e), Math.max(s, e)]);
  });
  cleaned.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  cleaned.forEach(([s, e]) => {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push([s, e]);
      return;
    }
    if (s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
      return;
    }
    merged.push([s, e]);
  });
  return merged;
};

const isInRanges = (pos: number, ranges: [number, number][]): boolean => {
  if (!ranges.length) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (pos < s) hi = mid - 1;
    else if (pos > e) lo = mid + 1;
    else return true;
  }
  return false;
};

const findRangeIndex = (pos: number, ranges: [number, number][]): number => {
  if (!ranges.length) return -1;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (pos < s) hi = mid - 1;
    else if (pos > e) lo = mid + 1;
    else return mid;
  }
  return -1;
};

const CODON_TABLE: Record<string, string> = {
  TTT: "F",
  TTC: "F",
  TTA: "L",
  TTG: "L",
  TCT: "S",
  TCC: "S",
  TCA: "S",
  TCG: "S",
  TAT: "Y",
  TAC: "Y",
  TAA: "*",
  TAG: "*",
  TGT: "C",
  TGC: "C",
  TGA: "*",
  TGG: "W",
  CTT: "L",
  CTC: "L",
  CTA: "L",
  CTG: "L",
  CCT: "P",
  CCC: "P",
  CCA: "P",
  CCG: "P",
  CAT: "H",
  CAC: "H",
  CAA: "Q",
  CAG: "Q",
  CGT: "R",
  CGC: "R",
  CGA: "R",
  CGG: "R",
  ATT: "I",
  ATC: "I",
  ATA: "I",
  ATG: "M",
  ACT: "T",
  ACC: "T",
  ACA: "T",
  ACG: "T",
  AAT: "N",
  AAC: "N",
  AAA: "K",
  AAG: "K",
  AGT: "S",
  AGC: "S",
  AGA: "R",
  AGG: "R",
  GTT: "V",
  GTC: "V",
  GTA: "V",
  GTG: "V",
  GCT: "A",
  GCC: "A",
  GCA: "A",
  GCG: "A",
  GAT: "D",
  GAC: "D",
  GAA: "E",
  GAG: "E",
  GGT: "G",
  GGC: "G",
  GGA: "G",
  GGG: "G",
};

const translateCodon = (codon: string): string => {
  const c = (codon || "").toUpperCase().replace(/U/g, "T");
  if (c.length !== 3) return "X";
  if (/[^ACGT]/.test(c)) return "X";
  return CODON_TABLE[c] ?? "X";
};

const buildQueryPosToGenomePosFromHit = (hit: BlastOrHit, queryLength: number): Array<number | null> => {
  const out: Array<number | null> = Array(queryLength + 1).fill(null);
  const qseq = hit.qseq ?? "";
  const sseq = hit.sseq ?? "";
  const len = Math.min(qseq.length, sseq.length);

  const qStep = hit.qstart <= hit.qend ? 1 : -1;
  const sStep = hit.sstart <= hit.send ? 1 : -1;

  let qPos = hit.qstart;
  let sPos = hit.sstart;
  for (let i = 0; i < len; i += 1) {
    const qc = qseq[i] ?? "";
    const sc = sseq[i] ?? "";
    const qHas = qc !== "-";
    const sHas = sc !== "-";
    if (qHas) {
      if (qPos >= 1 && qPos <= queryLength) {
        out[qPos] = sHas ? sPos : null;
      }
      qPos += qStep;
    }
    if (sHas) {
      sPos += sStep;
    }
  }
  return out;
};

const buildQueryPosToGenomePosFromHits = (hits: BlastOrHit[], queryLength: number): Array<number | null> => {
  const out: Array<number | null> = Array(queryLength + 1).fill(null);
  hits.forEach((h) => {
    const partial = buildQueryPosToGenomePosFromHit(h, queryLength);
    for (let i = 1; i <= queryLength; i += 1) {
      if (out[i] == null && partial[i] != null) out[i] = partial[i];
    }
  });
  return out;
};

const computeFitWidthBp = (container: HTMLDivElement): number | null => {
  if (typeof window === "undefined") return null;

  const style = window.getComputedStyle(container);
  const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const contentWidth = (container.clientWidth || 0) - padX;
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return null;

  const row = container.querySelector(".blast-or-aln-row") as HTMLElement | null;
  const rowStyle = row ? window.getComputedStyle(row) : null;
  const gap = rowStyle ? Number.parseFloat(rowStyle.columnGap || "0") || 0 : 0;

  const probe = document.createElement("span");
  probe.textContent = "0";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.left = "-9999px";
  probe.style.top = "-9999px";
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.className = "blast-or-base";
  document.body.appendChild(probe);
  const chPx = probe.getBoundingClientRect().width;
  document.body.removeChild(probe);
  if (!Number.isFinite(chPx) || chPx <= 0) return null;

  // columns: 44px + 10ch + seq + 10ch (+ 3 gaps)
  const fixedPx = 44 + 20 * chPx + 3 * gap;
  const seqPx = contentWidth - fixedPx;
  if (!Number.isFinite(seqPx) || seqPx <= 0) return null;

  const width = Math.floor(seqPx / chPx);
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.max(MIN_ALIGN_WIDTH, Math.min(MAX_ALIGN_WIDTH, width));
};

const AlignmentViewer: React.FC<{
  db: string;
  hit: BlastOrHit;
  lineWidth: number;
  autoLineWidth: boolean;
  viewMode?: "dna" | "protein";
  subjectGene?: RegionGeneModelGene | null;
  subjectGeneLoading?: boolean;
  subjectGeneError?: string | null;
  queryGene?: RegionGeneModelGene | null;
  queryGeneLoading?: boolean;
  queryGeneError?: string | null;
  queryPosToGenomePos?: Array<number | null> | null;
  queryAnnotationEnabled?: boolean;
  queryAnnotRegion?: {
    entry: string;
    start: number;
    end: number;
    hsps: number;
    strand: "plus" | "minus";
  } | null;
}> = ({
  db,
  hit,
  lineWidth,
  autoLineWidth,
  viewMode = "dna",
  subjectGene,
  subjectGeneLoading,
  subjectGeneError,
  queryGene,
  queryGeneLoading,
  queryGeneError,
  queryPosToGenomePos,
  queryAnnotationEnabled,
  queryAnnotRegion,
}) => {
  const alnRootRef = useRef<HTMLDivElement | null>(null);
  const alnBodyRef = useRef<HTMLDivElement | null>(null);
  const alnInnerRef = useRef<HTMLDivElement | null>(null);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const [printScale, setPrintScale] = useState<number>(1);
  const { showToast } = useToast();
  const { setActiveTab, setPresetGenomeSlice } = useWorkbench();
  const [copyBusy, setCopyBusy] = useState<boolean>(false);

  const triggerReportPrint = () => {
    const root = alnRootRef.current;
    if (!root) return;
    openPrintViewForElement(root, {
      title: `BLAST-OR ${splitIdAndDesc(hit.sseqid).id}`,
      extraScript: `
        (function(){
          function computeScale(){
            var body = document.querySelector('.blast-or-aln-body');
            var inner = document.querySelector('.blast-or-aln-body-inner');
            if(!body || !inner) return;
            var style = window.getComputedStyle(body);
            var padX = (parseFloat(style.paddingLeft)||0) + (parseFloat(style.paddingRight)||0);
            var avail = (body.clientWidth||0) - padX;
            var content = inner.scrollWidth||0;
            if(!(avail>0) || !(content>0)) return;
            var s = Math.max(0.05, Math.min(1, avail / content));
            inner.style.setProperty('--blast-or-print-scale', String(Number(s.toFixed(3))));
          }
          window.addEventListener('load', function(){ setTimeout(computeScale, 30); });
          window.addEventListener('beforeprint', function(){ computeScale(); });
        })();
      `,
      extraCss: `
        body { padding: 0; }
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body { padding: 0 !important; }
        }
      `,
    });
  };

  const saveReportHtml = () => {
    const root = alnRootRef.current;
    if (!root) return;
    const subject = splitIdAndDesc(hit.sseqid).id;
    void downloadElementAsHtml(root, `blast_or_${subject}`, {
      title: `BLAST-OR ${subject}`,
      extraCss: `
        body { padding: 16px; }
      `,
    });
  };

  const copySubjectSequence = async () => {
    const dbPath = (db || "").trim();
    if (!dbPath) return;
    const subject = splitIdAndDesc(hit.sseqid);
    const forward = hit.sstart <= hit.send;
    const left = forward ? hit.sstart : hit.send;
    const right = forward ? hit.send : hit.sstart;
    const strand = forward ? "plus" : "minus";
    const header = `${subject.id}:${left}-${right} (${strand})`;

    setCopyBusy(true);
    try {
      const res = await bioapiClient.fetchLocalDbSequence({
        db: dbPath,
        entry: subject.id,
        start: left,
        end: right,
        strand,
      });
      const fasta = toFasta(header, res.sequence);
      await navigator.clipboard.writeText(fasta.trim());
      showToast("Sbjct 配列（FASTA）をコピーしました", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "配列コピーに失敗しました。";
      showToast(msg, "error");
    } finally {
      setCopyBusy(false);
    }
  };

  const sendSubjectToGenomeSlice = () => {
    const dbPath = (db || "").trim();
    if (!dbPath) return;
    const subject = splitIdAndDesc(hit.sseqid);
    const forward = hit.sstart <= hit.send;
    const left = forward ? hit.sstart : hit.send;
    const right = forward ? hit.send : hit.sstart;
    const strand = forward ? "plus" : "minus";
    setPresetGenomeSlice?.({
      db: dbPath,
      entry: subject.id,
      start: left,
      end: right,
      strand,
      label: subject.id,
    });
    setActiveTab?.("genome_slice");
  };

  useEffect(() => {
    if (!autoLineWidth) return;
    const el = alnBodyRef.current;
    if (!el) return;

    const compute = () => {
      const w = computeFitWidthBp(el);
      if (w != null) setFitWidth(w);
    };
    compute();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => compute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoLineWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const compute = () => {
      if (!autoLineWidth) return;
      const el = alnBodyRef.current;
      if (!el) return;
      const w = computeFitWidthBp(el);
      if (w != null) setFitWidth(w);
    };
    const computeScale = () => {
      const el = alnBodyRef.current;
      const inner = alnInnerRef.current;
      if (!el || !inner) return;
      const style = window.getComputedStyle(el);
      const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const avail = (el.clientWidth || 0) - padX;
      const content = inner.scrollWidth || 0;
      if (!Number.isFinite(avail) || avail <= 0 || !Number.isFinite(content) || content <= 0) return;
      const s = Math.max(0.2, Math.min(1, avail / content));
      setPrintScale(Number(s.toFixed(3)));
    };
    const deferredCompute = () => {
      // Print 用の CSS が適用された後の幅で再計算したいので、2フレーム待つ
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          compute();
          computeScale();
        }),
      );
    };
    const before = () => deferredCompute();
    const after = () => {
      if (typeof document !== "undefined") document.body.classList.remove(BLAST_OR_PRINT_REPORT_CLASS);
      setPrintScale(1);
      deferredCompute();
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);

    const mql = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    const onMqlChange = (ev?: MediaQueryListEvent) => {
      const matches = ev ? ev.matches : mql?.matches;
      if (matches) before();
      else after();
    };
    if (mql) {
      if (typeof mql.addEventListener === "function") mql.addEventListener("change", onMqlChange);
      else if (typeof (mql as unknown as { addListener?: (cb: () => void) => void }).addListener === "function") {
        (mql as unknown as { addListener: (cb: (e?: MediaQueryListEvent) => void) => void }).addListener(onMqlChange);
      }
    }
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      if (mql) {
        if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", onMqlChange);
        else if (typeof (mql as unknown as { removeListener?: (cb: () => void) => void }).removeListener === "function") {
          (mql as unknown as { removeListener: (cb: (e?: MediaQueryListEvent) => void) => void }).removeListener(onMqlChange);
        }
      }
    };
  }, [autoLineWidth]);

  const manualWidth = Math.max(MIN_ALIGN_WIDTH, Math.min(MAX_ALIGN_WIDTH, Math.floor(lineWidth || defaultAlignWidth())));
  const width = autoLineWidth ? fitWidth ?? manualWidth : manualWidth;
  const chunks = useMemo(() => splitAlignedSeq(hit, width), [hit, width]);
  const aligned = useMemo(() => {
    const qseq = hit.qseq ?? "";
    const sseq = hit.sseq ?? "";
    const len = Math.min(qseq.length, sseq.length);
    return { q: qseq.slice(0, len), s: sseq.slice(0, len), len };
  }, [hit.qseq, hit.sseq]);
  const subjectExonRanges = useMemo(() => normalizeRanges(subjectGene?.exons ?? []), [subjectGene?.exons]);
  const subjectCdsRanges = useMemo(() => normalizeRanges(subjectGene?.cds ?? []), [subjectGene?.cds]);
  const queryExonRanges = useMemo(() => normalizeRanges(queryGene?.exons ?? []), [queryGene?.exons]);
  const queryCdsRanges = useMemo(() => normalizeRanges(queryGene?.cds ?? []), [queryGene?.cds]);
  const subjectPosByIndex = useMemo(() => {
    const out: Array<number | null> = [];
    const step = hit.sstart <= hit.send ? 1 : -1;
    let pos = hit.sstart;
    for (let i = 0; i < aligned.len; i += 1) {
      const c = aligned.s[i] ?? "";
      if (c === "-") {
        out.push(null);
        continue;
      }
      out.push(pos);
      pos += step;
    }
    return out;
  }, [aligned.len, aligned.s, hit.send, hit.sstart]);
  const queryPosByIndex = useMemo(() => {
    const out: Array<number | null> = [];
    const step = hit.qstart <= hit.qend ? 1 : -1;
    let pos = hit.qstart;
    for (let i = 0; i < aligned.len; i += 1) {
      const c = aligned.q[i] ?? "";
      if (c === "-") {
        out.push(null);
        continue;
      }
      out.push(pos);
      pos += step;
    }
    return out;
  }, [aligned.len, aligned.q, hit.qend, hit.qstart]);

  const showProtein = viewMode === "protein";
  const subjectCdsIndexer = useMemo(() => {
    if (!subjectGene) return null;
    if (!subjectCdsRanges.length) return null;
    const prefix: number[] = [];
    let total = 0;
    subjectCdsRanges.forEach(([s, e]) => {
      prefix.push(total);
      total += e - s + 1;
    });
    const strand = subjectGene.strand >= 0 ? 1 : -1;
    const cdsIndexOfPos = (pos: number): number | null => {
      const idx = findRangeIndex(pos, subjectCdsRanges);
      if (idx < 0) return null;
      const [s] = subjectCdsRanges[idx];
      const forward = prefix[idx] + (pos - s);
      return strand >= 0 ? forward : total - 1 - forward;
    };
    return { total, strand, cdsIndexOfPos };
  }, [subjectCdsRanges, subjectGene]);

  type AaCellKind = "same" | "syn" | "diff" | "indel";
  type AaCell = {
    aa: string;
    aaPos: number;
    kind: AaCellKind;
    refCodon: string;
    altCodon: string;
    refAa: string;
    altAa: string;
  };

  const aaOverlay = useMemo(() => {
    if (!showProtein) return null;
    if (!subjectCdsIndexer) return null;

    const cdsIdxToAlignIdx = new Map<number, number>();
    for (let i = 0; i < aligned.len; i += 1) {
      const sPos = subjectPosByIndex[i];
      if (sPos == null) continue;
      const cdsIdx = subjectCdsIndexer.cdsIndexOfPos(sPos);
      if (cdsIdx == null) continue;
      cdsIdxToAlignIdx.set(cdsIdx, i);
    }
    if (!cdsIdxToAlignIdx.size) return null;

    const cdsIdxs = Array.from(cdsIdxToAlignIdx.keys()).sort((a, b) => a - b);
    const minCds = cdsIdxs[0] ?? 0;
    const maxCds = cdsIdxs[cdsIdxs.length - 1] ?? 0;
    const startCodon = Math.floor(minCds / 3) * 3;
    const endCodon = Math.floor(maxCds / 3) * 3;

    const refCells = new Map<number, AaCell>();
    const altCells = new Map<number, AaCell>();
    let aaDiff = 0;
    let aaSyn = 0;
    let aaIndel = 0;

    for (let codonStart = startCodon; codonStart <= endCodon; codonStart += 3) {
      const i0 = cdsIdxToAlignIdx.get(codonStart);
      const i1 = cdsIdxToAlignIdx.get(codonStart + 1);
      const i2 = cdsIdxToAlignIdx.get(codonStart + 2);
      if (i0 == null || i1 == null || i2 == null) continue;

      const refCodon = `${aligned.s[i0] ?? ""}${aligned.s[i1] ?? ""}${aligned.s[i2] ?? ""}`.toUpperCase();
      const altCodon = `${aligned.q[i0] ?? ""}${aligned.q[i1] ?? ""}${aligned.q[i2] ?? ""}`.toUpperCase();
      const refAa = translateCodon(refCodon);
      const altAa = translateCodon(altCodon);
      const aaPos = codonStart / 3 + 1;

      const hasGap = refCodon.includes("-") || altCodon.includes("-");
      const hasNtDiff = refCodon !== altCodon;
      const hasAaDiff = refAa !== altAa;
      let kind: AaCellKind = "same";
      if (hasGap || refAa === "X" || altAa === "X") {
        kind = "indel";
        aaIndel += 1;
      } else if (hasAaDiff) {
        kind = "diff";
        aaDiff += 1;
      } else if (hasNtDiff) {
        kind = "syn";
        aaSyn += 1;
      }

      // 3 塩基の「真ん中」にアミノ酸を置く（見やすさ優先）
      const displayIdx = i1;
      refCells.set(displayIdx, { aa: refAa, aaPos, kind, refCodon, altCodon, refAa, altAa });
      altCells.set(displayIdx, { aa: altAa, aaPos, kind, refCodon, altCodon, refAa, altAa });
    }

    return {
      refCells,
      altCells,
      stats: { aaDiff, aaSyn, aaIndel },
    };
  }, [aligned.len, aligned.q, aligned.s, showProtein, subjectCdsIndexer, subjectPosByIndex]);

  const mismatchStats = useMemo(() => {
    let mismatches = 0;
    let deletions = 0;
    let insertions = 0;
    let inSubjectExonMismatch = 0;
    let inSubjectCdsMismatch = 0;
    let inSubjectExonDeletion = 0;
    let inSubjectCdsDeletion = 0;
    let inQueryExonMismatch = 0;
    let inQueryCdsMismatch = 0;
    let inQueryExonInsertion = 0;
    let inQueryCdsInsertion = 0;
    for (let i = 0; i < aligned.len; i += 1) {
      const qc = aligned.q[i] ?? "";
      const sc = aligned.s[i] ?? "";
      const qGap = qc === "-";
      const sGap = sc === "-";

      if (qGap && sGap) continue;
      const isDeletion = qGap && !sGap;
      const isInsertion = !qGap && sGap;
      const isMismatch = !qGap && !sGap && qc.toUpperCase() !== sc.toUpperCase();

      const sPos = subjectPosByIndex[i];
      if (isMismatch) {
        mismatches += 1;
        if (sPos != null) {
          if (isInRanges(sPos, subjectExonRanges)) inSubjectExonMismatch += 1;
          if (isInRanges(sPos, subjectCdsRanges)) inSubjectCdsMismatch += 1;
        }
        if (queryPosToGenomePos) {
          const qPos = queryPosByIndex[i];
          const qGenomePos = qPos != null ? queryPosToGenomePos[qPos] : null;
          if (qGenomePos != null) {
            if (isInRanges(qGenomePos, queryExonRanges)) inQueryExonMismatch += 1;
            if (isInRanges(qGenomePos, queryCdsRanges)) inQueryCdsMismatch += 1;
          }
        }
      } else if (isDeletion) {
        deletions += 1;
        if (sPos != null) {
          if (isInRanges(sPos, subjectExonRanges)) inSubjectExonDeletion += 1;
          if (isInRanges(sPos, subjectCdsRanges)) inSubjectCdsDeletion += 1;
        }
      } else if (isInsertion) {
        insertions += 1;
        if (queryPosToGenomePos) {
          const qPos = queryPosByIndex[i];
          const qGenomePos = qPos != null ? queryPosToGenomePos[qPos] : null;
          if (qGenomePos != null) {
            if (isInRanges(qGenomePos, queryExonRanges)) inQueryExonInsertion += 1;
            if (isInRanges(qGenomePos, queryCdsRanges)) inQueryCdsInsertion += 1;
          }
        }
      }
    }
    return {
      mismatches,
      deletions,
      insertions,
      inSubjectExonMismatch,
      inSubjectCdsMismatch,
      inSubjectExonDeletion,
      inSubjectCdsDeletion,
      inQueryExonMismatch,
      inQueryCdsMismatch,
      inQueryExonInsertion,
      inQueryCdsInsertion,
    };
  }, [
    aligned.len,
    aligned.q,
    aligned.s,
    queryCdsRanges,
    queryExonRanges,
    queryPosByIndex,
    queryPosToGenomePos,
    subjectCdsRanges,
    subjectExonRanges,
    subjectPosByIndex,
  ]);
  const subject = splitIdAndDesc(hit.sseqid);
  const strand = hit.sstart <= hit.send ? "(+)" : "(-)";
  const subjectGeneLabel = subjectGene
    ? subjectGene.gene_name && subjectGene.gene_name !== subjectGene.gene_id
      ? `${subjectGene.gene_name} (${subjectGene.gene_id})`
      : subjectGene.gene_id
    : null;
  const queryGeneLabel = queryGene
    ? queryGene.gene_name && queryGene.gene_name !== queryGene.gene_id
      ? `${queryGene.gene_name} (${queryGene.gene_id})`
      : queryGene.gene_id
    : null;

  const formatLocus = (opts: {
    chrom: string;
    entry?: string | null;
    start: number;
    end: number;
    strand: "plus" | "minus";
  }): string => {
    const chrom = (opts.chrom || "-").trim() || "-";
    const entry = (opts.entry || "").trim();
    const label = entry && entry !== chrom ? `${chrom} (${entry})` : chrom;
    const left = Math.min(opts.start, opts.end);
    const right = Math.max(opts.start, opts.end);
    const arrow = opts.strand === "plus" ? "→" : "←";
    const strand = opts.strand === "plus" ? "(+)" : "(-)";
    return `${label}:${left.toLocaleString()}${arrow}${right.toLocaleString()} ${strand}`;
  };

  const subjectHitLocus = formatLocus({
    chrom: subjectGene?.seqid || hit.subject_chrom || subject.id,
    entry: subjectGene?.seqid ? subject.id : null,
    start: hit.sstart,
    end: hit.send,
    strand: hit.sstart <= hit.send ? "plus" : "minus",
  });

  const queryAnnotLocus = queryAnnotRegion
    ? formatLocus({
        chrom: queryGene?.seqid || queryAnnotRegion.entry,
        entry: queryGene?.seqid ? queryAnnotRegion.entry : null,
        start: queryAnnotRegion.start,
        end: queryAnnotRegion.end,
        strand: queryAnnotRegion.strand,
      })
    : null;

  const renderAlignedBases = (seq: string, other: string, offset: number, which: "query" | "subject") =>
    (() => {
      type RunType = "match" | "gap" | "mismatch" | "del" | "ins";
      const out: React.ReactNode[] = [];
      let runType: RunType | null = null;
      let runStart = 0;
      let runNodes: React.ReactNode[] = [];

      const flush = () => {
        if (!runType) return;
        if (runType === "match" || runType === "gap") {
          out.push(...runNodes);
        } else {
          out.push(
            <span key={`run-${offset}-${which}-${runStart}`} className={`blast-or-run ${runType}`}>
              {runNodes}
            </span>,
          );
        }
        runNodes = [];
      };

      for (let idx = 0; idx < seq.length; idx += 1) {
        const ch = seq[idx] ?? "";
        const peer = other[idx] ?? "";
        const upper = ch.toUpperCase();
        const upperPeer = peer.toUpperCase();
        const gapSelf = ch === "-";
        const gapPeer = peer === "-";
        const isDeletion = gapSelf && !gapPeer;
        const isInsertion = !gapSelf && gapPeer;
        const isGap = gapSelf || gapPeer;
        const isMatch = !isGap && upper === upperPeer && upper !== "";
        const isMismatch = !isGap && !isMatch;

        const thisType: RunType = isDeletion
          ? "del"
          : isInsertion
            ? "ins"
            : isMismatch
              ? "mismatch"
              : isGap
                ? "gap"
                : "match";

        if (runType == null) {
          runType = thisType;
          runStart = idx;
        } else if (runType !== thisType) {
          flush();
          runType = thisType;
          runStart = idx;
        }

        const globalIdx = offset + idx;
        const sPos = subjectPosByIndex[globalIdx];
        const subjectExon = sPos != null && isInRanges(sPos, subjectExonRanges);
        const subjectCds = sPos != null && isInRanges(sPos, subjectCdsRanges);

        const qPos = queryPosByIndex[globalIdx];
        const qGenomePos = queryPosToGenomePos && qPos != null ? queryPosToGenomePos[qPos] : null;
        const queryExon = qGenomePos != null && isInRanges(qGenomePos, queryExonRanges);
        const queryCds = qGenomePos != null && isInRanges(qGenomePos, queryCdsRanges);

        const useQueryAnnot = Boolean(queryAnnotationEnabled && which === "query" && queryPosToGenomePos && queryGene);
        const exon = useQueryAnnot ? queryExon : subjectExon;
        const cds = useQueryAnnot ? queryCds : subjectCds;

        const classes = ["blast-or-base"];
        if (thisType === "gap") classes.push("gap");
        else if (thisType === "match") classes.push("match");
        if (cds) classes.push("cds");
        else if (exon) classes.push("exon");

        runNodes.push(
          <span key={idx} className={classes.join(" ")}>
            {ch}
          </span>,
        );
      }

      flush();
      return out;
    })();

  const renderMidline = (q: string, s: string, offset: number) =>
    q.split("").map((qc, idx) => {
      const sc = s[idx] ?? "";
      const isGap = qc === "-" || sc === "-";
      const isMatch = !isGap && qc.toUpperCase() === sc.toUpperCase();
      const isMismatch = !isGap && !isMatch;
      const globalIdx = offset + idx;
      const sPos = subjectPosByIndex[globalIdx];
      const exon = sPos != null && isInRanges(sPos, subjectExonRanges);
      const cds = sPos != null && isInRanges(sPos, subjectCdsRanges);
      const classes = ["blast-or-mid"];
      if (isMatch) classes.push("match");
      else if (isMismatch) classes.push("mismatch");
      else if (isGap) classes.push("gap");
      if (cds) classes.push("cds");
      else if (exon) classes.push("exon");
      return (
        <span key={idx} className={classes.join(" ")}>
          {isMatch ? "|" : isMismatch ? "•" : " "}
        </span>
      );
    });

  const proteinOverlayEnabled = Boolean(showProtein && aaOverlay);

  const findAaRange = (offset: number, length: number): { start: number; end: number } | null => {
    const cells = aaOverlay?.refCells;
    if (!cells) return null;
    let start: number | null = null;
    let end: number | null = null;
    for (let i = 0; i < length; i += 1) {
      const cell = cells.get(offset + i);
      if (!cell) continue;
      if (start == null) start = cell.aaPos;
      end = cell.aaPos;
    }
    if (start == null || end == null) return null;
    return { start, end };
  };

  const renderAaLine = (seq: string, offset: number, which: "query" | "subject") =>
    seq.split("").map((_ch, idx) => {
      const globalIdx = offset + idx;
      const cell = (which === "subject" ? aaOverlay?.refCells : aaOverlay?.altCells)?.get(globalIdx);
      const classes = ["blast-or-aa"];
      let title: string | undefined;
      if (cell) {
        classes.push("cds");
        if (cell.kind === "diff") classes.push("aa-diff");
        else if (cell.kind === "syn") classes.push("aa-syn");
        else if (cell.kind === "indel") classes.push("aa-indel");
        title = `AA${cell.aaPos}: ${cell.refCodon}→${cell.altCodon} (${cell.refAa}→${cell.altAa})`;
      }
      return (
        <span key={idx} className={classes.join(" ")} title={title}>
          {cell ? cell.aa : " "}
        </span>
      );
    });

  return (
    <div ref={alnRootRef} className="blast-or-aln">
      <div className="blast-or-aln-header">
        <div className="blast-or-aln-header-top">
          <span className="blast-or-aln-title">
            {subject.id} {strand}
          </span>
          <div className="blast-or-aln-header-actions">
            <button
              type="button"
              className="seq-button secondary blast-or-save-btn"
              onClick={saveReportHtml}
              title="色付きのレポートHTMLとして保存します（オフラインでも開けます）"
            >
              レポート保存（HTML）
            </button>
            <button
              type="button"
              className="seq-button secondary blast-or-copy-btn"
              onClick={() => void copySubjectSequence()}
              disabled={copyBusy || !(db || "").trim()}
              title="subject のヒット範囲を FASTA でコピーします"
            >
              {copyBusy ? "コピー中..." : "Sbjctコピー"}
            </button>
            <button
              type="button"
              className="seq-button secondary blast-or-extract-btn"
              onClick={sendSubjectToGenomeSlice}
              disabled={!(db || "").trim()}
              title="ゲノム切り出しタブに座標を送ります"
            >
              切り出しへ
            </button>
            <button type="button" className="seq-button secondary blast-or-print-btn" onClick={triggerReportPrint}>
              レポート印刷（PDF）
            </button>
          </div>
        </div>
        {subjectGeneLabel || queryGeneLabel ? (
          <span className="seq-hint">
            gene: subject <b>{subjectGeneLabel || "-"}</b> / query <b>{queryGeneLabel || "-"}</b>
            {queryGeneLabel ? "（queryはクエリ注釈で選択中）" : ""}
          </span>
        ) : null}
        <span className="seq-hint">
          pident {hit.pident.toFixed(1)}% / len {hit.length} / evalue {hit.evalue.toExponential(2)} / bitscore{" "}
          {hit.bitscore.toFixed(1)}
        </span>
        <span className="seq-hint">
          1行: <b>{width}</b> bp {autoLineWidth ? "（横幅フィット）" : ""}
        </span>
        <span className="seq-hint">
          ミニレポート: ミスマッチ <b>{mismatchStats.mismatches}</b> / 欠損(del) <b>{mismatchStats.deletions}</b> / 挿入(ins){" "}
          <b>{mismatchStats.insertions}</b>
        </span>
        {subjectGene ? (
          <span className="seq-hint">
            subject（{subjectGeneLabel}）: ミスマッチ exon/cds <b>{mismatchStats.inSubjectExonMismatch}</b>/<b>{mismatchStats.inSubjectCdsMismatch}</b> / 欠損 exon/cds{" "}
            <b>{mismatchStats.inSubjectExonDeletion}</b>/<b>{mismatchStats.inSubjectCdsDeletion}</b>
          </span>
        ) : null}
        {queryGene ? (
          <span className="seq-hint">
            query（{queryGeneLabel}）: ミスマッチ exon/cds <b>{mismatchStats.inQueryExonMismatch}</b>/<b>{mismatchStats.inQueryCdsMismatch}</b> / 挿入 exon/cds{" "}
            <b>{mismatchStats.inQueryExonInsertion}</b>/<b>{mismatchStats.inQueryCdsInsertion}</b>
          </span>
        ) : null}
        {subjectGene || queryGene ? (
          <span className="seq-hint">
            凡例: exon=緑 / CDS=青 / mismatch=赤枠 / del=橙枠 / ins=紫枠 / AA: 変化=赤枠・同義=点線・indel=橙枠
          </span>
        ) : null}
        {showProtein ? (
          aaOverlay ? (
            <span className="seq-hint">
              タンパク（CDS翻訳, subject={subjectGeneLabel || "-" } のCDS基準）: AA変化 <b>{aaOverlay.stats.aaDiff}</b> / 同義 <b>{aaOverlay.stats.aaSyn}</b> / indel/不完全{" "}
              <b>{aaOverlay.stats.aaIndel}</b>
            </span>
          ) : (
            <span className="seq-hint">タンパク表示には subject gene の CDS 注釈が必要です（ヒットを選ぶと自動取得します）。</span>
          )
        ) : null}
        {queryAnnotationEnabled && queryGene ? (
          <span className="seq-hint">表示: Query 行は query gene 注釈 / Sbjct 行は subject gene 注釈</span>
        ) : null}
        {subjectGeneLoading ? <span className="seq-hint">subject 注釈: 読み込み中...</span> : null}
        {subjectGeneError ? <span className="seq-hint">subject 注釈エラー: {subjectGeneError}</span> : null}
        {queryGeneLoading ? <span className="seq-hint">query 注釈: 読み込み中...</span> : null}
        {queryGeneError ? <span className="seq-hint">query 注釈エラー: {queryGeneError}</span> : null}
        {subjectGene ? (
          <span className="seq-hint">
            subject gene: <b>{subjectGeneLabel}</b>（exon {subjectGene.exons.length} / cds {subjectGene.cds.length}） / hit:{" "}
            <b>{subjectHitLocus}</b>
          </span>
        ) : null}
        {queryGene ? (
          <span className="seq-hint">
            query gene（クエリ注釈）: <b>{queryGeneLabel}</b>（exon {queryGene.exons.length} / cds {queryGene.cds.length}）
            {queryAnnotLocus ? (
              <>
                {" "}
                / mapping: <b>{queryAnnotLocus}</b>
              </>
            ) : null}
          </span>
        ) : null}
        {subject.desc ? <div className="seq-hint">{subject.desc}</div> : null}
      </div>
      <div ref={alnBodyRef} className="blast-or-aln-body" role="region" aria-label="BLAST alignment">
        <div
          ref={alnInnerRef}
          className="blast-or-aln-body-inner"
          style={{ ["--blast-or-print-scale" as never]: String(printScale) }}
        >
          {chunks.map((c, idx) => (
            <div key={idx} className="blast-or-aln-chunk">
            {proteinOverlayEnabled ? (
              (() => {
                const aaRange = findAaRange(c.offset, c.qSeq.length);
                return (
                  <div className="blast-or-aln-row aa">
                    <span className="blast-or-aln-tag">Q-aa</span>
                    <span className="blast-or-aln-pos">{aaRange ? aaRange.start : ""}</span>
                    <span className="blast-or-aln-seq">{renderAaLine(c.qSeq, c.offset, "query")}</span>
                    <span className="blast-or-aln-pos">{aaRange ? aaRange.end : ""}</span>
                  </div>
                );
              })()
            ) : null}
            <div className="blast-or-aln-row">
              <span className="blast-or-aln-tag">Query</span>
              <span className="blast-or-aln-pos">{c.qStart}</span>
              <span className="blast-or-aln-seq">{renderAlignedBases(c.qSeq, c.sSeq, c.offset, "query")}</span>
              <span className="blast-or-aln-pos">{c.qEnd}</span>
            </div>
            <div className="blast-or-aln-row mid">
              <span className="blast-or-aln-tag" />
              <span className="blast-or-aln-pos" />
              <span className="blast-or-aln-seq">{renderMidline(c.qSeq, c.sSeq, c.offset)}</span>
              <span className="blast-or-aln-pos" />
            </div>
            <div className="blast-or-aln-row">
              <span className="blast-or-aln-tag">Sbjct</span>
              <span className="blast-or-aln-pos">{c.sStart}</span>
              <span className="blast-or-aln-seq">{renderAlignedBases(c.sSeq, c.qSeq, c.offset, "subject")}</span>
              <span className="blast-or-aln-pos">{c.sEnd}</span>
            </div>
            {proteinOverlayEnabled ? (
              (() => {
                const aaRange = findAaRange(c.offset, c.qSeq.length);
                return (
                  <div className="blast-or-aln-row aa">
                    <span className="blast-or-aln-tag">S-aa</span>
                    <span className="blast-or-aln-pos">{aaRange ? aaRange.start : ""}</span>
                    <span className="blast-or-aln-seq">{renderAaLine(c.qSeq, c.offset, "subject")}</span>
                    <span className="blast-or-aln-pos">{aaRange ? aaRange.end : ""}</span>
                  </div>
                );
              })()
            ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const BlastOrPanel: React.FC = () => {
  const [localMode, setLocalMode] = useLocalBlastMode();

  const [settings, setSettings] = useState<BlastOrSettings>(() => loadSettings());

  const { options: localDbOptions, loading: dbLoading, error: dbError } = useLocalBlastDbOptionsByType("nucl");

  const localDbOptionsWithCustom = useMemo(
    () => withCustomDbOption(localDbOptions, "手動入力（makeblastdb prefix）"),
    [localDbOptions],
  );
  const queryAnnotDbOptionsWithCustom = useMemo(
    () => withCustomDbOption(localDbOptions, "手動入力（makeblastdb prefix）"),
    [localDbOptions],
  );
  const [queryText, setQueryText] = useState<string>("");
  const queryEntries = useMemo(() => parseFastaLikeText(queryText), [queryText]);
  const dnaQueryEntries = useMemo(() => queryEntries.filter((e) => e.kind === "dna"), [queryEntries]);
  const selectableQueryEntries = useMemo(() => (dnaQueryEntries.length > 0 ? dnaQueryEntries : queryEntries), [dnaQueryEntries, queryEntries]);
  const [selectedQueryId, setSelectedQueryId] = useState<string>("pasted");
  const [normalizedQuery, setNormalizedQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [blastJobId, setBlastJobId] = useState<string | null>(null);
  const [blastJobInfo, setBlastJobInfo] = useState<JobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BlastOrResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [geneModel, setGeneModel] = useState<RegionGeneModelResponse | null>(null);
  const [geneModelLoading, setGeneModelLoading] = useState<boolean>(false);
  const [geneModelError, setGeneModelError] = useState<string | null>(null);
  const [selectedGeneIndex, setSelectedGeneIndex] = useState<number>(0);
  const [queryAnnotRegion, setQueryAnnotRegion] = useState<{
    entry: string;
    start: number;
    end: number;
    hsps: number;
    strand: "plus" | "minus";
  } | null>(null);
  const [queryPosToGenomePos, setQueryPosToGenomePos] = useState<Array<number | null> | null>(null);
  const [queryGeneModel, setQueryGeneModel] = useState<RegionGeneModelResponse | null>(null);
  const [queryGeneModelLoading, setQueryGeneModelLoading] = useState<boolean>(false);
  const [queryGeneModelError, setQueryGeneModelError] = useState<string | null>(null);
  const [selectedQueryGeneIndex, setSelectedQueryGeneIndex] = useState<number>(0);
  const [queryAnnotJobId, setQueryAnnotJobId] = useState<string | null>(null);
  const [queryAnnotJobInfo, setQueryAnnotJobInfo] = useState<JobInfo | null>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!localDbOptions.length) return;
    const values = new Set(localDbOptionsWithCustom.map((o) => o.value));
    if (values.has(settings.dbChoice)) return;
    const first = localDbOptions[0]?.value;
    if (!first) return;
    setSettings((prev) => ({ ...prev, dbChoice: first }));
  }, [localDbOptions, localDbOptionsWithCustom, settings.dbChoice]);

  useEffect(() => {
    if (!localDbOptions.length) return;
    const values = new Set(queryAnnotDbOptionsWithCustom.map((o) => o.value));
    if (values.has(settings.queryAnnotDbChoice)) return;
    const first = localDbOptions[0]?.value;
    if (!first) return;
    setSettings((prev) => ({ ...prev, queryAnnotDbChoice: first }));
  }, [localDbOptions, queryAnnotDbOptionsWithCustom, settings.queryAnnotDbChoice]);

  useEffect(() => {
    if (!queryEntries.length) return;
    const selected = queryEntries.find((e) => e.id === selectedQueryId);
    const exists = Boolean(selected);
    if (exists) {
      if (dnaQueryEntries.length === 0 || selected?.kind === "dna") return;
    }
    const preferred = dnaQueryEntries[0]?.id;
    setSelectedQueryId(preferred || queryEntries[0].id);
  }, [dnaQueryEntries, queryEntries, selectedQueryId]);

  const selectedQueryEntry = useMemo(() => {
    const hit = queryEntries.find((e) => e.id === selectedQueryId);
    return hit || selectableQueryEntries[0] || null;
  }, [queryEntries, selectableQueryEntries, selectedQueryId]);

  const resolvedDb = useMemo(() => {
    const choice = settings.dbChoice;
    if (choice === CUSTOM_DB_VALUE) return settings.dbCustom.trim();
    return choice.trim();
  }, [settings.dbChoice, settings.dbCustom]);

  const queryAnnotResolvedDb = useMemo(() => {
    const choice = settings.queryAnnotDbChoice;
    if (choice === CUSTOM_DB_VALUE) return settings.queryAnnotDbCustom.trim();
    return choice.trim();
  }, [settings.queryAnnotDbChoice, settings.queryAnnotDbCustom]);

  const resolvedDbLabel = useMemo(
    () => (resolvedDb ? labelForDbPath(resolvedDb, localDbOptions) : "-"),
    [localDbOptions, resolvedDb],
  );
  const queryAnnotResolvedDbLabel = useMemo(
    () => (queryAnnotResolvedDb ? labelForDbPath(queryAnnotResolvedDb, localDbOptions) : "-"),
    [localDbOptions, queryAnnotResolvedDb],
  );

  const selectedHit = useMemo(() => {
    const hits = result?.hits ?? [];
    if (!hits.length) return null;
    const idx = Math.max(0, Math.min(selectedIndex, hits.length - 1));
    return hits[idx] ?? null;
  }, [result, selectedIndex]);

  const geneHint = useMemo(() => {
    const header = (selectedQueryEntry?.header || "").trim();
    if (!header) return undefined;
    const token = header.split(/\s+/)[0] || "";
    const stripped = token.replace(/\.\d+$/, "");
    return stripped || undefined;
  }, [selectedQueryEntry]);

  const selectedGene = useMemo(() => {
    const genes = geneModel?.genes ?? [];
    if (!genes.length) return null;
    const idx = Math.max(0, Math.min(selectedGeneIndex, genes.length - 1));
    return genes[idx] ?? null;
  }, [geneModel, selectedGeneIndex]);

  const selectedQueryGene = useMemo(() => {
    const genes = queryGeneModel?.genes ?? [];
    if (!genes.length) return null;
    const idx = Math.max(0, Math.min(selectedQueryGeneIndex, genes.length - 1));
    return genes[idx] ?? null;
  }, [queryGeneModel, selectedQueryGeneIndex]);

  useEffect(() => {
    if (!selectedHit || !resolvedDb) {
      setGeneModel(null);
      setGeneModelError(null);
      setGeneModelLoading(false);
      return;
    }

    const entry = splitIdAndDesc(selectedHit.sseqid).id;
    const start = Math.min(selectedHit.sstart, selectedHit.send);
    const end = Math.max(selectedHit.sstart, selectedHit.send);

    let active = true;
    setGeneModelLoading(true);
    setGeneModelError(null);
    setSelectedGeneIndex(0);
    bioapiClient
      .fetchRegionGeneModel({
        db: resolvedDb,
        entry,
        start,
        end,
        gene_hint: geneHint,
        max_genes: 3,
      })
      .then((res) => {
        if (!active) return;
        setGeneModel(res);
      })
      .catch((e) => {
        if (!active) return;
        setGeneModel(null);
        setGeneModelError(e instanceof Error ? e.message : "注釈の取得に失敗しました。");
      })
      .finally(() => {
        if (!active) return;
        setGeneModelLoading(false);
      });

    return () => {
      active = false;
    };
  }, [geneHint, resolvedDb, selectedHit]);

  useEffect(() => {
    if (!settings.queryAnnotEnabled) {
      setQueryAnnotRegion(null);
      setQueryPosToGenomePos(null);
      setQueryGeneModel(null);
      setQueryGeneModelError(null);
      setQueryGeneModelLoading(false);
      setSelectedQueryGeneIndex(0);
      setQueryAnnotJobId(null);
      setQueryAnnotJobInfo(null);
      return;
    }
    if (!normalizedQuery || !queryAnnotResolvedDb) {
      setQueryAnnotRegion(null);
      setQueryPosToGenomePos(null);
      setQueryGeneModel(null);
      setQueryGeneModelError(null);
      setQueryGeneModelLoading(false);
      setSelectedQueryGeneIndex(0);
      setQueryAnnotJobId(null);
      setQueryAnnotJobInfo(null);
      return;
    }

    let active = true;
    setQueryAnnotRegion(null);
    setQueryPosToGenomePos(null);
    setQueryGeneModel(null);
    setQueryGeneModelError(null);
    setQueryGeneModelLoading(true);
    setSelectedQueryGeneIndex(0);
    setQueryAnnotJobId(null);
    setQueryAnnotJobInfo(null);

    const run = async () => {
      try {
        const job = await bioapiClient.createBlastOrJob({
          sequence: normalizedQuery,
          db: queryAnnotResolvedDb,
          program: "blastn",
          local_mode: "cpu",
          task: "blastn",
          evalue: settings.evalue,
          max_target_seqs: 5,
          max_hsps: 100,
        });
        if (!active) return;
        setQueryAnnotJobId(job.job_id);

        const info = await pollJobUntilDone(job.job_id, {
          onUpdate: (i) => {
            if (!active) return;
            setQueryAnnotJobInfo(i);
          },
          intervalMs: 900,
        });
        if (!active) return;
        if (info.status !== "succeeded") {
          throw new Error(info.error ?? "クエリ注釈用の BLAST ジョブに失敗しました。");
        }

        const res = await bioapiClient.getJobResult<BlastOrResponse>(job.job_id);
        if (!active) return;

        const hits = res.hits ?? [];
        if (hits.length === 0) {
          throw new Error("クエリ注釈用の BLAST マッピング結果が見つかりませんでした。");
        }
        const byEntry = new Map<string, BlastOrHit[]>();
        hits.forEach((h) => {
          const entry = splitIdAndDesc(h.sseqid).id;
          if (!entry || entry === "-") return;
          const prev = byEntry.get(entry);
          if (prev) prev.push(h);
          else byEntry.set(entry, [h]);
        });

        let best: {
          entry: string;
          hsps: BlastOrHit[];
          map: Array<number | null>;
          start: number;
          end: number;
          coverage: number;
          strand: "plus" | "minus";
        } | null = null;
        for (const [entry, hsps] of byEntry.entries()) {
          const map = buildQueryPosToGenomePosFromHits(hsps, normalizedQuery.length);
          let coverage = 0;
          for (let i = 1; i < map.length; i += 1) {
            if (map[i] != null) coverage += 1;
          }
          if (!coverage) continue;
          const start = Math.min(...hsps.map((h) => Math.min(h.sstart, h.send)));
          const end = Math.max(...hsps.map((h) => Math.max(h.sstart, h.send)));
          let plus = 0;
          let minus = 0;
          hsps.forEach((h) => {
            if (h.sstart <= h.send) plus += 1;
            else minus += 1;
          });
          const strand: "plus" | "minus" = plus >= minus ? "plus" : "minus";
          if (!best || coverage > best.coverage) {
            best = { entry, hsps, map, start, end, coverage, strand };
          }
        }

        if (!best) {
          throw new Error("クエリ注釈: 有効なマッピングが見つかりませんでした（coverage=0）。");
        }

        setQueryAnnotRegion({
          entry: best.entry,
          start: best.start,
          end: best.end,
          hsps: best.hsps.length,
          strand: best.strand,
        });
        setQueryPosToGenomePos(best.map);

        const model = await bioapiClient.fetchRegionGeneModel({
          db: queryAnnotResolvedDb,
          entry: best.entry,
          start: best.start,
          end: best.end,
          gene_hint: geneHint,
          max_genes: 3,
        });
        if (!active) return;
        setQueryGeneModel(model || null);
      } catch (e) {
        if (!active) return;
        setQueryGeneModel(null);
        setQueryGeneModelError(e instanceof Error ? e.message : "クエリ注釈の取得に失敗しました。");
      } finally {
        if (active) {
          setQueryGeneModelLoading(false);
          setQueryAnnotJobId(null);
          setQueryAnnotJobInfo(null);
        }
      }
    };

    void run();

    return () => {
      active = false;
    };
  }, [
    geneHint,
    normalizedQuery,
    queryAnnotResolvedDb,
    settings.evalue,
    settings.queryAnnotEnabled,
  ]);

  const cancelBlastJob = async () => {
    if (!blastJobId) return;
    try {
      const updated = await bioapiClient.cancelJob(blastJobId);
      setBlastJobInfo(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ジョブのキャンセルに失敗しました。");
    }
  };

  const cancelQueryAnnotJob = async () => {
    if (!queryAnnotJobId) return;
    try {
      const updated = await bioapiClient.cancelJob(queryAnnotJobId);
      setQueryAnnotJobInfo(updated);
    } catch (e) {
      setQueryGeneModelError(e instanceof Error ? e.message : "ジョブのキャンセルに失敗しました。");
    }
  };

  const handleRun = async () => {
    const normalized = selectedQueryEntry?.sequence || "";
    if (!normalized) {
      setError("クエリ配列（FASTA可）を入力してください。");
      return;
    }
    if (!resolvedDb) {
      setError("ローカル DB を選択してください。");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedIndex(0);
    setGeneModel(null);
    setGeneModelError(null);
    setGeneModelLoading(false);
    setSelectedGeneIndex(0);
    setNormalizedQuery(normalized);
    setQueryAnnotRegion(null);
    setQueryPosToGenomePos(null);
    setQueryGeneModel(null);
    setQueryGeneModelError(null);
    setQueryGeneModelLoading(false);
    setSelectedQueryGeneIndex(0);
    setBlastJobId(null);
    setBlastJobInfo(null);

    try {
      const job = await bioapiClient.createBlastOrJob({
        sequence: normalized,
        db: resolvedDb,
        program: "blastn",
        local_mode: localMode,
        task: settings.task,
        evalue: settings.evalue,
        max_target_seqs: settings.maxHits,
      });
      setBlastJobId(job.job_id);

      const info = await pollJobUntilDone(job.job_id, {
        onUpdate: (i) => setBlastJobInfo(i),
        intervalMs: 900,
      });
      if (info.status !== "succeeded") {
        throw new Error(info.error ?? "BLAST-OR ジョブに失敗しました。");
      }

      const res = await bioapiClient.getJobResult<BlastOrResponse>(job.job_id);
      setResult(res);
      setSelectedIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "BLAST-OR の実行に失敗しました。");
    } finally {
      setLoading(false);
      setBlastJobId(null);
      setBlastJobInfo(null);
    }
  };

  return (
    <section className="seq-result-block">
      <h2 className="panel-title">BLAST-OR（アラインメント表示）</h2>
      <p className="panel-hint">ローカル BLAST+ を 1 ゲノム（DB）× 1 クエリで実行し、ミスマッチを色分けして表示します。</p>

      <div className="blast-grid">
        <div className="blast-controls">
          <div className="primer-row" style={{ alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <span className="tag-label">表示</span>
            <label>
              <input
                type="radio"
                name="blast-or-view"
                checked={settings.viewMode === "dna"}
                onChange={() => setSettings((prev) => ({ ...prev, viewMode: "dna" }))}
                disabled={loading}
              />{" "}
              塩基（DNA）
            </label>
            <label>
              <input
                type="radio"
                name="blast-or-view"
                checked={settings.viewMode === "protein"}
                onChange={() => setSettings((prev) => ({ ...prev, viewMode: "protein" }))}
                disabled={loading}
              />{" "}
              タンパク（CDS翻訳）
            </label>
            <span className="seq-hint">※ BLAST 自体は常に blastn（塩基）です。</span>
          </div>

          <label className="seq-label">
            クエリ（DNA, FASTA 可）:
            <textarea
              className="seq-textarea"
              rows={6}
              placeholder=">query\nATGC..."
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              disabled={loading}
            />
          </label>
          {queryEntries.length > 1 ? (
            <label className="seq-label">
              FASTAエントリ選択:
              <select
                className="seq-input"
                value={selectedQueryEntry?.id || ""}
                onChange={(e) => setSelectedQueryId(e.target.value)}
                disabled={loading}
              >
                {selectableQueryEntries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.header.slice(0, 80)} ({e.length.toLocaleString()} bp)
                  </option>
                ))}
              </select>
              <span className="seq-hint">
                入力に複数の FASTA が含まれています（DNA と判定した {dnaQueryEntries.length} 件を優先して候補に出します）。
              </span>
            </label>
          ) : null}

          <label className="seq-label">
            ローカルDB:
            <select
              className="seq-input"
              value={settings.dbChoice}
              onChange={(e) => setSettings((prev) => ({ ...prev, dbChoice: e.target.value }))}
              disabled={loading}
            >
              {localDbOptionsWithCustom.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {settings.dbChoice === CUSTOM_DB_VALUE && (
              <input
                className="seq-input"
                type="text"
                placeholder="/path/to/makeblastdb_prefix"
                value={settings.dbCustom}
                onChange={(e) => setSettings((prev) => ({ ...prev, dbCustom: e.target.value }))}
                disabled={loading}
                style={{ marginTop: "0.35rem" }}
              />
            )}
            <span className="seq-hint">
              選択中: <code className="tag-db">{resolvedDbLabel}</code>
            </span>
            {dbLoading ? <span className="seq-hint">DB 一覧を取得中...</span> : null}
            {dbError ? <span className="seq-hint">DB 一覧エラー: {dbError}</span> : null}
          </label>

          <details className="ui-details" style={{ marginTop: "0.35rem" }}>
            <summary>クエリ注釈（GFF3 から exon/CDS を推定）</summary>
            <div className="ui-details-body">
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                <input
                  type="checkbox"
                  checked={settings.queryAnnotEnabled}
                  onChange={(e) => setSettings((prev) => ({ ...prev, queryAnnotEnabled: e.target.checked }))}
                  disabled={loading}
                />
                <span className="seq-hint">クエリ配列が exon/CDS 上かどうかを色分けします（別ゲノムDBへ 1 回 BLAST します）。</span>
              </label>

              <label className="seq-label">
                クエリ側ゲノムDB:
                <select
                  className="seq-input"
                  value={settings.queryAnnotDbChoice}
                  onChange={(e) => setSettings((prev) => ({ ...prev, queryAnnotDbChoice: e.target.value }))}
                  disabled={loading}
                >
                  {queryAnnotDbOptionsWithCustom.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {settings.queryAnnotDbChoice === CUSTOM_DB_VALUE && (
                  <input
                    className="seq-input"
                    type="text"
                    placeholder="/path/to/makeblastdb_prefix"
                    value={settings.queryAnnotDbCustom}
                    onChange={(e) => setSettings((prev) => ({ ...prev, queryAnnotDbCustom: e.target.value }))}
                    disabled={loading}
                    style={{ marginTop: "0.35rem" }}
                  />
                )}
                <span className="seq-hint">
                  選択中: <code className="tag-db">{queryAnnotResolvedDbLabel}</code>
                </span>
                {settings.queryAnnotEnabled && !normalizedQuery ? <span className="seq-hint">BLAST-OR 実行後に注釈します。</span> : null}
                {settings.queryAnnotEnabled && queryGeneModelLoading ? <span className="seq-hint">クエリ注釈: 解析中...</span> : null}
                {settings.queryAnnotEnabled && queryGeneModelLoading ? (
                  <JobProgressCard
                    title="クエリ注釈 BLAST"
                    jobId={queryAnnotJobId}
                    job={queryAnnotJobInfo}
                    onCancel={queryAnnotJobId ? cancelQueryAnnotJob : null}
                    cancelDisabled={!queryAnnotJobId}
                  />
                ) : null}
                {settings.queryAnnotEnabled && queryGeneModelError ? <span className="seq-hint">クエリ注釈エラー: {queryGeneModelError}</span> : null}
                {settings.queryAnnotEnabled && queryAnnotRegion ? (
                  <span className="seq-hint">
                    マッピング: <b>{queryAnnotRegion.entry}</b>{" "}
                    {queryAnnotRegion.start}
                    {queryAnnotRegion.strand === "plus" ? "→" : "←"}
                    {queryAnnotRegion.end} {queryAnnotRegion.strand === "plus" ? "(+)" : "(-)"}
                    {queryAnnotRegion.hsps > 1 ? `（HSP ${queryAnnotRegion.hsps}）` : ""}
                  </span>
                ) : null}
              </label>
            </div>
          </details>

          <div className="primer-row" style={{ alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <span className="tag-label">ローカルモード</span>
            <span className="seq-hint">CPU</span>
          </div>

          <div className="primer-row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
            <label className="seq-label" style={{ flex: "1 1 220px" }}>
              task:
              <select
                className="seq-input"
                value={settings.task}
                onChange={(e) => setSettings((prev) => ({ ...prev, task: e.target.value }))}
                disabled={loading}
              >
                <option value="megablast">megablast（推奨）</option>
                <option value="blastn">blastn</option>
                <option value="dc-megablast">dc-megablast</option>
                <option value="blastn-short">blastn-short</option>
              </select>
            </label>
            <label className="seq-label" style={{ flex: "1 1 160px" }}>
              max hits:
              <input
                className="seq-input"
                type="number"
                min={1}
                max={100}
                value={settings.maxHits}
                onChange={(e) => setSettings((prev) => ({ ...prev, maxHits: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))}
                disabled={loading}
              />
            </label>
            <label className="seq-label" style={{ flex: "1 1 160px" }}>
              line bp:
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.15rem" }}>
                <input
                  type="checkbox"
                  checked={settings.autoLineWidth}
                  onChange={(e) => setSettings((prev) => ({ ...prev, autoLineWidth: e.target.checked }))}
                  disabled={loading}
                />
                <span className="seq-hint">横幅にフィット（FHD想定）</span>
              </label>
              <input
                className="seq-input"
                type="number"
                min={MIN_ALIGN_WIDTH}
                max={MAX_ALIGN_WIDTH}
                value={settings.lineWidth}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    lineWidth: Math.max(MIN_ALIGN_WIDTH, Math.min(MAX_ALIGN_WIDTH, Number(e.target.value) || defaultAlignWidth())),
                  }))
                }
                disabled={loading || settings.autoLineWidth}
              />
              <span className="seq-hint">
                手動の場合は {MIN_ALIGN_WIDTH}–{MAX_ALIGN_WIDTH}bp/行（デフォルト {defaultAlignWidth()}）
              </span>
            </label>
            <label className="seq-label" style={{ flex: "1 1 180px" }}>
              evalue:
              <input
                className="seq-input"
                type="number"
                step="any"
                value={settings.evalue}
                onChange={(e) => setSettings((prev) => ({ ...prev, evalue: Number(e.target.value) || 1e-5 }))}
                disabled={loading}
              />
            </label>
          </div>

          <button type="button" className="seq-button" onClick={handleRun} disabled={loading}>
            {loading ? "BLAST 実行中..." : "BLAST-OR を実行する"}
          </button>
          <JobProgressCard
            title="BLAST-OR"
            jobId={blastJobId}
            job={blastJobInfo}
            onCancel={blastJobId ? cancelBlastJob : null}
            cancelDisabled={!blastJobId}
          />

          {error ? <p className="seq-error">エラー: {error}</p> : null}
        </div>

        <div className="blast-results">
          {normalizedQuery ? (
            <p className="blast-summary">
              query length: <b>{normalizedQuery.length.toLocaleString()}</b> bp / DB: <b>{resolvedDbLabel}</b>
            </p>
          ) : null}

          {result ? (
            <>
              <p className="blast-summary">
                hits: <b>{result.num_hits.toLocaleString()}</b>
              </p>

                {result.hits?.length ? (
                <div className="blast-table-block">
                  <h3>Hits（クリックでアラインメント表示）</h3>
                  <div className="table-scroll">
                    <table className="seq-table blast-or-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>subject</th>
                          <th>%id</th>
                          <th>len</th>
                          <th>evalue</th>
                          <th>bits</th>
                          <th>subject range</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.hits.map((h, idx) => {
                          const subj = splitIdAndDesc(h.sseqid);
                          const isSelected = idx === selectedIndex;
                          return (
                            <tr
                              key={`${h.qseqid}-${h.sseqid}-${idx}`}
                              className={isSelected ? "is-selected" : ""}
                              onClick={() => setSelectedIndex(idx)}
                            >
                              <td style={{ textAlign: "left" }}>{idx + 1}</td>
                              <td style={{ textAlign: "left" }}>
                                <span className="blast-id">{subj.id}</span>
                              </td>
                              <td>{h.pident.toFixed(1)}</td>
                              <td>{h.length}</td>
                              <td>{h.evalue.toExponential(2)}</td>
                              <td>{h.bitscore.toFixed(1)}</td>
                              <td>{h.sstart}–{h.send}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="seq-hint">ヒットがありません。</p>
              )}

              {selectedHit ? (
                <>
                  {geneModel?.genes?.length && geneModel.genes.length > 1 ? (
                    <div className="primer-row" style={{ alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span className="seq-hint">subject gene:</span>
                      <select
                        className="seq-input"
                        style={{ maxWidth: "100%" }}
                        value={String(selectedGeneIndex)}
                        onChange={(e) => setSelectedGeneIndex(Number(e.target.value) || 0)}
                        disabled={geneModelLoading}
                      >
                        {geneModel.genes.map((g, idx) => (
                          <option key={`${g.gene_id}-${idx}`} value={String(idx)}>
                            {g.gene_name || g.gene_id} ({g.gene_id})
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {settings.queryAnnotEnabled && queryGeneModel?.genes?.length && queryGeneModel.genes.length > 1 ? (
                    <div className="primer-row" style={{ alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span className="seq-hint">query gene:</span>
                      <select
                        className="seq-input"
                        style={{ maxWidth: "100%" }}
                        value={String(selectedQueryGeneIndex)}
                        onChange={(e) => setSelectedQueryGeneIndex(Number(e.target.value) || 0)}
                        disabled={queryGeneModelLoading}
                      >
                        {queryGeneModel.genes.map((g, idx) => (
                          <option key={`${g.gene_id}-${idx}`} value={String(idx)}>
                            {g.gene_name || g.gene_id} ({g.gene_id})
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  <AlignmentViewer
                    db={resolvedDb}
                    hit={selectedHit}
                    lineWidth={settings.lineWidth}
                    autoLineWidth={settings.autoLineWidth}
                    viewMode={settings.viewMode}
                    subjectGene={selectedGene}
                    subjectGeneLoading={geneModelLoading}
                    subjectGeneError={geneModelError}
                    queryGene={settings.queryAnnotEnabled ? selectedQueryGene : null}
                    queryGeneLoading={settings.queryAnnotEnabled ? queryGeneModelLoading : false}
                    queryGeneError={settings.queryAnnotEnabled ? queryGeneModelError : null}
                    queryPosToGenomePos={settings.queryAnnotEnabled ? queryPosToGenomePos : null}
                    queryAnnotationEnabled={settings.queryAnnotEnabled}
                    queryAnnotRegion={settings.queryAnnotEnabled ? queryAnnotRegion : null}
                  />
                </>
              ) : null}
            </>
          ) : (
            <p className="seq-hint">結果はここに表示されます。</p>
          )}
        </div>
      </div>
    </section>
  );
};
