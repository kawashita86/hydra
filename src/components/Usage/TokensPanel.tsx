import { USAGE_PROVIDERS, type UsagePeriod, type UsageState, type UsageSummary } from '@shared/usage/types'
import { formatCompactTokens, formatExactTokens, formatUsd } from './format'
import { ProviderDot } from './ProviderDot'
import { UsageBars } from './UsageBars'
import styles from './TokensPanel.module.css'

const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const
const VERSUS = { today: 'yesterday', week: 'last week', month: 'last month' } as const

interface TokensPanelProps {
  period: UsagePeriod
  summary: UsageSummary | null
  indexing: UsageState['indexing'] | null
}

export function indexingPercent(indexing: UsageState['indexing'] | null): number | null {
  const p = indexing?.progress
  if (!indexing?.indexing || !p || p.bytesTotal <= 0) return null
  return Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100))
}

export function TokensPanel({ period, summary, indexing }: TokensPanelProps) {
  const percent = indexingPercent(indexing)
  return (
    <div className={styles.panel}>
      {indexing?.indexing && <p className={styles.indexing}>Indexing usage…{percent !== null ? ` ${percent}%` : ''}</p>}
      {summary ? <Summary period={period} summary={summary} /> : <p className={styles.muted}>Loading…</p>}
    </div>
  )
}

function Summary({ period, summary }: { period: UsagePeriod; summary: UsageSummary }) {
  const change = summary.tokensChangePct
  const changeText =
    change === null
      ? null
      : Math.round(change) === 0
        ? `no change vs ${VERSUS[period]}`
        : `${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change))}% tokens vs ${VERSUS[period]}`
  const share = (tokens: number): number => (summary.totalTokens > 0 ? (tokens / summary.totalTokens) * 100 : 0)

  return (
    <>
      <div className={styles.hero}>
        <span className={styles.heroNumber} title={formatExactTokens(summary.totalTokens)}>
          {formatCompactTokens(summary.totalTokens)}
        </span>
        <span className={styles.heroUnit}>
          tokens · {summary.costPartial ? '≥' : '~'}
          {formatUsd(summary.costUsd)} API-equivalent
        </span>
      </div>
      <p className={styles.muted}>
        {[changeText, `${formatExactTokens(summary.messages)} messages`].filter(Boolean).join(' · ')}
      </p>

      <div className={styles.split} aria-hidden="true">
        {summary.byProvider.map((p) => (
          <span key={p.provider} className={styles.splitSeg} data-provider={p.provider} style={{ width: `${share(p.totalTokens)}%` }} />
        ))}
      </div>
      <ul className={styles.providers}>
        {USAGE_PROVIDERS.map((id) => {
          const p = summary.byProvider.find((x) => x.provider === id)
          const used = !!p && p.totalTokens > 0
          return (
            <li key={id} className={styles.provider}>
              <ProviderDot provider={id} />
              <span className={styles.providerName}>{PROVIDER_NAMES[id]}</span>
              {used ? (
                <>
                  <span className={styles.providerTokens}>{formatCompactTokens(p.totalTokens)}</span>
                  <span className={styles.providerCost}>
                    {p.costPartial ? '≥' : ''}
                    {formatUsd(p.costUsd)}
                  </span>
                </>
              ) : (
                <span className={styles.providerNone}>no usage</span>
              )}
            </li>
          )
        })}
      </ul>

      <UsageBars period={period} slots={summary.slots} />
    </>
  )
}
