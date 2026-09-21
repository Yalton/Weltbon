export interface DocxLimits {
  docxSize: number;
  docxCount: number;
  docxEntryCount: number;
  docxPartSize: number;
  docxTotalUncompressed: number;
  docxXmlDepth: number;
  docxBlockCount: number;
}

export const DOCX_BATCH_BLOCK_COUNT = 100_000;

export interface DocxWorkBudget {
  used: number;
  readonly max: number;
}

export function createDocxWorkBudget(
  max = DOCX_BATCH_BLOCK_COUNT,
): DocxWorkBudget {
  return { used: 0, max };
}

export const DOCX_LIMITS: DocxLimits = {
  docxSize: 25 * 1024 * 1024,
  docxCount: 50,
  docxEntryCount: 512,
  docxPartSize: 32 * 1024 * 1024,
  docxTotalUncompressed: 64 * 1024 * 1024,
  docxXmlDepth: 256,
  docxBlockCount: 100_000,
};
