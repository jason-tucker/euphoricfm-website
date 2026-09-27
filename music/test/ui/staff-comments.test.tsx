import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommentThread, visibleComments, type UiComment } from '@/components/CommentThread'
import { canSeeComment, type Viewer } from '@/server/authz/predicates'

const comments: UiComment[] = [
  { id: 1, itemId: null, body: 'Public hello', visibility: 'all', source: 'portal', authorName: 'Member', createdAt: '2026-09-27T01:00:00Z' },
  { id: 2, itemId: null, body: 'SECRET staff note', visibility: 'staff', source: 'portal', authorName: 'Manager', createdAt: '2026-09-27T01:05:00Z' },
  { id: 3, itemId: null, body: 'Reply from Discord', visibility: 'all', source: 'ticket', authorName: 'Manager', createdAt: '2026-09-27T01:06:00Z' },
]

describe('staff comments are visible only to reviewers', () => {
  it('a member never sees a staff comment, nor the staff-only option', () => {
    render(<CommentThread batchId={1} itemId={null} comments={comments} isReviewer={false} title="Batch conversation" />)
    expect(screen.queryByText('SECRET staff note')).toBeNull()
    expect(screen.queryByText('Staff only')).toBeNull()
    expect(screen.queryByTestId('staff-option')).toBeNull()
    expect(screen.getByText('Public hello')).toBeTruthy()
    expect(screen.getByText('via ticket')).toBeTruthy()
    expect(document.querySelectorAll('[data-visibility="staff"]')).toHaveLength(0)
  })

  it('a reviewer sees it, labelled "Staff only", and can post staff notes', () => {
    render(<CommentThread batchId={1} itemId={null} comments={comments} isReviewer title="Batch conversation" />)
    const staff = screen.getByText('SECRET staff note').closest('li')!
    expect(staff.getAttribute('data-visibility')).toBe('staff')
    expect(staff.textContent).toContain('Staff only')
    expect(screen.getByTestId('staff-option').textContent).toMatch(/never sent to the ticket/i)
  })

  it('visibleComments filters staff for non-reviewers (defence in depth)', () => {
    expect(visibleComments(comments, false).map((c) => c.id)).toEqual([1, 3])
    expect(visibleComments(comments, true).map((c) => c.id)).toEqual([1, 2, 3])
  })

  it('the server predicate agrees: staff comments are review-only, even for the owner', () => {
    const owner: Viewer = { userId: 'u1', discordId: '1', name: 'o', perms: new Set(['submit', 'request']) }
    const reviewer: Viewer = { userId: 'u2', discordId: '2', name: 'r', perms: new Set(['submit', 'request', 'review']) }
    const parent = { ownerUserId: 'u1' }
    expect(canSeeComment(owner, parent, { visibility: 'staff' })).toBe(false)
    expect(canSeeComment(owner, parent, { visibility: 'all' })).toBe(true)
    expect(canSeeComment(reviewer, parent, { visibility: 'staff' })).toBe(true)
  })
})
