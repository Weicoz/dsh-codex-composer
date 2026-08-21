declare module 'react' {
  export const createElement: (...args: any[]) => any
  export const useEffect: (...args: any[]) => void
  export const useMemo: <T>(factory: () => T, deps: readonly unknown[]) => T
  export const useState: <T>(initial: T) => [T, (value: T | ((previous: T) => T)) => void]
}
