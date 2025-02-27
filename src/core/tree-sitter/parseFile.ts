import type { RepomixConfigMerged } from '../../config/configSchema.js';
import { logger } from '../../shared/logger.js';
import type { SupportedLang } from './lang2Query.js';
import { LanguageParser } from './languageParser.js';

// Manage singleton instance
let languageParserSingleton: LanguageParser | null = null;

const getLanguageParserSingleton = async () => {
  if (!languageParserSingleton) {
    languageParserSingleton = new LanguageParser();
    await languageParserSingleton.init();
  }
  return languageParserSingleton;
};

/**
 * Normalize chunk
 */
function normalizeChunk(chunk: string): string {
  return chunk.trim();
}

/**
 * Enhanced parseFile function to extract definitions and comments
 * - Includes complete comments
 * - Includes complete type definitions (interface, type, enum)
 * - Includes import statements
 * - Includes complete function/method signatures with line breaks
 */
export const parseFile = async (fileContent: string, filePath: string, config: RepomixConfigMerged) => {
  const languageParser = await getLanguageParserSingleton();

  // Split file content into lines
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
    // Parse file content into AST
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

      // Determine the type of capture
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
          // Get function/method signature
          let signatureEndRow = startRow;
          
          // Find the end position of parameter definitions
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

          // Remove implementation part from function signature
          let lastLineIndex = selectedLines.length - 1;
          let lastLine = selectedLines[lastLineIndex];

          // Remove implementation part from the last line
          if (lastLine) {
            if (lastLine.includes('{')) {
              selectedLines[lastLineIndex] = lastLine.substring(0, lastLine.indexOf('{')).trim();
            } else if (lastLine.includes('=>')) {
              selectedLines[lastLineIndex] = lastLine.substring(0, lastLine.indexOf('=>')).trim();
            } else if (lastLine.includes('->')) {
              selectedLines[lastLineIndex] = lastLine.substring(0, lastLine.indexOf('->')).trim();
            }
          }

          // Remove duplicates
          const signature = selectedLines.join('\n').trim();
          if (processedChunks.has(signature)) {
            continue;
          }
          processedChunks.add(signature);

        } else if (isTypeDefinitionCapture && name.includes('definition.class')) {
          // For class definitions, get only the first line (including extends/implements)
          selectedLines = [lines[startRow]];
          
          // Add next line if it contains extends/implements
          if (startRow + 1 <= endRow) {
            const nextLine = lines[startRow + 1].trim();
            if (nextLine.includes('extends') || nextLine.includes('implements')) {
              selectedLines.push(nextLine);
            }
          }

          // Remove implementation part
          selectedLines = selectedLines.map(line => {
            return line.replace(/\{.*$/, '').trim();
          });

          const definition = selectedLines.join('\n').trim();
          if (processedChunks.has(definition)) {
            continue;
          }
          processedChunks.add(definition);

        } else if (isTypeDefinitionCapture || isImportCapture) {
          // Get complete interface, type definition, and import statements
          selectedLines = lines.slice(startRow, endRow + 1);
          const definition = selectedLines.join('\n').trim();
          if (processedChunks.has(definition)) {
            continue;
          }
          processedChunks.add(definition);

        } else if (isCommentCapture) {
          // Get complete comments
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
