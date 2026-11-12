import type { Rgb } from "./visibility.ts";

export interface TextItemBox {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontName: string;
  /**
   * フォント自体が持つ太字フラグ(PDF のフォントディスクリプタ由来)。
   * 判定できなかった場合は undefined で、フォント名からの推定に委ねる。
   */
  bold?: boolean;
  rotation: number;
  /** 元テキストの文字色(0..1)。取得できなかった場合は undefined。 */
  color?: Rgb;
  /** 元テキストの背後の塗り色。取得できなかった場合は undefined。 */
  backgroundColor?: Rgb;
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
  /** 元テキストの文字色(行内で最頻の色) */
  color?: Rgb;
  /** 元テキストの背後の塗り色 */
  backgroundColor?: Rgb;
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
  /** 元テキストの文字色(再描画時に継承する) */
  color?: Rgb;
  /** 元テキストの背後の塗り色(マスク色に使う) */
  backgroundColor?: Rgb;
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
