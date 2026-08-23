declare module 'yauzl' {
  import type { Buffer } from 'node:buffer';
  import type { Readable } from 'node:stream';

  export interface Options {
    autoClose?: boolean;
    decodeStrings?: boolean;
    lazyEntries?: boolean;
    strictFileNames?: boolean;
    validateEntrySizes?: boolean;
  }

  export class Entry<FileName extends string | Buffer = string> {
    fileName: FileName;
    uncompressedSize: number;
    externalFileAttributes: number;
  }

  export class ZipFile<FileName extends string | Buffer = string> {
    on(event: 'entry', listener: (entry: Entry<FileName>) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'end', listener: () => void): this;

    readEntry(): void;
    openReadStream(
      entry: Entry<FileName>,
      callback: (error: Error | null, stream?: Readable) => void,
    ): void;
    close(): void;
  }

  export function fromBuffer(
    buffer: Buffer,
    options: Options & { decodeStrings: false },
    callback: (error: Error | null, zipfile?: ZipFile<Buffer>) => void,
  ): void;

  export function fromBuffer(
    buffer: Buffer,
    options: Options & { decodeStrings?: true },
    callback: (error: Error | null, zipfile?: ZipFile<string>) => void,
  ): void;
}
