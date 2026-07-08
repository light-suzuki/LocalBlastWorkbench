import React from "react";

const BlastPanel = React.lazy(async () => ({ default: (await import("./components/BlastPanel")).BlastPanel }));
const BlastOrPanel = React.lazy(async () => ({ default: (await import("./components/BlastOrPanel")).BlastOrPanel }));
const DbManagerPanel = React.lazy(async () => ({ default: (await import("./components/DbManagerPanel")).DbManagerPanel }));

export const productName = "Local BLAST Workbench";
export const focusedTabs = [
  { id: "blast", labelJa: "BLAST", labelEn: "BLAST", descriptionJa: "登録したローカルDBを検索", descriptionEn: "Search registered local databases", color: "#2563eb", Component: BlastPanel },
  { id: "blast_or", labelJa: "BLAST-OR", labelEn: "BLAST-OR", descriptionJa: "アラインメントとミスマッチを確認", descriptionEn: "Inspect alignments and mismatches", color: "#dc2626", Component: BlastOrPanel },
  { id: "db_manage", labelJa: "DB管理", labelEn: "DB Manager", descriptionJa: "BLAST DBを登録・確認", descriptionEn: "Register and inspect BLAST databases", color: "#64748b", Component: DbManagerPanel },
] as const;

