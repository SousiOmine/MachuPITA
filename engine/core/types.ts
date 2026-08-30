export interface TextItemBox {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontName: string;
  rotation: number;
}

export interface LineBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baselineY: number;
  text: string;
  fontSize: number;
  bold: boolean;
  /** 行内大ギャップで分割したセル(著者グリッド・表・数式など)。セルは単独ブロック扱い */
  cells?: LineBox[];
}

export type BlockKind = "body" | "heading" | "nontranslatable";

export interface Block {
  id: string;
  page: number;
  columnIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 先頭行のベースライン(PDF座標)。単一行ブロックの描画位置を原文に一致させる */
  baselineY?: number;
  text: string;
  originalText: string;
  translation?: string;
  status: "pending" | "translated" | "skipped" | "failed";
  fontSize: number;
  bold: boolean;
  centered: boolean;
  kind: BlockKind;
  warnings?: string[];
  protectedTokens?: string[];
}

export interface PageLayout {
  pageNumber: number;
  width: number;
  height: number;
  blocks: Block[];
}

export interface ExtractedPage {
  pageNumber: number;
  width: number;
  height: number;
  items: TextItemBox[];
}

export interface TokenUsageTotals {
  input: number;
  output: number;
  total: number;
  costTotal: number;
}
