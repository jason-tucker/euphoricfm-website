export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, stepMs = 500): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
