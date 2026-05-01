# Code-block tag negative test

This paragraph has a #real-tag in it.

```ts
const x = "#tag-in-code"; // must NOT be extracted
```

Inline `#also-in-code` here must NOT be extracted either.
