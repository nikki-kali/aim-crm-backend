const SOURCE_SCORES = {
  Referral: 25, LinkedIn: 20, 'Office Visit': 20, Google: 15,
  'Walk-in': 12, Facebook: 10, Instagram: 10, 'X (Twitter)': 8,
}
const CASE_SCORES = { Implant: 15, 'Crown & Bridge': 12, Ortho: 10, Dentures: 8, Partial: 5 }
const INTENT_SCORES = { High: 20, Medium: 10, Low: 0 }

function scoreFromLead(lead) {
  let s = 0
  s += SOURCE_SCORES[lead.lead_source || lead.referral_source] || 0
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
