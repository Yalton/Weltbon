/** Joins class fragments, dropping falsy entries. */
export function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
