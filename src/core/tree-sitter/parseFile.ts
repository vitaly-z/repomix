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
    const captures = query.captures(tree.rootNode);
    captures.sort((a, b) => a.node.startPosition.row - b.node.startPosition.row);

    for (const capture of captures) {
      const { node, name } = capture;
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

      const isFullCapture = 
        isCommentCapture ||
        isTypeDefinitionCapture ||
        isImportCapture ||
        isPropertyCapture;

      if (isFullCapture || isFunctionCapture) {
        let selectedLines;

        if (isFunctionCapture) {
          // 関数・メソッドのシグネチャを取得
          let signatureEndRow = startRow;
          
          // 引数定義の終了位置を探す
          for (let i = startRow; i <= endRow; i++) {
            const line = lines[i].trim();
            if (line.includes(')') && (
                line.endsWith('{') || // C-like languages
                line.endsWith('=>') || // Arrow function
                line.endsWith('->') || // Rust, PHP
                line.endsWith(':') || // Python
                line.endsWith(';') // TypeScript interface method
            )) {
              signatureEndRow = i;
              break;
            }
          }

          selectedLines = lines.slice(startRow, signatureEndRow + 1);

          // シグネチャの末尾をトリム
          const lastLine = selectedLines[selectedLines.length - 1];
          if (lastLine) {
            selectedLines[selectedLines.length - 1] = lastLine.replace(/[{:].*$/, '');
          }

          // 重複を削除
          const signature = selectedLines.join('\n').trim();
          if (processedChunks.has(signature)) {
            continue;
          }
          processedChunks.add(signature);

        } else if (isTypeDefinitionCapture && name.includes('definition.class')) {
          // クラス定義の場合は、extends/implements句を含む行まで取得
          let classEndRow = startRow;
          
          for (let i = startRow; i <= endRow; i++) {
            const line = lines[i].trim();
            const hasClassDefinitionEnd = 
              line.includes('{') || // C-like languages
              line.endsWith(':'); // Python
            
            // extends/implementsを含む行までを取得
            if (line.includes('extends') || line.includes('implements')) {
              classEndRow = i;
            }
            
            // クラス定義の終了を検出したら終了
            if (hasClassDefinitionEnd) {
              if (i === startRow) {
                // 同じ行に { がある場合は、その行を含める
                classEndRow = i;
              }
              break;
            }
          }

          selectedLines = lines.slice(startRow, classEndRow + 1);
          
          // 最後の行から { 以降を削除
          const lastLine = selectedLines[selectedLines.length - 1];
          if (lastLine) {
            selectedLines[selectedLines.length - 1] = lastLine.replace(/\{.*$/, '').trim();
          }

          const definition = selectedLines.join('\n').trim();
          if (processedChunks.has(definition)) {
            continue;
          }
          processedChunks.add(definition);

        } else if (isTypeDefinitionCapture || isImportCapture) {
          // インターフェース、型定義、インポート文は全体を取得
          selectedLines = lines.slice(startRow, endRow + 1);
          const definition = selectedLines.join('\n').trim();
          if (processedChunks.has(definition)) {
            continue;
          }
          processedChunks.add(definition);

        } else if (isCommentCapture) {
          // コメントは全体を取得
          selectedLines = lines.slice(startRow, endRow + 1);
        }

        if (selectedLines && selectedLines.length > 0) {
          chunks.push(selectedLines.join('\n').trim());
        }
      }
    }
  } catch (error: unknown) {
    logger.log(`Error parsing file: ${error}\n`);
  }

  return chunks.join('\n\n');
};
