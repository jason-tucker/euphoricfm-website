// Admin routes (CONFIRMED against feat/music-requests 58587c9).

import { api } from '@/components/api'

// PUT /api/admin/settings {key, value} — validated per key; caps can only be lowered.
export function putSetting(key: string, value: unknown) {
  return api<{ key: string; value: unknown }>('/api/admin/settings', { method: 'PUT', json: { key, value } })
}

// POST /api/admin/role-bindings {roleId, permission, note?} → 201 (409 binding_exists)
export function addRoleBinding(roleId: string, permission: 'review' | 'manage', note?: string) {
  return api<{ id: number }>('/api/admin/role-bindings', { json: { roleId, permission, ...(note ? { note } : {}) } })
}

// DELETE /api/admin/role-bindings/:id
export function removeRoleBinding(id: number) {
  return api(`/api/admin/role-bindings/${id}`, { method: 'DELETE' })
}

// v0.3.6 "Archive the UNRELEASED folder" (manage). POST {action:'dry_run'}
// queues the worker's read-only listing; {action:'run', planId} confirms it.
export function legacyImportDryRun() {
  return api<{ planId: string; status: string }>('/api/admin/legacy-import', { json: { action: 'dry_run' } })
}
export function legacyImportRun(planId: string) {
  return api<{ planId: string; queued: number }>('/api/admin/legacy-import', { json: { action: 'run', planId } })
}
