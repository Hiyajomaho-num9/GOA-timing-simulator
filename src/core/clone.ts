/** Clone the model's plain objects and arrays, including optional undefined fields. */
export function cloneModel<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  const seen = new WeakMap<object, unknown>();
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return seen.get(item);
    const out: object = Array.isArray(item) ? new Array(item.length) : Object.create(Object.getPrototypeOf(item) === null ? null : Object.prototype);
    seen.set(item, out);
    for (const key of Object.keys(item)) {
      Object.defineProperty(out, key, { value: copy((item as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return copy(value) as T;
}
