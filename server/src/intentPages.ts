/**
 * Website page intent, pulled from the Factors.ai website engagement scoring
 * sheet the user shared (Channel/Page/Signal/Weight/Intent table). Only rows
 * with a real page URL are included - "Form Submitted v2", "Paid Search
 * Session v2", and "LLM Traffic v2" are High-intent signals too, but they
 * describe an EVENT or a referrer source, not a page on netcore.ai, so they
 * can't be detected from firstPageUrl/latestPageUrl alone (we only capture
 * entry/exit page URL per session, not referrer or form-submit events) and
 * are intentionally left out rather than guessed at. Rows with no Intent
 * value in the sheet (Unbxd SPD, Onboarding, CPaaS) are left out of both
 * lists for the same reason - not guessed at either way.
 *
 * One known ambiguity, called out rather than silently resolved: /email
 * appears in the source sheet under BOTH "Email Primary" (High) and
 * "Visited Product - Email" (Medium) - the same URL, different intent
 * depending on which named Factors signal fired, which we can't distinguish
 * from the raw URL alone. It's listed under High only (the more specific,
 * deliberate signal name), consistent with High taking precedence over
 * Medium wherever the two would otherwise overlap.
 */
const HIGH_INTENT_PATH_FRAGMENTS = [
  "/contact-us",
  "/request-demo",
  "/plan-and-pricing",
  "/resources/success-story",
  "/switch-to-netcore",
  "/compare",
  "/why-netcore",
  "/email-consultancy",
  "/privacy-policy",
  "/email",
  "lp/competitor/",
];

const MEDIUM_INTENT_PATH_FRAGMENTS = [
  "/eu/s-q-l-ac",
  "/amp",
  "/customer-data-platform",
  "/co-marketer-ai",
  "/customer-retention-management-platform",
  "/email-api",
  "/marketing-automation-platform",
  "/personalization",
  "/product-experience",
  "/agentic-marketing-platform",
  "/customer-engagement-platform",
  "/app-push-notifications",
  "/in-app-messages",
  "/rcs",
  "/sms",
  "/voice",
  "/web-messages",
  "/web-push-notifications",
  "/whatsapp-marketing",
  "/auto",
  "/industries",
  "/retail",
  "/scope-of-service",
  "/t-and-c-for-search-browse-recommendations",
  "/terms-of-service",
  "/tools",
  "/whatsapp-terms-of-use",
  "cedocs.netcorecloud.com",
  "lp/category/",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Path-boundary aware, not a plain substring match - "/email" must NOT also
// match "/email-api" or "/email-consultancy" (all real, different, lower- or
// differently-scored pages in the same sheet), so each fragment must be
// followed by the end of the URL or a non-path character (/, ?, #).
function buildMatcher(fragments: string[]): (url: string) => boolean {
  const matchers = fragments.map((frag) => new RegExp(escapeRegExp(frag.toLowerCase()) + "(?:$|[/?#])"));
  return (url: string) => {
    if (!url) return false;
    const lower = url.toLowerCase();
    return matchers.some((re) => re.test(lower));
  };
}

export const isHighIntentUrl = buildMatcher(HIGH_INTENT_PATH_FRAGMENTS);
export const isMediumIntentUrl = buildMatcher(MEDIUM_INTENT_PATH_FRAGMENTS);
