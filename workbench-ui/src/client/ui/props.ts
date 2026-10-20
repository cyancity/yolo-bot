/** Native DOM contracts allow explicit undefined; component props omit absent values. */
export function definedProps<T extends object>(props: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> }
}
