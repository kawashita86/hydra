// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewSession } from '@shared/overview/types'
import { LAYOUT_STORAGE_KEY, SessionsCard } from './SessionsCard'

const NOW = 100_000_000

function s(id: string, status: OverviewSession['status'], extra: Partial<OverviewSession> = {}): OverviewSession {
  return {
    agentId: id,
    name: `agent-${id}`,
    provider: 'claude',
    model: 'sonnet',
    projectDir: `/work/${id}`,
    worktreeBranch: null,
    status,
    statusSince: NOW - 60_000,
    stale: false,
    pid: null,
    startedAt: 0,
    lastOutputAt: 0,
    ...extra
  } as OverviewSession
}

function renderCard(sessions: OverviewSession[], props: { onOpen?: () => void; onJump?: () => void } = {}) {
  return render(
    <SessionsCard
      sessions={sessions}
      now={NOW}
      showProvider={false}
      selectedId={null}
      onOpenDetails={props.onOpen ?? vi.fn()}
      onJumpToAgent={props.onJump ?? vi.fn()}
    />
  )
}

describe('SessionsCard', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(cleanup)

  it('lists groups in order without the needs-you sessions and counts all in the title', () => {
    renderCard([s('a', 'finished'), s('b', 'working'), s('c', 'needs-you'), s('d', 'idle', { stale: true })])
    expect(screen.getByRole('region', { name: 'Sessions' }).textContent).toContain('4')
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(headings).toEqual(['Working1', 'Idle1', 'Finished / Failed1'])
    expect(screen.queryByText('agent-c')).toBeNull()
    expect(screen.getByText('Idle (stale)')).toBeTruthy()
  })

  it('shows folder, branch, the commit when detached, and quiet for', () => {
    renderCard([
      s('a', 'working', { branch: 'feat/x', quietForMs: 700_000, lastOutputAt: NOW - 720_000 }),
      s('b', 'idle', { commit: 'abc1234' })
    ])
    expect(screen.getByText('feat/x')).toBeTruthy()
    expect(screen.getByText('abc1234')).toBeTruthy()
    expect(screen.getByText('quiet for 12m')).toBeTruthy()
  })

  it('switches layout and remembers it', () => {
    renderCard([s('a', 'working', { repoName: 'shop' }), s('b', 'idle', { repoName: 'shop' }), s('c', 'idle')])
    fireEvent.click(screen.getByRole('button', { name: 'Repos' }))
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(headings).toEqual(['shop2', 'No repository1'])
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('repos')

    cleanup()
    renderCard([s('a', 'working')])
    expect(screen.getByRole('button', { name: 'Repos' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Board' }))
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('board')
  })

  it('names the worktree folder in Repos only when it differs from the repository', () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, 'repos')
    renderCard([
      s('a', 'working', { repoName: 'a', projectDir: '/work/a' }),
      s('b', 'working', { repoName: 'a', projectDir: '/work/a-wt' })
    ])
    expect(screen.getAllByText('a-wt')).toHaveLength(1)
    // Only the group heading says "a": the folder of the main checkout is not repeated.
    expect(screen.getAllByText('a')).toHaveLength(1)
  })

  it('caps board columns at five cards with a note for the rest', () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, 'board')
    const many = Array.from({ length: 7 }, (_, i) => s(`w${i}`, 'working'))
    renderCard([...many, s('n', 'needs-you')])
    const working = screen.getByRole('region', { name: 'Working' })
    expect(within(working).getAllByRole('listitem')).toHaveLength(5)
    expect(within(working).getByText('and 2 more in the list')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Needs you' })).getByText('agent-n')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Idle' })).getByText('Nothing idle')).toBeTruthy()
  })

  it('opens details on a row click but not when Jump is clicked', () => {
    const onOpen = vi.fn()
    const onJump = vi.fn()
    renderCard([s('a', 'working')], { onOpen, onJump })
    fireEvent.click(screen.getByRole('button', { name: 'Jump to agent-a' }))
    expect(onJump).toHaveBeenCalledWith('a')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Details of agent-a' }))
    expect(onOpen).toHaveBeenCalledWith('a', expect.any(HTMLElement))
  })
})
