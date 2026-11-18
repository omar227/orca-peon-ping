import type { StoreApi } from '../store.ts'

export function memoryStoreApi(): StoreApi {
  const map = new Map<string, unknown>()
  return {
    get<T>(key: string): Promise<T | null> {
      return Promise.resolve(map.has(key) ? (map.get(key) as T) : null)
    },
    set(key: string, value: unknown): Promise<void> {
      map.set(key, value)
      return Promise.resolve()
    }
  }
}
