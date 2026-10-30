const test = require('node:test')
const assert = require('node:assert')
const { validateApplication, recipients, applicationEmail, safeFilename } = require('../src/routes/jobApplications')

const good = { position: 'Digital Dental Technician', name: ' Alex Rivera ', email: 'Alex@Example.com', phone: '(718) 555-0100', experience: '3-5 years', summary: '3Shape daily.\nRun two printers.' }

test('validateApplication accepts a complete application and normalizes it', () => {
  const { data, error } = validateApplication(good)
  assert.strictEqual(error, undefined)
  assert.strictEqual(data.name, 'Alex Rivera')
  assert.strictEqual(data.email, 'alex@example.com')
  assert.strictEqual(data.summary, '3Shape daily.\nRun two printers.')
})

test('validateApplication rejects unknown positions and missing fields', () => {
  assert.ok(validateApplication({ ...good, position: 'CEO' }).error)
  assert.ok(validateApplication({ ...good, name: ' ' }).error)
  assert.ok(validateApplication({ ...good, email: 'nope' }).error)
  assert.ok(validateApplication({ ...good, phone: 'call me' }).error)
  assert.ok(validateApplication({ ...good, summary: '' }).error)
})

test('single-line fields cannot carry line breaks', () => {
  const { data } = validateApplication({ ...good, name: 'Alex\r\nBcc: x@y.com' })
  assert.ok(!/[\r\n]/.test(data.name))
})

test('recipients default to Stephen, cc the executive assistant, and env can override', () => {
  assert.deepStrictEqual(recipients({}).to, ['stephenm@aimdentallab.com'])
  assert.deepStrictEqual(recipients({ JOB_APPLICATION_TO: '' }).to, [])
  assert.deepStrictEqual(recipients({}).cc, ['execassistant@aimdentallab.com'])
  assert.deepStrictEqual(recipients({ JOB_APPLICATION_TO: 'a@x.com', JOB_APPLICATION_CC: '' }), { to: ['a@x.com'], cc: [] })
})

test('applicationEmail escapes applicant input', () => {
  const html = applicationEmail({ ...validateApplication(good).data, summary: '<script>x</script>' }, 'cv.pdf')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('safeFilename keeps a plain name and the allowed extension', () => {
  assert.strictEqual(safeFilename('Alex Rivera CV.pdf'), 'Alex Rivera CV.pdf')
  assert.strictEqual(safeFilename('../../etc/x\r\n"<b>.docx'), 'xb.docx')
  assert.strictEqual(safeFilename('<>.pdf'), 'resume.pdf')
})
