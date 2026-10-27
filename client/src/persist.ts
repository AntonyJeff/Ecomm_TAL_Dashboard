/**
 * Keeps the dashboard's working state (week, filters, search, sort, page)
 * across reloads/reopening the tab, so switching away to dig into something
 * and coming back doesn't lose your place. Browser storage only - per
 * viewer's own browser, never synced anywhere.
 */
export interface PersistedDashboardState {
  weekNum?: number;
  search?: string;
  regions?: string[];
  mrr?: string[];
  sortMetrics?: string[];
  page?: number;
}

const STORAGE_KEY = "ecommTalDashboard.v1";

export function loadPersistedState(): PersistedDashboardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function savePersistedState(state: PersistedDashboardState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private browsing / storage disabled / quota - just skip persisting
  }
}
