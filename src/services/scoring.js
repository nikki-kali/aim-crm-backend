const SOURCE_SCORES = {
  Referral: 25, LinkedIn: 20, 'Office Visit': 20, Google: 15,
  'Website Form Submission': 15, Email: 10, 'Walk-in': 12, Facebook: 10,
  Instagram: 10, X: 8, 'Email Marketing': 8,
}
const CASE_SCORES = { Implant: 15, 'Crown & Bridge': 12, Ortho: 10, Dentures: 8, Partial: 5 }
const INTENT_SCORES = { High: 20, Medium: 10, Low: 0 }

// Lead sources can arrive tagged by external systems we don't control
// (Zapier/Make webhooks from social lead-gen forms send lowercase values
// like "linkedin"/"twitter"/"office visit" — see Frontend/social-lead-setup.md).
// Normalize before the SOURCE_SCORES lookup so those don't silently score
// as 0. Keep in sync with Frontend/src/lib/leadSource.js's ALIASES.
const SOURCE_ALIASES = {
  website: 'Website Form Submission',
  web: 'Website Form Submission',
  referral: 'Referral',
  google: 'Google',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  twitter: 'X',
  'x (twitter)': 'X',
  'email marketing': 'Email Marketing',
  email: 'Email',
  'office visit': 'Office Visit',
  'walk-in': 'Walk-in',
  'walk in': 'Walk-in',
}

function normalizeSource(raw) {
  const val = (raw || '').trim()
  if (!val) return null
  return SOURCE_ALIASES[val.toLowerCase()] || val
}

function scoreFromLead(lead) {
  let s = 0
  s += SOURCE_SCORES[normalizeSource(lead.lead_source || lead.referral_source)] || 0
  const val = Number(lead.estimated_value) || 0
  if (val >= 8000) s += 25
  else if (val >= 4000) s += 15
  else if (val >= 2000) s += 10
  else s += 5
  s += CASE_SCORES[lead.case_interest] || 0
  s += INTENT_SCORES[lead.intent_level] || 0
  if (lead.email) s += 5
  if (lead.phone) s += 5
  return Math.min(s, 100)
}

module.exports = { scoreFromLead }
