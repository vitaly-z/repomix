import type { RepomixConfigMerged } from '../../config/configSchema.js';
import { logger } from '../../shared/logger.js';
import type { SupportedLang } from './lang2Query.js';
import { LanguageParser } from './languageParser.js';

// シングルトンインスタンスの管理
let languageParserSingleton: LanguageParser | null = null;

const getLanguageParserSingleton = async () => {
  if (!languageParserSingleton) {
    languageParserSingleton = new LanguageParser();
    await languageParserSingleton.init();
  }
  return languageParserSingleton;
};

/**
 * チャンクを正規化する
 */
function normalizeChunk(chunk: string): string {
  return chunk.trim();
}

/**
 * 定義とコメントを完全に取得するための改良版parseFile関数
 * - コメントを完全に含む
 * - 型定義（interface, type, enum）を完全に含む
 * - import文を含む
 * - 関数・メソッドのシグネチャを改行を含めて完全に取得
 */
export const parseFile = async (fileContent: string, filePath: string, config: RepomixConfigMerged) => {
  const languageParser = await getLanguageParserSingleton();

  // ファイル内容を行に分割
  const lines = fileContent.split('\n');
  if (lines.length < 1) {
    return '';
  }

  const lang: SupportedLang | undefined = languageParser.guessTheLang(filePath);
  if (lang === undefined) {
    return undefined;
  }

  const query = await languageParser.getQueryForLang(lang);
  const parser = await languageParser.getParserForLang(lang);
  const processedChunks = new Set<string>();
  const chunks = [];

  try {
    // ファイル内容をASTに解析
    const tree = parser.parse(fileContent);

    // クエリをASTに適用してキャプチャを取得
    const captures = query.captures(tree.rootNode);

    // キャプチャを開始位置でソート
    captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row);

    for (const capture of captures) {
      const { node, name } = capture;

      // 開始行と終了行を取得
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;

      if (!lines[startRow]) {
        continue;
      }

      // キャプチャの種類を判定
      const isCommentCapture = name.includes('definition.comment');
      const isTypeDefinitionCapture = 
        name.includes('definition.interface') ||
        name.includes('definition.type') ||
        name.includes('definition.enum') ||
        name.includes('definition.class');
      const isImportCapture = name.includes('definition.import');
      const isFunctionCapture = 
        name.includes('definition.function') ||
        name.includes('definition.method');
      const isPropertyCapture = name.includes('definition.property');

      // 完全キャプチャ（コメント、型定義、インポート、プロパティ）
      const isFullCapture = 
        isCommentCapture ||
        isTypeDefinitionCapture ||
        isImportCapture ||
        isPropertyCapture;

      // シグネチャのみキャプチャ（関数・メソッド）
      if (isFullCapture || isFunctionCapture) {
        let selectedLines;

        if (isFunctionCapture) {
          // 関数・メソッドの場合は、シグネチャ部分のみ抽出
          // シグネチャの終了位置を探す
          let signatureEnd = startRow;
          for (let i = startRow; i <= endRow; i++) {
            const line = lines[i].trim();
            
            // シグネチャの終了を検出（言語に依存しない形で）
            if (line.endsWith(':') || // Python
                line.endsWith('=>') || // Arrow function
                line.endsWith('->') || // Rust, PHP
                /[{;]/.test(line)) { // C-like languages
              signatureEnd = i;
              break;
            }
          }

          // シグネチャ部分を取得（関数名から実装開始までの行）
          selectedLines = lines.slice(startRow, signatureEnd + 1);
          
          // シグネチャ末尾の処理
          const lastLine = selectedLines[selectedLines.length - 1];
          if (lastLine) {
            if (lastLine.includes('{')) {
              const modifiedLine = lastLine.replace(/\{.*/, '{ ... }');
              selectedLines[selectedLines.length - 1] = modifiedLine;
            } else if (lastLine.includes('=>')) {
              const modifiedLine = lastLine.replace(/=>.*/, '=> { ... }');
              selectedLines[selectedLines.length - 1] = modifiedLine;
            }
          }
        } else {
          // コメント、型定義、インポート、プロパティは全体を取得
          selectedLines = lines.slice(startRow, endRow + 1);
        }

        if (selectedLines.length > 0) {
          const chunk = selectedLines.join('\n').trim();
          if (!processedChunks.has(chunk)) {
            processedChunks.add(chunk);
            chunks.push(chunk);
          }
        }
      }
    }
  } catch (error: unknown) {
    logger.log(`Error parsing file: ${error}\n`);
  }

  return chunks.join('\n\n');
};
