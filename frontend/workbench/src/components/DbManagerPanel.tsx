import React, { useEffect, useMemo, useState } from "react";
import type { BlastDbChromosome, BlastDbEntrySearchHit } from "../types/blast";
import { bioapiClient } from "../api/bioapiClient";
import {
  FALLBACK_LOCAL_DB_OPTIONS,
  query_TO_ref_VIRTUAL_DB_LABEL,
  query_TO_ref_VIRTUAL_DB_VALUE,
  labelForDbPath,
  useLocalBlastDbOptions,
  usePreferredLocalDbPaths,
  withqueryTorefVirtualDbOption,
} from "../utils/localBlastDbs";
import { useToast } from "./ToastProvider";
import { pollJobUntilDone } from "../utils/jobPolling";
import type { JobInfo } from "../types/jobs";
import { JobProgressCard } from "./JobProgressCard";
import { dbManagerClient } from "../api/dbManagerClient";
import type { DbRegistryItem } from "../types/dbManager";
import { DOWNLOAD_PRESETS } from "../config/referencePresets";

const isVirtualDbValue = (value: string) => value === query_TO_ref_VIRTUAL_DB_VALUE;

export const DbManagerPanel: React.FC = () => {
  const { showToast } = useToast();
  const { options, loading, error, refresh } = useLocalBlastDbOptions();
  const optionsWithVirtual = useMemo(
    () => withqueryTorefVirtualDbOption(options),
    [options],
  );

  const [preferred, setPreferred, resetPreferred] = usePreferredLocalDbPaths();
  const preferredSet = useMemo(() => new Set(preferred), [preferred]);

  const firstRealDb = useMemo(() => {
    const preferredReal = preferred.find((p) => p && !isVirtualDbValue(p));
    if (preferredReal) return preferredReal;
    return options[0]?.value ?? FALLBACK_LOCAL_DB_OPTIONS[0]?.value ?? "";
  }, [options, preferred]);

  const [activeDb, setActiveDb] = useState<string>(firstRealDb);
  const [chromosomes, setChromosomes] = useState<BlastDbChromosome[] | null>(null);
  const [chromLoading, setChromLoading] = useState<boolean>(false);
  const [chromJobId, setChromJobId] = useState<string | null>(null);
  const [chromJobInfo, setChromJobInfo] = useState<JobInfo | null>(null);
  const [chromRefDb, setChromRefDb] = useState<string>("UserDB_ref");

  const [entryQuery, setEntryQuery] = useState<string>("");
  const [entryHits, setEntryHits] = useState<BlastDbEntrySearchHit[] | null>(null);
  const [entryLoading, setEntryLoading] = useState<boolean>(false);

  // DB Manager State
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [downloadName, setDownloadName] = useState<string>("");
  const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
  const [downloadJobInfo, setDownloadJobInfo] = useState<JobInfo | null>(null);
  const [registryItems, setRegistryItems] = useState<DbRegistryItem[]>([]);
  const [registryLoading, setRegistryLoading] = useState<boolean>(false);

  const fetchRegistry = async () => {
    try {
      setRegistryLoading(true);
      const items = await dbManagerClient.listDbs();
      setRegistryItems(items);
    } catch (e) {
      console.error(e);
    } finally {
      setRegistryLoading(false);
    }
  };

  useEffect(() => {
    void fetchRegistry();
  }, []);

  const handleDownload = async () => {
    if (!downloadUrl || !downloadName) {
      showToast("URLと名前を入力してください", "error");
      return;
    }
    setDownloadJobInfo(null);
    setDownloadJobId(null);
    try {
      const res = await dbManagerClient.downloadDb({
        url: downloadUrl,
        name: downloadName,
        db_type: "nucl"
      });
      setDownloadJobId(res.job_id);
      showToast("ダウンロードを開始しました", "success");

      await pollJobUntilDone(res.job_id, {
        onUpdate: (info) => setDownloadJobInfo(info),
        intervalMs: 1000
      });
      showToast("DB構築完了", "success");
      void fetchRegistry();
      void refresh(); // Refresh local blast options
    } catch (e) {
      showToast(e instanceof Error ? e.message : "ダウンロードに失敗しました", "error");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`本当にDB ${id} を削除しますか？`)) return;
    try {
      await dbManagerClient.deleteDb(id);
      showToast("削除しました", "success");
      void fetchRegistry();
      void refresh();
    } catch (e) {
      showToast("削除に失敗しました", "error");
    }
  };

  const handleIndexExisting = async () => {
    try {
      const res = await dbManagerClient.indexExisting();
      showToast(`${res.added} 件の既存DBを登録しました`, "success");
      void fetchRegistry();
    } catch (e) {
      showToast("インデックスに失敗しました", "error");
    }
  };

  useEffect(() => {
    setActiveDb(firstRealDb);
  }, [firstRealDb]);

  useEffect(() => {
    const db = (activeDb || "").trim();
    if (!db) {
      setChromosomes(null);
      return;
    }
    let cancelled = false;
    setChromLoading(true);
    bioapiClient
      .listDbChromosomes(db)
      .then((rows) => {
        if (cancelled) return;
        setChromosomes(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setChromosomes(null);
      })
      .finally(() => {
        if (cancelled) return;
        setChromLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDb]);

  useEffect(() => {
    const hasref = options.some((o) => o.value === "UserDB_ref");
    const hasALT = options.some((o) => o.value === "UserDB_ALT");
    if (hasref) setChromRefDb((prev) => prev || "UserDB_ref");
    else if (hasALT) setChromRefDb((prev) => prev || "UserDB_ALT");
    else if (options[0]?.value) setChromRefDb((prev) => prev || options[0].value);
  }, [options]);

  const buildChromAliases = async () => {
    const db = (activeDb || "").trim();
    const ref = (chromRefDb || "").trim();
    if (!db) return;
    setChromJobId(null);
    setChromJobInfo(null);
    try {
      const job = await bioapiClient.createBuildChromAliasesJob({
        db,
        ref_db: ref || "UserDB_ref",
      });
      setChromJobId(job.job_id);
      const info = await pollJobUntilDone(job.job_id, {
        onUpdate: (i) => setChromJobInfo(i),
        intervalMs: 900,
      });
      if (info.status !== "succeeded") {
        throw new Error(info.error ?? "染色体推定に失敗しました。");
      }
      const rows = await bioapiClient.listDbChromosomes(db);
      setChromosomes(rows);
      showToast("染色体（chr→entry）推定が完了しました", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "染色体推定に失敗しました。";
      showToast(msg, "error");
    } finally {
      setChromJobId(null);
      setChromJobInfo(null);
    }
  };

  const togglePreferred = (value: string) => {
    setPreferred((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const copyText = async (text: string, label: string) => {
    const t = (text || "").trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      showToast(`${label} をコピーしました`, "success");
    } catch {
      showToast(`${label} のコピーに失敗しました`, "error");
    }
  };

  const runEntrySearch = async () => {
    const db = (activeDb || "").trim();
    const q = entryQuery.trim();
    if (!db || !q) return;
    setEntryLoading(true);
    try {
      const hits = await bioapiClient.searchDbEntries(db, q, 50);
      setEntryHits(hits);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "entry 検索に失敗しました。";
      showToast(msg, "error");
      setEntryHits(null);
    } finally {
      setEntryLoading(false);
    }
  };

  const unknownPreferred = useMemo(() => {
    const known = new Set(optionsWithVirtual.map((o) => o.value));
    return preferred.filter((p) => p && !known.has(p));
  }, [optionsWithVirtual, preferred]);

  return (
    <div>
      <h2 className="panel-title">DB 管理</h2>
      <p className="panel-hint">
        ローカル BLAST DB の一覧・既定セット・染色体（chr→entry）・entry検索をまとめて確認できます。
      </p>

      <details className="ui-details" open>
        <summary>DB ダウンロード & 管理</summary>
        <div className="ui-details-body">
          <div className="primer-row" style={{ alignItems: "flex-end", borderBottom: "1px solid #eee", paddingBottom: "0.8rem", marginBottom: "0.8rem" }}>
            <label className="seq-label" style={{ width: "auto" }}>
              プリセットから選択:
              <select
                className="seq-input"
                onChange={(e) => {
                  const p = DOWNLOAD_PRESETS[e.target.selectedIndex];
                  if (p) {
                    setDownloadUrl(p.url);
                    setDownloadName(p.name);
                  }
                }}
              >
                {DOWNLOAD_PRESETS.map((p, i) => (
                  <option key={i} value={p.url}>{p.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="primer-row">
            <label className="seq-label">
              URL (gzip対応):
              <input
                className="seq-input"
                value={downloadUrl}
                onChange={(e) => setDownloadUrl(e.target.value)}
                placeholder="https://..."
              />
            </label>
            <label className="seq-label" style={{ width: "200px" }}>
              名前 (ID):
              <input
                className="seq-input"
                value={downloadName}
                onChange={(e) => setDownloadName(e.target.value)}
                placeholder="my_genome_v1"
              />
            </label>
            <button
              type="button"
              className="seq-button"
              onClick={() => void handleDownload()}
              disabled={!downloadUrl || !downloadName}
            >
              ダウンロード & 構築
            </button>
          </div>
          <JobProgressCard title="DB構築" jobId={downloadJobId} job={downloadJobInfo} />

          <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #ddd" }} />

          <div className="primer-row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <h4 style={{ margin: 0 }}>登録済み DB (Registry)</h4>
            <button
              type="button"
              className="seq-button secondary"
              onClick={() => void handleIndexExisting()}
            >
              既存フォルダからインデックス再構築
            </button>
          </div>

          <div className="table-scroll" style={{ maxHeight: "200px", marginTop: "0.5rem" }}>
            <table className="seq-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {registryItems.length ? (
                  registryItems.map((item) => (
                    <tr key={item.id}>
                      <td>{item.id}</td>
                      <td>{item.name}</td>
                      <td>{item.db_type}</td>
                      <td>{item.created_at.split("T")[0]}</td>
                      <td>
                        <button
                          type="button"
                          className="seq-button secondary"
                          style={{ color: "#d32f2f", borderColor: "#ef9a9a" }}
                          onClick={() => void handleDelete(item.id)}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", padding: "1rem" }}>
                      データがありません。「インデックス再構築」を試してください。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <details className="ui-details" open>
        <summary>ローカル BLAST DB 一覧</summary>
        <div className="ui-details-body">
          <div className="primer-row" style={{ alignItems: "center" }}>
            <button
              type="button"
              className="seq-button secondary"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? "更新中..." : "再読み込み"}
            </button>
            {error ? <span className="seq-error">エラー: {error}</span> : null}
          </div>

          <div className="table-scroll" style={{ marginTop: "0.4rem" }}>
            <table className="seq-table">
              <thead>
                <tr>
                  <th>label</th>
                  <th>path</th>
                  <th>FASTA</th>
                  <th>注釈</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {options.length ? (
                  options.map((o) => (
                    <tr key={o.value}>
                      <td>{o.label}</td>
                      <td style={{ textAlign: "left" }}>
                        <code style={{ fontSize: "0.85em" }}>{o.path ?? "-"}</code>
                      </td>
                      <td>{o.hasFasta ? "✓" : "-"}</td>
                      <td>{o.hasAnnotation ? "✓" : "-"}</td>
                      <td>
                        <div className="primer-row" style={{ justifyContent: "flex-start" }}>
                          <button
                            type="button"
                            className="seq-button secondary"
                            onClick={() => void copyText(o.path ?? o.value, "パス")}
                          >
                            コピー
                          </button>
                          <button
                            type="button"
                            className="seq-button secondary"
                            onClick={() => setActiveDb(o.value)}
                          >
                            開く
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "left" }}>
                      <span className="seq-hint">
                        DB が見つかりませんでした（`~/sequence_workbench_databases/*.nsq` を確認してください）。
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <details className="ui-details" style={{ marginTop: "0.6rem" }} open>
        <summary>既定の DB セット（他タブの初期値）</summary>
        <div className="ui-details-body">
          <p className="seq-hint">
            ここで選んだ DB は、BLAST / Primer 逆引き / CDS/エキソン増幅 などの「DB 初期選択」に反映されます。
          </p>

          <div className="primer-row" style={{ flexWrap: "wrap" }}>
            {optionsWithVirtual.map((o) => (
              <label key={o.value} className="seq-hint" style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={preferredSet.has(o.value)}
                  onChange={() => togglePreferred(o.value)}
                />
                {o.value === query_TO_ref_VIRTUAL_DB_VALUE ? query_TO_ref_VIRTUAL_DB_LABEL : o.label}
              </label>
            ))}
          </div>

          {unknownPreferred.length ? (
            <div style={{ marginTop: "0.35rem" }}>
              <p className="seq-hint">保存済み（一覧にないパス）:</p>
              <ul className="seq-hint" style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {unknownPreferred.map((p) => (
                  <li key={p}>
                    <code style={{ fontSize: "0.86em" }}>{p}</code>{" "}
                    <button
                      type="button"
                      className="seq-button secondary"
                      onClick={() => setPreferred((prev) => prev.filter((v) => v !== p))}
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="primer-row" style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="seq-button secondary"
              onClick={resetPreferred}
            >
              おすすめ（ref/ALT/query）に戻す
            </button>
            <button
              type="button"
              className="seq-button secondary"
              onClick={() => void copyText(preferred.join("\n"), "既定DBセット")}
              disabled={preferred.length === 0}
            >
              選択をコピー
            </button>
          </div>
        </div>
      </details>

      <details className="ui-details" style={{ marginTop: "0.6rem" }} open>
        <summary>DB を試す（chr/entry）</summary>
        <div className="ui-details-body">
          <label className="seq-label">
            対象 DB:
            <select
              className="seq-input"
              value={activeDb}
              onChange={(e) => setActiveDb(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="primer-row" style={{ alignItems: "center" }}>
            <span className="seq-hint">
              entry: <code>{activeDb ? labelForDbPath(activeDb, options) : "-"}</code>
            </span>
            {chromLoading ? <span className="seq-hint">chr 一覧を取得中...</span> : null}
          </div>

          {!chromLoading && (chromosomes?.length ?? 0) === 0 ? (
            <div style={{ marginTop: "0.25rem" }}>
              <span className="seq-hint">
                chr→entry が推定できないDBは、ref/ALT を参照して best-effort で chr→entry を推定できます（結果はキャッシュされます）。
              </span>
              <div className="primer-row" style={{ alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                <label className="seq-hint" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  参照DB:
                  <select
                    className="seq-input"
                    value={chromRefDb}
                    onChange={(e) => setChromRefDb(e.target.value)}
                    style={{ width: "auto", minWidth: "12rem" }}
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="seq-button secondary" onClick={() => void buildChromAliases()}>
                  染色体（chr→entry）を推定する
                </button>
              </div>
              <JobProgressCard title="染色体推定" jobId={chromJobId} job={chromJobInfo} />
            </div>
          ) : null}

          <div className="table-scroll" style={{ marginTop: "0.35rem" }}>
            <table className="seq-table">
              <thead>
                <tr>
                  <th>chr</th>
                  <th>entry</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(chromosomes ?? []).length ? (
                  (chromosomes ?? []).map((row) => (
                    <tr key={`${row.chrom}|${row.entry}`}>
                      <td>{row.chrom}</td>
                      <td style={{ textAlign: "left" }}>
                        <code style={{ fontSize: "0.85em" }}>{row.entry}</code>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="seq-button secondary"
                          onClick={() => void copyText(row.entry, "entry")}
                        >
                          コピー
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} style={{ textAlign: "left" }}>
                      <span className="seq-hint">
                        {activeDb ? "chr→entry の対応が見つかりませんでした（DB により推定できない場合があります）。" : "DB を選択してください。"}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: "0.65rem" }}>
            <label className="seq-label">
              entry 検索（部分一致）:
              <input
                className="seq-input"
                type="text"
                value={entryQuery}
                onChange={(e) => setEntryQuery(e.target.value)}
                placeholder="例: chr1 / 1LG6 / NC_..."
              />
            </label>
            <div className="primer-row">
              <button
                type="button"
                className="seq-button secondary"
                onClick={() => void runEntrySearch()}
                disabled={entryLoading || !entryQuery.trim() || !activeDb}
              >
                {entryLoading ? "検索中..." : "検索"}
              </button>
              <button
                type="button"
                className="seq-button secondary"
                onClick={() => setEntryHits(null)}
                disabled={!entryHits}
              >
                クリア
              </button>
            </div>

            {entryHits && (
              <div className="table-scroll" style={{ marginTop: "0.35rem" }}>
                <table className="seq-table">
                  <thead>
                    <tr>
                      <th>entry</th>
                      <th>chr</th>
                      <th>len</th>
                      <th>title</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entryHits.length ? (
                      entryHits.map((h) => (
                        <tr key={`${h.entry}|${h.length ?? ""}`}>
                          <td style={{ textAlign: "left" }}>
                            <code style={{ fontSize: "0.85em" }}>{h.entry}</code>
                          </td>
                          <td>{h.chrom ?? "-"}</td>
                          <td>{h.length?.toLocaleString() ?? "-"}</td>
                          <td style={{ textAlign: "left" }}>{h.title ?? ""}</td>
                          <td>
                            <button
                              type="button"
                              className="seq-button secondary"
                              onClick={() => void copyText(h.entry, "entry")}
                            >
                              コピー
                            </button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} style={{ textAlign: "left" }}>
                          <span className="seq-hint">ヒットなし</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
};
