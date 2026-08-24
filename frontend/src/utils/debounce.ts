export type Debounced<A extends unknown[]> = ((...args: A) => void) & {
  cancel: () => void
  flush: () => void
  /** 是否有尚未触发的防抖定时器（即还有未落盘的变更在等待） */
  isPending: () => boolean
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: number | undefined
  let lastArgs: A | undefined

  const wrapped = ((...args: A) => {
    lastArgs = args
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      lastArgs = undefined
      fn(...args)
    }, ms)
  }) as Debounced<A>

  wrapped.cancel = () => {
    window.clearTimeout(timer)
    timer = undefined
    lastArgs = undefined
  }

  wrapped.flush = () => {
    if (timer === undefined) return
    window.clearTimeout(timer)
    timer = undefined
    const args = lastArgs ?? ([] as unknown as A)
    lastArgs = undefined
    fn(...args)
  }

  wrapped.isPending = () => timer !== undefined

  return wrapped
}
