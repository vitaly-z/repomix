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
 * RepoMapを参考にした改良版parseFile関数
 * - 定義（クラス、関数、変数など）全体を取得
 * - コメントを含める
 * - import文を含める
 * - 型定義全体を含める
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
    // 言語がサポートされていない
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

    // インターフェースと関数定義を区別して処理
    for (const capture of captures) {
      const { node, name } = capture;

      // 開始行と終了行を取得
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;

      if (!lines[startRow]) {
        continue;
      }

      // インターフェース、型定義、インポート、コメントは完全にキャプチャ
      const isFullCapture =
        name.includes('definition.interface') ||
        name.includes('definition.type') ||
        name.includes('definition.import') ||
        name.includes('definition.comment') ||
        name.includes('definition.enum') ||
        name.includes('definition.property');

      // 関数定義とメソッドはシグネチャのみをキャプチャ（実装は含まない）
      const isSignatureCapture =
        name.includes('definition.function.signature') ||
        name.includes('definition.method.signature');

      // クラス宣言はクラス名とプロパティのみをキャプチャ
      const isClassCapture = name.includes('definition.class');

      // 定義に関連するキャプチャのみを処理
      if ((isFullCapture || isSignatureCapture || isClassCapture || name.includes('name.definition')) && lines[startRow]) {
        let selectedLines;

        if (isSignatureCapture) {
          // 関数やメソッドのシグネチャのみをキャプチャ（実装部分は含まない）
          // ボディの開始位置（最初の{ まで）を探す
          let bodyStart = -1;
          for (let i = startRow; i <= endRow; i++) {
            if (lines[i].includes('{')) {
              bodyStart = i;
              break;
            }
          }

          if (bodyStart !== -1) {
            // シグネチャ部分のみを含める（ボディの開始位置まで）
            selectedLines = lines.slice(startRow, bodyStart + 1);
            // 実装部分を除去（最初の { で閉じる）
            const lastLine = selectedLines[selectedLines.length - 1];
            const braceIndex = lastLine.indexOf('{');
            if (braceIndex !== -1) {
              selectedLines[selectedLines.length - 1] = lastLine.substring(0, braceIndex + 1) + ' ... }';
            }
          } else {
            // ボディがない場合（アロー関数などのシンプルな場合）
            selectedLines = lines.slice(startRow, endRow + 1);
          }
        } else if (isFullCapture) {
          // インターフェースや型定義は完全にキャプチャ
          selectedLines = lines.slice(startRow, endRow + 1);
        } else if (isClassCapture) {
          // クラス宣言はクラス名とプロパティのみをキャプチャ（メソッド実装は含まない）
          // クラス宣言の開始部分のみを抽出
          let classBodyStart = -1;
          for (let i = startRow; i <= endRow; i++) {
            if (lines[i].includes('{')) {
              classBodyStart = i;
              break;
            }
          }

          if (classBodyStart !== -1) {
            // クラスシグネチャとプロパティ部分のみを含める
            selectedLines = lines.slice(startRow, classBodyStart + 1);
            // 最後に閉じ括弧を追加
            selectedLines.push('  ... }');
          } else {
            selectedLines = lines.slice(startRow, endRow + 1);
          }
        } else {
          // その他の定義関連要素は全体をキャプチャ
          selectedLines = lines.slice(startRow, endRow + 1);
        }

        if (selectedLines.length < 1) {
          continue;
        }

        const chunk = selectedLines.join('\n');
        const normalizedChunk = normalizeChunk(chunk);

        if (!processedChunks.has(normalizedChunk)) {
          processedChunks.add(normalizedChunk);
          chunks.push(chunk);
        }
      }
    }
  } catch (error: unknown) {
    logger.log(`Error parsing file: ${error}\n`);
  }

  return chunks.join('\n');
};
