/**
 * Keeps the dashboard's working state (week, filters, search, sort, page)
 * across reloads/reopening the tab, so switching away to dig into something
 * and coming back doesn't lose your place. Browser storage only - per
 * viewer's own browser, never synced anywhere.
 */
export interface PersistedDashboardState {
  month?: string; // "YYYY-MM"
  weekNum?: number | "all"; // "all" = whole-month consolidated view
  search?: string;
  regions?: string[];
  mrr?: string[];
  factorLevels?: string[]; // Factor Score (Hot/Warm/Cool/Ice/Not scored) filter
  sortMetrics?: string[]; // also carries "highIntent"/"mediumIntent" filter checkboxes
  groupTab?: string; // UI trial (redesign-tabbed-kpi): which column group tab was active
  filtersOpen?: boolean; // UI trial (redesign-tabbed-kpi): collapsible filter row state
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
