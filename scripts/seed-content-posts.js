/**
 * One-time seed for content_posts/content_settings (v8 migration) — ports
 * Marketing OS's former mock data (Frontend/src/data/mockContentPosts.js)
 * into real rows so Content Studio isn't empty on first real load.
 * Idempotent-ish: safe to re-run against an empty table; does not dedupe
 * against a partially-seeded table (drop the rows first if re-seeding).
 * Usage: node scripts/seed-content-posts.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const db = require('../src/config/db')

function offsetDate(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const DEFAULT_SETTINGS = {
  aim: { connected_platforms: ['instagram', 'facebook', 'x', 'threads', 'linkedin', 'tiktok', 'gbp'], approval_required: true },
  kh: { connected_platforms: ['instagram', 'facebook', 'x', 'threads', 'linkedin', 'gbp'], approval_required: true },
}

const QUEUE_SLOTS = {
  aim: { instagram: ['09:00', '13:00', '17:00'], facebook: ['11:00'], x: ['10:00', '15:00'], threads: ['12:00'], linkedin: ['08:30'], tiktok: ['17:00'], gbp: ['09:00'] },
  kh: { instagram: ['09:00'], facebook: ['11:00'], x: ['10:00'], threads: ['12:00'], linkedin: ['08:30'], tiktok: [], gbp: ['09:00'] },
}

function post(overrides) {
  return {
    lab: 'aim',
    status: 'draft',
    created_by: 'Content Strategist AI',
    platforms: [],
    content: { text: '', hashtags: [], firstComment: '', mediaType: 'none', mediaLabel: '', mediaFileName: '' },
    per_platform_text: {},
    scheduling: { mode: 'queue', date: offsetDate(2), time: '09:00', timezone: 'America/New_York' },
    approval: { required: true, platforms: {} },
    compliance: 'pass',
    compliance_note: '',
    analytics: null,
    published_at: null,
    activity_log: [{ id: 'a1', type: 'created', text: 'Draft created', meta: 'Content Strategist AI · seeded' }],
    ...overrides,
  }
}

const POSTS = [
  post({
    lab: 'aim', status: 'scheduled', platforms: ['instagram', 'linkedin'],
    content: { text: 'What a digital full-arch workflow actually looks like — from scan to seat in an average of 4.2 days.', hashtags: ['#DigitalDentistry', '#FullArch', '#DentalLab'], firstComment: '#Implants #CADCAM #ScanToSeat #DentalTechnician', mediaType: 'image', mediaLabel: 'Case photo — full-arch scan sequence, 4 frames', mediaFileName: '' },
    scheduling: { mode: 'queue', date: offsetDate(2), time: '09:00', timezone: 'America/New_York' },
    approval: { required: true, platforms: { instagram: { externalRef: null, status: 'approved', taskUrl: null, comments: [] }, linkedin: { externalRef: null, status: 'approved', taskUrl: null, comments: [] } } },
  }),
  post({
    lab: 'aim', status: 'draft', platforms: ['linkedin', 'facebook'],
    content: { text: 'CE course recap: digital full-arch workflows for general practices. Recording available on request.', hashtags: ['#ContinuingEducation', '#DigitalDentistry'], firstComment: '', mediaType: 'image', mediaLabel: 'CE course photo — presenter + slide', mediaFileName: '' },
    scheduling: { mode: 'queue', date: offsetDate(4), time: '08:30', timezone: 'America/New_York' },
  }),
  post({
    lab: 'aim', status: 'draft', platforms: ['tiktok'],
    content: { text: 'POV: your scanner file arrives clean and the case ships a day early.', hashtags: ['#DentalLabLife', '#DigitalWorkflow'], firstComment: '', mediaType: 'video', mediaLabel: 'Short-form video — lab floor timelapse, 18s', mediaFileName: '' },
    scheduling: { mode: 'queue', date: offsetDate(5), time: '17:00', timezone: 'America/New_York' },
  }),
  post({
    lab: 'aim', status: 'published', platforms: ['instagram', 'facebook'],
    content: { text: 'Behind the scan: implant case walkthrough, from impression to final restoration.', hashtags: ['#Implants', '#BehindTheScenes', '#DentalLab'], firstComment: '#ImplantDentistry #CaseStudy #ScanToSeat', mediaType: 'carousel', mediaLabel: 'Carousel — 5 case photos', mediaFileName: '' },
    scheduling: { mode: 'queue', date: offsetDate(-5), time: '09:00', timezone: 'America/New_York' },
    approval: { required: true, platforms: { instagram: { externalRef: null, status: 'approved', taskUrl: null, comments: [] }, facebook: { externalRef: null, status: 'approved', taskUrl: null, comments: [] } } },
    published_at: offsetDate(-5),
    analytics: {
      impressions: 4820, reach: 3960, likes: 312, comments: 28, shares: 41, clicks: 96, engagementRate: 8.2,
      byPlatform: { instagram: { impressions: 3400, reach: 2850, engagement: 289 }, facebook: { impressions: 1420, reach: 1110, engagement: 92 } },
    },
  }),
  post({
    lab: 'aim', status: 'published', platforms: ['linkedin'],
    content: { text: 'Precision in Every Layer — how our digital full-arch cases are turning around in 4.2 days on average.', hashtags: ['#DigitalDentistry', '#FullArch'], firstComment: '', mediaType: 'image', mediaLabel: 'Graphic — turnaround stat card', mediaFileName: '' },
    scheduling: { mode: 'custom', date: offsetDate(-1), time: '08:00', timezone: 'America/New_York' },
    approval: { required: true, platforms: { linkedin: { externalRef: null, status: 'approved', taskUrl: null, comments: [] } } },
    published_at: offsetDate(-1),
    analytics: { impressions: 2140, reach: 1980, likes: 87, comments: 12, shares: 19, clicks: 64, engagementRate: 5.6, byPlatform: { linkedin: { impressions: 2140, reach: 1980, engagement: 118 } } },
  }),
  post({
    lab: 'aim', status: 'failed', platforms: ['gbp'],
    content: { text: 'Now booking digital scanner consultations for new referring practices — same-week slots available.', hashtags: [], firstComment: '', mediaType: 'image', mediaLabel: 'Lab front photo', mediaFileName: '' },
    scheduling: { mode: 'custom', date: offsetDate(-1), time: '09:00', timezone: 'America/New_York' },
    approval: { required: true, platforms: { gbp: { externalRef: null, status: 'approved', taskUrl: null, comments: [] } } },
    activity_log: [
      { id: 'a1', type: 'created', text: 'Draft created', meta: 'Content Strategist AI · seeded' },
      { id: 'a3', type: 'failed', text: 'Publish failed — Google Business Profile connection needs re-authentication', meta: 'System · seeded' },
    ],
  }),
  post({
    lab: 'kh', status: 'scheduled', platforms: ['instagram'],
    content: { text: 'Same-day crown demo — see the full digital workflow in under 2 minutes.', hashtags: ['#SameDayCrown', '#DigitalDentistry'], firstComment: '#KingsHighway #DentalLab', mediaType: 'video', mediaLabel: 'Short-form video — CEREC-style same-day workflow, 90s', mediaFileName: '' },
    scheduling: { mode: 'queue', date: offsetDate(2), time: '09:00', timezone: 'America/New_York' },
    approval: { required: true, platforms: { instagram: { externalRef: null, status: 'approved', taskUrl: null, comments: [] } } },
  }),
  post({
    lab: 'kh', status: 'draft', platforms: ['facebook', 'instagram'],
    content: { text: 'Community shoutout — thank you to everyone who came by the open house this month.', hashtags: ['#KingsHighway', '#Community'], firstComment: '', mediaType: 'image', mediaLabel: 'Open house photo', mediaFileName: '' },
    scheduling: { mode: 'queue', date: offsetDate(3), time: '11:00', timezone: 'America/New_York' },
  }),
  post({
    lab: 'kh', status: 'pending_approval', platforms: ['linkedin'],
    content: { text: 'Now accepting new referring practices in the Kings Highway / Midwood area — same-day crown capability on site.', hashtags: ['#KingsHighway', '#SameDayCrown'], firstComment: '', mediaType: 'none', mediaLabel: '', mediaFileName: '' },
    scheduling: { mode: 'custom', date: offsetDate(2), time: '08:30', timezone: 'America/New_York' },
    approval: { required: true, platforms: { linkedin: { externalRef: null, status: 'pending_review', taskUrl: null, comments: [] } } },
  }),
]

async function seed() {
  for (const p of POSTS) {
    await db.query(
      `insert into content_posts
        (lab, status, created_by, platforms, content, per_platform_text, scheduling, approval, compliance, compliance_note, analytics, published_at, activity_log)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,$12,$13::jsonb)`,
      [
        p.lab, p.status, p.created_by, JSON.stringify(p.platforms), JSON.stringify(p.content),
        JSON.stringify(p.per_platform_text), JSON.stringify(p.scheduling), JSON.stringify(p.approval),
        p.compliance, p.compliance_note, p.analytics ? JSON.stringify(p.analytics) : null, p.published_at,
        JSON.stringify(p.activity_log),
      ]
    )
  }
  console.log(`✓ Seeded ${POSTS.length} content_posts`)

  for (const [lab, settings] of Object.entries(DEFAULT_SETTINGS)) {
    await db.query(
      `insert into content_settings (lab, connected_platforms, approval_required, queue_slots)
       values ($1, $2::jsonb, $3, $4::jsonb)
       on conflict (lab) do update set connected_platforms=$2::jsonb, approval_required=$3, queue_slots=$4::jsonb`,
      [lab, JSON.stringify(settings.connected_platforms), settings.approval_required, JSON.stringify(QUEUE_SLOTS[lab])]
    )
  }
  console.log('✓ Seeded content_settings for aim, kh')
  await db.end()
}

seed().catch((err) => { console.error(err); process.exit(1) })
