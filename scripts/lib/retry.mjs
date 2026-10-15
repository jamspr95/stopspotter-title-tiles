// Small retry helper for the transient failures a real --all run keeps
// hitting against live HMLR/RoS sources — confirmed from a real job log
// (Oct 2026): several councils failed with a bare "fetch failed" and
// nothing else, the signature of a one-off network blip rather than a
// real parsing bug, since re-running the same council by itself usually
// works. Retrying the whole download+parse call (not just the inner
// fetch) is simplest and correct here: nothing in buildOneCouncil/
// buildOneCounty has side effects worth preserving between attempts.

/**
 * Calls fn() up to `attempts` times, waiting `delayMs` between tries.
 * Resolves with the first successful result; rejects with the LAST
 * error if every attempt fails, so a real, persistent error (not a
 * blip) still surfaces exactly as before — this never hides a genuine
 * failure, only smooths over a transient one.
 */
export async function withRetries(fn, { attempts = 3, delayMs = 2000 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        console.warn(`  attempt ${attempt}/${attempts} failed (${err.message}), retrying in ${delayMs}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}
