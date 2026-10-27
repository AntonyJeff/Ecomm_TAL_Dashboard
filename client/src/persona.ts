/**
 * Ranks contacts for the "# Contacts" popup so leadership/decision-maker and
 * Netcore-relevant personas surface first, ahead of the rest of the list.
 * Tier 2 (top): founders and C-suite. Tier 1: functions we actually sell
 * into. Tier 0: everyone else, alphabetical.
 */
const TOP_TIER_RE = /\b(founder|co-?founder|chief|ceo|cto|cio|cpo|cmo|cfo|coo)\b/i;
const RELEVANT_PERSONA_RE = /\b(marketing|retention|crm|e-?commerce|loyalty|strategy|growth)\b/i;

export function personaTier(title: string | null | undefined): number {
  const t = title || "";
  if (TOP_TIER_RE.test(t)) return 2;
  if (RELEVANT_PERSONA_RE.test(t)) return 1;
  return 0;
}
