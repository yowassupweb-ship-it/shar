import { DEFAULT_DEPARTMENTS } from '@/shared/types/user';

interface CachedDepartment {
  id: string;
  name: string;
  color?: string;
}

// In-memory cache of the real departments table (fetched once per page load).
// Synchronous callers below read whatever is cached so far; DEFAULT_DEPARTMENTS
// is only a last-resort fallback for the brief window before the fetch resolves
// (or if it fails) — it is no longer the primary source of truth.
let cache: Record<string, CachedDepartment> | null = null;
let fetchStarted = false;

function ensureFetchStarted(): void {
  if (fetchStarted || typeof window === 'undefined') return;
  fetchStarted = true;
  fetch('/api/departments')
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      if (!Array.isArray(data?.departments)) return;
      cache = {};
      for (const d of data.departments) {
        cache[d.id] = { id: d.id, name: d.name, color: d.color };
      }
    })
    .catch(() => {});
}

export function getDepartmentColor(departmentId?: string): string {
  if (!departmentId) return '#6b7280';
  ensureFetchStarted();
  const cached = cache?.[departmentId];
  if (cached?.color) return cached.color;
  return DEFAULT_DEPARTMENTS.find(d => d.id === departmentId)?.color || '#6b7280';
}

export function getDepartmentName(departmentId?: string, departments?: Array<{ id: string; name: string }>): string {
  if (!departmentId) return '';
  if (departments) {
    const found = departments.find(d => d.id === departmentId);
    if (found) return found.name;
  }
  ensureFetchStarted();
  const cached = cache?.[departmentId];
  if (cached?.name) return cached.name;
  return DEFAULT_DEPARTMENTS.find(d => d.id === departmentId)?.name || departmentId;
}
