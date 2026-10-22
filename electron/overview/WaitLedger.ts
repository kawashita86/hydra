import type { MeasuredSpan, OverviewEvent, WaitLedgerData, WaitTransition } from '@shared/overview/types'
import { MAX_SAMPLE_GAP_MS } from '@shared/overview/buckets'
import { LEDGER_DAYS, transitionOfEvent } from '@shared/overview/waits'

/** The ledger keeps this long. */
export const LEDGER_MS = LEDGER_DAYS * 24 * 60 * 60 * 1000

/**
 * What the wait totals are worked out from, kept for the last 9 days: every
 * move into or out of `needs-you`, and the measured stretches (runs of
 * points no more than 15 s apart, broken by each daemon start).
 *
 * The history files hold all of it, but the history store keeps only the
 * newest 1 000 events and 6 h of points in memory, so the store seeds this
 * from every file it restores (`append`) and then feeds it live.
 *
 * Compact: a transition is a few fields, a stretch is two numbers, and a day
 * of watching with no breaks is one stretch.
 */
export class WaitLedger {
  private transitions: WaitTransition[] = []
  private spans: MeasuredSpan[] = []
  private starts: number[] = []
  /** The next point goes on the newest stretch if it is near enough. */
  private continuing = false

  addEvents(events: readonly OverviewEvent[]): void {
    for (const event of events) {
      const t = transitionOfEvent(event)
      if (t) this.transitions.push(t)
    }
  }

  /** A point taken at `at`: the newest stretch goes on to it, or a new one begins. */
  addPoint(at: number): void {
    const last = this.spans[this.spans.length - 1]
    if (last && this.continuing && at >= last.end && at - last.end <= MAX_SAMPLE_GAP_MS) {
      last.end = at
    } else if (!last || at > last.end) {
      // A point older than the newest held (the clock went back) adds nothing.
      this.spans.push({ start: at, end: at })
    }
    this.continuing = true
  }

  /** The daemon started at `at`: nothing was measured from the last point to the next one. */
  addStart(at: number): void {
    this.starts.push(at)
    this.continuing = false
  }

  /**
   * Adds the data of a stretch of history that comes after everything held,
   * for example the next day's file. A stretch that goes on from the last one
   * (points near enough, no start between) is joined to it.
   */
  append(data: WaitLedgerData): void {
    this.transitions.push(...data.transitions)
    const last = this.spans[this.spans.length - 1]
    const first = data.spans[0]
    let rest = data.spans
    if (
      last &&
      first &&
      first.start >= last.end &&
      first.start - last.end <= MAX_SAMPLE_GAP_MS &&
      !data.starts.some((s) => s > last.end && s <= first.start)
    ) {
      last.end = Math.max(last.end, first.end)
      rest = data.spans.slice(1)
    }
    this.spans.push(...rest.map((s) => ({ ...s })))
    this.starts.push(...data.starts)
    this.continuing = data.spans.length > 0 && data.starts.every((s) => s <= data.spans[data.spans.length - 1].end)
  }

  /** Forgets what is older than 9 days before `now`. */
  prune(now: number): void {
    const cutoff = now - LEDGER_MS
    if (this.transitions.length > 0 && this.transitions[0].at < cutoff) {
      this.transitions = this.transitions.filter((t) => t.at >= cutoff)
    }
    if (this.spans.length > 0 && this.spans[0].start < cutoff) {
      this.spans = this.spans.filter((s) => s.end >= cutoff).map((s) => ({ start: Math.max(s.start, cutoff), end: s.end }))
    }
    if (this.starts.length > 0 && this.starts[0] < cutoff) this.starts = this.starts.filter((s) => s >= cutoff)
  }

  /** A copy of what is held, transitions in time order. */
  data(): WaitLedgerData {
    return {
      transitions: [...this.transitions].sort((a, b) => a.at - b.at),
      spans: this.spans.map((s) => ({ ...s })),
      starts: [...this.starts]
    }
  }
}
