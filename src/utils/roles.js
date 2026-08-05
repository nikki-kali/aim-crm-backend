// 'staff' and 'sales_rep' both get the same own-records-only data scoping;
// they differ only in whether they receive per-lead notifications (see
// services/automations.js and services/workflowEngine.js).
const SCOPED_ROLES = ['staff', 'sales_rep']

function isScopedRole(role) {
  return SCOPED_ROLES.includes(role)
}

module.exports = { SCOPED_ROLES, isScopedRole }
