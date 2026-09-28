const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTeamProgressChartUrl } = require('../../src/services/evidentReport/chart')

test('team progress chart URL carries every row and both bars as percent of goal', () => {
  const url = buildTeamProgressChartUrl([
    { label: 'Team', salesPct: 4, doctorsPct: 14 },
    { label: 'James', salesPct: 6, doctorsPct: 25 },
    { label: 'William', salesPct: 3, doctorsPct: 0 },
  ], 'September progress toward goals')
  assert.match(url, /^https:\/\/quickchart\.io\/chart\?w=800&h=460/)
  const config = JSON.parse(decodeURIComponent(url.split('&c=')[1]))
  assert.equal(config.type, 'horizontalBar')
  assert.deepEqual(config.data.labels, ['Team', 'James', 'William'])
  assert.deepEqual(config.data.datasets[0].data, [4, 6, 3])
  assert.deepEqual(config.data.datasets[1].data, [14, 25, 0])
  assert.equal(config.options.scales.xAxes[0].ticks.max, 100)
})
