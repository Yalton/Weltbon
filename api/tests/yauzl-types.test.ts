import type { Buffer } from 'node:buffer';
import yauzl from 'yauzl';
import { expectTypeOf, test } from 'vitest';

test('decodeStrings controls the entry filename type', () => {
  expectTypeOf<yauzl.Entry<string>['fileName']>().toEqualTypeOf<string>();
  expectTypeOf<yauzl.Entry<Buffer>['fileName']>().toEqualTypeOf<Buffer>();

  const assertFromBufferInference = (buffer: Buffer) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (_error, zipfile) => {
      expectTypeOf(zipfile).toEqualTypeOf<yauzl.ZipFile<string> | undefined>();
    });

    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, (_error, zipfile) => {
      expectTypeOf(zipfile).toEqualTypeOf<yauzl.ZipFile<Buffer> | undefined>();
    });
  };

  expectTypeOf(assertFromBufferInference).toBeFunction();
});
