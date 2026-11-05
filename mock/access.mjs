// Team and access (same file in Echo and Clarix): the organization, its sub-orgs and teams, who is in each, the role they
// hold there and what each role may do. A role given in a unit works in that unit and every unit under it. A person may
// hold several roles; what they can do is everything those roles allow, each only where it was given.
// People who manage access can only act inside the units they manage, and can only give roles that do no more than they can.
// Demo data only: invites, suspensions and API keys are recorded here, not sent to an identity provider.

const nowIso = () => new Date().toISOString();
const days = (n) => new Date(Date.now() + n * 864e5).toISOString();

export const LEVELS = [{ key: 'org', label: 'Organization' }, { key: 'sub_org', label: 'Sub-org' }, { key: 'team', label: 'Team' }];
const RANK = { org: 0, sub_org: 1, team: 2 };
export const ACTIONS = [{ key: 'view', label: 'View' }, { key: 'create', label: 'Create' }, { key: 'edit', label: 'Edit' }, { key: 'delete', label: 'Delete' }, { key: 'export', label: 'Export' }];
// What each action means in each area, for the tooltip in the permission table.
export const MODULES = [
  { key: 'dashboard', label: 'Dashboard', actions: { view: 'See the dashboard', export: 'Download dashboard numbers' } },
  { key: 'campaigns', label: 'Campaigns', actions: { view: 'See campaigns', create: 'Start a campaign from a sheet', edit: 'Pause, resume or stop a campaign', delete: 'Delete a campaign', export: 'Download campaign results' } },
  { key: 'calls', label: 'Call logs and recordings', actions: { view: 'See calls, play recordings', edit: 'Change a call outcome, re-run answers', export: 'Download calls' } },
  { key: 'actions', label: 'Action needed', actions: { view: 'See the list', edit: 'Mark done or reject', export: 'Download the list' } },
  { key: 'agents', label: 'Agents', actions: { view: 'See agents and prompts', create: 'Build a new agent', edit: 'Edit and publish an agent', delete: 'Delete an agent' } },
  { key: 'data', label: 'Data sources', actions: { view: 'See data sources', create: 'Connect a data source', edit: 'Change or run a data source', delete: 'Remove a data source' } },
  { key: 'people', label: 'Team and access', actions: { view: 'See people and their roles', create: 'Invite people, add sub-orgs and teams', edit: 'Change roles, suspend people', delete: 'Remove people, delete units' } },
  { key: 'billing', label: 'Billing and credits', actions: { view: 'See credits and invoices', edit: 'Buy credits, change the plan' } },
  { key: 'settings', label: 'Settings and security', actions: { view: 'See settings', edit: 'Change settings, security, roles and user types' } },
  { key: 'audit', label: 'Audit log', actions: { view: 'See the audit log', export: 'Download the audit log' } },
];
const MOD = Object.fromEntries(MODULES.map((m) => [m.key, m]));
/** 'campaigns:view,create agents:*' → { campaigns: ['view', 'create'], agents: [every action agents has] } */
const P = (spec) => Object.fromEntries(spec.trim().split(/\s+/).map((s) => { const [m, a] = s.split(':'); return [m, a === '*' ? Object.keys(MOD[m].actions) : a.split(',')]; }));
const EVERYTHING = MODULES.map((m) => `${m.key}:*`).join(' ');

// System roles are fixed; duplicate one to make a custom role. `level` is the lowest unit a role can be given in:
// a team role can also be given in a sub-org or the whole org (e.g. a Viewer for everything).
const roles = [
  { key: 'owner', label: 'Org owner', level: 'org', system: true, about: 'Everything, including billing and deleting the organization. At least one person always holds it.', perms: P(EVERYTHING) },
  { key: 'admin', label: 'Org admin', level: 'org', system: true, about: 'Runs the whole organization: people, sub-orgs, agents, campaigns, settings. Cannot buy credits.', perms: { ...P(EVERYTHING), billing: ['view'] } },
  { key: 'billing', label: 'Billing admin', level: 'org', system: true, about: 'Credits, plan and invoices. Sees the dashboard, nothing else.', perms: P('dashboard:* billing:* audit:view') },
  { key: 'auditor', label: 'Auditor', level: 'org', system: true, about: 'Sees and downloads everything, changes nothing. For compliance and internal audit.', perms: P('dashboard:* campaigns:view,export calls:view,export actions:view,export agents:view data:view people:view billing:view settings:view audit:*') },
  { key: 'sub_admin', label: 'Sub-org admin', level: 'sub_org', system: true, about: 'Runs one sub-org: its teams, people, agents and campaigns. Cannot change org settings or billing.', perms: P('dashboard:* campaigns:* calls:* actions:* agents:* data:* people:* settings:view audit:view') },
  { key: 'builder', label: 'Agent builder', level: 'sub_org', system: true, about: 'Builds and publishes agents and data sources. Sees campaigns and calls to test them.', perms: P('dashboard:view campaigns:view calls:view agents:* data:*') },
  { key: 'lead', label: 'Team lead', level: 'team', system: true, about: 'Runs the team’s campaigns and Action needed list, and adds people to the team.', perms: P('dashboard:* campaigns:* calls:* actions:* agents:view data:view people:view,create,edit') },
  { key: 'member', label: 'Member', level: 'team', system: true, about: 'Starts campaigns, works the Action needed list, listens to calls.', perms: P('dashboard:view campaigns:view,create,export calls:view,edit actions:view,edit,export agents:view') },
  { key: 'viewer', label: 'Viewer', level: 'team', system: true, about: 'Sees results only. Phone numbers are masked.', perms: P('dashboard:view campaigns:view calls:view actions:view'), mask_numbers: true },
  { key: 'api', label: 'API access', level: 'org', system: true, about: 'For service accounts: start campaigns and read results through the API. Cannot sign in.', perms: P('campaigns:view,create calls:view,export actions:view data:view') },
];

const types = [
  { key: 'employee', label: 'Employee', who: 'Staff with a company email', sign_in: 'Single sign-on or password', roles: ['owner', 'admin', 'billing', 'auditor', 'sub_admin', 'builder', 'lead', 'member', 'viewer'], mfa: false, expiry_days: 0, teams_only: false },
  { key: 'external', label: 'External partner', who: 'BPO agents, vendors and contractors', sign_in: 'Password with two-step sign-in', roles: ['lead', 'member', 'viewer'], mfa: true, expiry_days: 90, teams_only: true },
  { key: 'guest', label: 'Guest', who: 'A client or reviewer who only looks', sign_in: 'Email link with two-step sign-in', roles: ['viewer'], mfa: true, expiry_days: 30, teams_only: true },
  { key: 'service', label: 'Service account', who: 'Systems calling the API (ERP, CRM)', sign_in: 'API key only, no sign-in', roles: ['api'], mfa: false, expiry_days: 365, teams_only: false },
];

const units = [
  { id: 'org', name: 'Moglix', level: 'org', parent: null },
  { id: 'so_proc', name: 'Procurement', level: 'sub_org', parent: 'org' },
  { id: 'so_fin', name: 'Finance', level: 'sub_org', parent: 'org' },
  { id: 'so_me', name: 'Middle East', level: 'sub_org', parent: 'org' },
  { id: 't_ops', name: 'Procurement ops', level: 'team', parent: 'so_proc' },
  { id: 't_rfx', name: 'RFX desk', level: 'team', parent: 'so_proc' },
  { id: 't_pay', name: 'Payables', level: 'team', parent: 'so_fin' },
  { id: 't_uae', name: 'UAE sourcing', level: 'team', parent: 'so_me' },
];

let seq = 100;
const id = (p) => `${p}${++seq}`;
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const person = (uid, name, email, type, grants, extra = {}) => ({ id: uid, name, email, type, status: 'active', expires: null, last_active: null, invited_at: null, ...extra,
  grants: grants.map(([role, unit]) => ({ id: id('g'), role, unit })) });
const users = [
  person('u1', 'Admin', 'admin@example.com', 'employee', [['owner', 'org']], { last_active: ago(0.2) }),
  person('u2', 'Priya Nair', 'priya.nair@example.com', 'employee', [['sub_admin', 'so_proc']], { last_active: ago(3) }),
  person('u3', 'Ops Buyer 1', 'ops.buyer1@example.com', 'employee', [['lead', 't_ops']], { last_active: ago(1) }),
  person('u4', 'Ops Buyer 2', 'ops.buyer2@example.com', 'employee', [['member', 't_ops']], { last_active: ago(5) }),
  person('u5', 'Rahul Mehra', 'rahul.mehra@example.com', 'employee', [['member', 't_rfx'], ['viewer', 't_pay']], { last_active: ago(26) }),
  person('u6', 'Anita Rao', 'anita.rao@example.com', 'employee', [['lead', 't_pay']], { last_active: ago(8) }),
  person('u7', 'Karan Shah', 'karan.shah@example.com', 'employee', [['builder', 'so_proc']], { last_active: ago(30) }),
  person('u8', 'Audit desk', 'audit@example.com', 'employee', [['auditor', 'org']], { last_active: ago(72) }),
  person('u9', 'Meera Iyer', 'meera.iyer@example.com', 'employee', [['billing', 'org']], { last_active: ago(120) }),
  person('u10', 'Neha (BPO)', 'neha@bpo.example.com', 'external', [['member', 't_ops']], { expires: days(52), last_active: ago(2) }),
  person('u11', 'Omar Khan', 'omar.khan@example.com', 'employee', [['sub_admin', 'so_me']], { status: 'invited', invited_at: ago(20) }),
  person('u12', 'Client reviewer', 'reviewer@client.example.com', 'guest', [['viewer', 't_uae']], { expires: days(12), last_active: ago(48) }),
  person('u13', 'ERP sync', 'erp-sync@service.example.com', 'service', [['api', 'org']], { expires: days(300), last_active: ago(0.5) }),
  person('u14', 'Vikram Das', 'vikram.das@example.com', 'employee', [['member', 't_rfx']], { status: 'suspended', last_active: ago(400) }),
];

// ── What a person can do, and where ──
const unitOf = (uid) => units.find((u) => u.id === uid);
const roleOf = (k) => roles.find((r) => r.key === k);
const typeOf = (k) => types.find((t) => t.key === k);
/** The unit and every unit above it, nearest first. */
function upward(uid) { const out = []; for (let u = unitOf(uid); u; u = unitOf(u.parent)) out.push(u.id); return out; }
/** The unit and every unit under it. */
function downward(uid) { const out = [uid]; for (const u of units) if (u.parent && out.includes(u.parent) && !out.includes(u.id)) out.push(u.id); return out; }
const live = (p) => p.status === 'active' && (!p.expires || Date.parse(p.expires) > Date.now());
/** The person's roles that reach this unit (given here or above). */
const grantsReaching = (p, uid) => (live(p) ? p.grants.filter((g) => upward(uid).includes(g.unit)) : []);
const can = (p, uid, mod, act) => grantsReaching(p, uid).some((g) => roleOf(g.role)?.perms[mod]?.includes(act));
/** Every unit where the person may do this. */
const unitsWhere = (p, mod, act) => units.filter((u) => can(p, u.id, mod, act)).map((u) => u.id);
/** A role may be given only by someone who can already do everything it allows, in that unit. */
const covers = (p, uid, role) => Object.entries(role.perms).every(([m, acts]) => acts.every((a) => can(p, uid, m, a)));

/** Why a role cannot be given to this person in this unit, or '' when it can. */
function grantProblem(actor, target, roleKey, uid) {
  const role = roleOf(roleKey); const unit = unitOf(uid); const type = typeOf(target.type);
  if (!role || !unit) return 'Pick a role and a unit';
  if (!can(actor, uid, 'people', 'edit') && !can(actor, uid, 'people', 'create')) return `You do not manage people in ${unit.name}`;
  if (RANK[unit.level] > RANK[role.level]) return `${role.label} can only be given in ${role.level === 'org' ? 'the whole organization' : 'a sub-org or the whole organization'}`;
  if (!type.roles.includes(roleKey)) return `${type.label}s cannot hold ${role.label}`;
  if (type.teams_only && unit.level !== 'team') return `${type.label}s can only be given roles in a team`;
  if (!covers(actor, uid, role)) return `You cannot give ${role.label}: it allows more than you can do in ${unit.name}`;
  if (target.grants.some((g) => g.role === roleKey && g.unit === uid)) return 'They already have that role there';
  return '';
}
/** People changes (type, status, removal) need the actor to manage every unit the person is in. */
function manageProblem(actor, target, act = 'edit') {
  if (actor.id === target.id) return 'You cannot change your own access. Ask another admin.';
  const out = target.grants.map((g) => g.unit).filter((u) => !can(actor, u, 'people', act));
  return out.length ? `They also have access in ${[...new Set(out)].map((u) => unitOf(u).name).join(', ')}, which you do not manage` : '';
}
const owners = () => users.filter((u) => live(u) && u.grants.some((g) => g.role === 'owner' && g.unit === 'org'));
const lastOwner = (target) => owners().length === 1 && owners()[0].id === target.id;

function effective(p) {
  const out = {};
  for (const m of MODULES) { out[m.key] = {};
    for (const a of Object.keys(m.actions)) {
      const why = live(p) ? p.grants.filter((g) => roleOf(g.role)?.perms[m.key]?.includes(a)).map((g) => `${roleOf(g.role).label} in ${unitOf(g.unit)?.name}`) : [];
      if (why.length) out[m.key][a] = why;
    }
  }
  return out;
}
const pathOf = (uid) => upward(uid).reverse().map((u) => unitOf(u).name).join(' › ');
function statusOf(p) {
  if (p.status !== 'active') return p.status;
  if (p.expires && Date.parse(p.expires) <= Date.now()) return 'expired';
  return 'active';
}

/** The whole screen, as the actor sees it: only the units where they can see people, and what they can change there. */
export function accessView(actorId) {
  const actor = users.find((u) => u.id === actorId) || users[0];
  const seeUnits = unitsWhere(actor, 'people', 'view');
  const settings = can(actor, 'org', 'settings', 'edit');
  const base = { actor: actor.id, levels: LEVELS, actions: ACTIONS, modules: MODULES,
    people_to_preview: users.filter(live).map((u) => ({ id: u.id, name: u.name, summary: u.grants.map((g) => `${roleOf(g.role)?.label} · ${unitOf(g.unit)?.name}`).join(', ') })) };
  if (!seeUnits.length) return { ...base, blocked: `${actor.name} cannot see Team and access. Their roles do not include seeing people.`, units: [], users: [], roles: [], types: [], can_manage_roles: false };
  const visible = new Set(seeUnits);
  const atOrg = visible.has('org');
  const vUnits = units.filter((u) => visible.has(u.id)).map((u) => {
    const kids = units.filter((k) => k.parent === u.id);
    const here = users.filter((p) => p.grants.some((g) => g.unit === u.id));
    return { ...u, path: pathOf(u.id), child_level: u.level === 'org' ? 'sub_org' : u.level === 'sub_org' ? 'team' : null,
      people: users.filter((p) => grantsReaching({ ...p, status: 'active', expires: null }, u.id).length).length, here: here.length,
      can_edit: can(actor, u.id, 'people', 'edit'), can_add: u.level !== 'team' && can(actor, u.id, 'people', 'create'),
      can_delete: !!u.parent && !kids.length && !here.length && can(actor, u.parent, 'people', 'delete'),
      roles_here: roles.filter((r) => RANK[u.level] <= RANK[r.level] && covers(actor, u.id, r)).map((r) => r.key) };
  });
  const vUsers = users.filter((p) => p.grants.some((g) => visible.has(g.unit)) || (atOrg && !p.grants.length)).map((p) => ({
    ...p, state: statusOf(p),
    grants: p.grants.map((g) => ({ ...g, role_label: roleOf(g.role)?.label || g.role, unit_name: unitOf(g.unit)?.name || '?', level: unitOf(g.unit)?.level,
      can_remove: actor.id !== p.id && can(actor, g.unit, 'people', 'edit') && covers(actor, g.unit, roleOf(g.role)) && !(g.role === 'owner' && lastOwner(p)) })),
    can_edit: !manageProblem(actor, p), can_remove: !manageProblem(actor, p, 'delete') && !lastOwner(p),
    effective: effective(p) }));
  return { ...base, can_manage_roles: settings, can_invite: units.some((u) => can(actor, u.id, 'people', 'create')),
    units: vUnits, users: vUsers,
    roles: roles.map((r) => ({ ...r, people: users.filter((p) => p.grants.some((g) => g.role === r.key)).length })),
    types: types.map((t) => ({ ...t, people: users.filter((p) => p.type === t.key).length })) };
}

const err = (error) => ({ error });
const clean = (s, n = 80) => String(s ?? '').trim().slice(0, n);
const actorOf = (aid) => users.find((u) => u.id === aid) || users[0];

/** Add a unit, a person (invite), a role in a unit (grant) or a custom role. */
export function accessCreate(kind, b = {}, aid) {
  const actor = actorOf(aid);
  if (kind === 'unit') {
    const parent = unitOf(b.parent); if (!parent) return err('Pick where it goes');
    if (parent.level === 'team') return err('Teams cannot have units under them');
    if (!can(actor, parent.id, 'people', 'create')) return err(`You cannot add units in ${parent.name}`);
    const name = clean(b.name, 60); if (!name) return err('Give it a name');
    if (units.some((u) => u.parent === parent.id && u.name.toLowerCase() === name.toLowerCase())) return err(`${parent.name} already has ${name}`);
    const u = { id: id(parent.level === 'org' ? 'so_' : 't_'), name, level: parent.level === 'org' ? 'sub_org' : 'team', parent: parent.id }; units.push(u); return { ok: u.id };
  }
  if (kind === 'user') {
    const email = clean(b.email, 120).toLowerCase(); const type = typeOf(b.type);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('Enter a valid email');
    if (!type) return err('Pick a user type');
    if (users.some((u) => u.email === email)) return err('That person is already here. Give them a role from their row.');
    const draft = { id: '', type: type.key, grants: [] };
    const problem = grantProblem(actor, draft, b.role, b.unit); if (problem) return err(problem);
    const p = person(`u${++seq}`, clean(b.name, 60) || email.split('@')[0], email, type.key, [[b.role, b.unit]],
      { status: type.key === 'service' ? 'active' : 'invited', invited_at: nowIso(), expires: type.expiry_days ? days(type.expiry_days) : null });
    users.push(p); return { ok: p.id, note: type.key === 'service' ? 'Service account made. Its API key is in Settings › Developer.' : `Invite sent to ${email}.` };
  }
  if (kind === 'grant') {
    const target = users.find((u) => u.id === b.user); if (!target) return err('Person not found');
    if (actor.id === target.id) return err('You cannot change your own access. Ask another admin.');
    const problem = grantProblem(actor, target, b.role, b.unit); if (problem) return err(problem);
    target.grants.push({ id: id('g'), role: b.role, unit: b.unit }); return { ok: true };
  }
  if (kind === 'role') {
    if (!can(actor, 'org', 'settings', 'edit')) return err('Only org owners and admins can make roles');
    const from = roleOf(b.from); if (!from) return err('Pick a role to start from');
    const label = clean(b.label, 40) || `${from.label} (custom)`;
    if (roles.some((r) => r.label.toLowerCase() === label.toLowerCase())) return err('A role with that name exists');
    const r = { key: id('r_'), label, level: from.level, system: false, about: from.about, perms: structuredClone(from.perms), mask_numbers: !!from.mask_numbers };
    roles.push(r); types.filter((t) => t.roles.includes(from.key)).forEach((t) => t.roles.push(r.key)); return { ok: r.key };
  }
  return err('Unknown kind');
}

/** Rename a unit; change a person's name, type, status or end date; change a custom role; change a user type. */
export function accessUpdate(kind, key, b = {}, aid) {
  const actor = actorOf(aid);
  if (kind === 'unit') {
    const u = unitOf(key); if (!u) return err('Unit not found'); if (!can(actor, u.id, 'people', 'edit')) return err(`You do not manage ${u.name}`);
    const name = clean(b.name, 60); if (!name) return err('Give it a name'); u.name = name; return { ok: true };
  }
  if (kind === 'user') {
    const p = users.find((u) => u.id === key); if (!p) return err('Person not found');
    const problem = manageProblem(actor, p); if (problem) return err(problem);
    if (b.type && b.type !== p.type) {
      const t = typeOf(b.type); if (!t) return err('Unknown user type');
      const bad = p.grants.filter((g) => !t.roles.includes(g.role) || (t.teams_only && unitOf(g.unit)?.level !== 'team'));
      if (bad.length) return err(`Remove ${bad.map((g) => `${roleOf(g.role).label} in ${unitOf(g.unit).name}`).join(', ')} first: a ${t.label.toLowerCase()} cannot hold it`);
      p.type = t.key; if (t.expiry_days && !p.expires) p.expires = days(t.expiry_days);
    }
    if (b.status && b.status !== p.status) {
      if (!['active', 'suspended'].includes(b.status)) return err('Unknown status');
      if (b.status === 'suspended' && lastOwner(p)) return err('They are the only org owner. Make someone else owner first.');
      p.status = p.status === 'invited' && b.status === 'active' ? 'invited' : b.status;
    }
    if ('expires' in b) {
      const t = typeOf(p.type); const at = b.expires ? Date.parse(b.expires) : null;
      if (!at && t.expiry_days) return err(`${t.label}s must have an end date`);
      if (at && t.expiry_days && at - Date.now() > t.expiry_days * 864e5 + 864e5) return err(`${t.label} access can last at most ${t.expiry_days} days`);
      p.expires = at ? new Date(at).toISOString() : null;
    }
    if (b.name !== undefined) p.name = clean(b.name, 60) || p.name;
    if (b.resend) p.invited_at = nowIso();
    return { ok: true };
  }
  if (kind === 'role') {
    const r = roleOf(key); if (!r) return err('Role not found');
    if (r.system) return err('System roles are fixed. Duplicate it to make your own.');
    if (!can(actor, 'org', 'settings', 'edit')) return err('Only org owners and admins can change roles');
    if (b.label !== undefined) { const l = clean(b.label, 40); if (!l) return err('Give it a name'); if (roles.some((x) => x !== r && x.label.toLowerCase() === l.toLowerCase())) return err('A role with that name exists'); r.label = l; }
    if (b.about !== undefined) r.about = clean(b.about, 200);
    if (b.mask_numbers !== undefined) r.mask_numbers = !!b.mask_numbers;
    if (b.level && RANK[b.level] !== undefined) r.level = b.level;
    if (b.perms) r.perms = Object.fromEntries(MODULES.map((m) => [m.key, (b.perms[m.key] || []).filter((a) => a in m.actions)]).filter(([, a]) => a.length));
    return { ok: true };
  }
  if (kind === 'type') {
    const t = typeOf(key); if (!t) return err('User type not found');
    if (!can(actor, 'org', 'settings', 'edit')) return err('Only org owners and admins can change user types');
    if (b.mfa !== undefined) t.mfa = !!b.mfa;
    if (b.expiry_days !== undefined) { const n = Math.max(0, Math.min(730, Math.round(+b.expiry_days || 0))); if (t.key !== 'employee' && !n) return err(`${t.label}s need an end date`); t.expiry_days = n; }
    if (Array.isArray(b.roles)) {
      const keep = b.roles.filter((k) => roleOf(k)); if (!keep.length) return err('Allow at least one role');
      const held = users.filter((p) => p.type === t.key).flatMap((p) => p.grants).filter((g) => !keep.includes(g.role));
      if (held.length) return err(`${[...new Set(held.map((g) => roleOf(g.role).label))].join(', ')} is still held by a ${t.label.toLowerCase()}`);
      t.roles = keep;
    }
    return { ok: true };
  }
  return err('Unknown kind');
}

/** Delete an empty unit, remove a person, take away one role, or delete an unused custom role. */
export function accessRemove(kind, key, aid) {
  const actor = actorOf(aid);
  if (kind === 'unit') {
    const u = unitOf(key); if (!u || !u.parent) return err('The organization cannot be deleted here');
    if (!can(actor, u.parent, 'people', 'delete')) return err(`You cannot delete units in ${unitOf(u.parent).name}`);
    if (units.some((k) => k.parent === u.id)) return err(`Delete or move the units in ${u.name} first`);
    if (users.some((p) => p.grants.some((g) => g.unit === u.id))) return err(`Take away the roles people hold in ${u.name} first`);
    units.splice(units.indexOf(u), 1); return { ok: true };
  }
  if (kind === 'user') {
    const p = users.find((u) => u.id === key); if (!p) return err('Person not found');
    const problem = manageProblem(actor, p, 'delete'); if (problem) return err(problem);
    if (lastOwner(p)) return err('They are the only org owner. Make someone else owner first.');
    users.splice(users.indexOf(p), 1); return { ok: true };
  }
  if (kind === 'grant') {
    const p = users.find((u) => u.grants.some((g) => g.id === key)); if (!p) return err('Role not found');
    const g = p.grants.find((x) => x.id === key); const unit = unitOf(g.unit);
    if (actor.id === p.id) return err('You cannot change your own access. Ask another admin.');
    if (!can(actor, g.unit, 'people', 'edit')) return err(`You do not manage people in ${unit.name}`);
    if (!covers(actor, g.unit, roleOf(g.role))) return err(`You cannot take away ${roleOf(g.role).label}: it allows more than you can do`);
    if (g.role === 'owner' && lastOwner(p)) return err('They are the only org owner. Make someone else owner first.');
    p.grants = p.grants.filter((x) => x !== g); return { ok: true };
  }
  if (kind === 'role') {
    const r = roleOf(key); if (!r) return err('Role not found'); if (r.system) return err('System roles cannot be deleted');
    if (!can(actor, 'org', 'settings', 'edit')) return err('Only org owners and admins can delete roles');
    const n = users.filter((p) => p.grants.some((g) => g.role === key)).length; if (n) return err(`${n} ${n === 1 ? 'person holds' : 'people hold'} this role. Give them another role first.`);
    roles.splice(roles.indexOf(r), 1); types.forEach((t) => { t.roles = t.roles.filter((k) => k !== key); }); return { ok: true };
  }
  return err('Unknown kind');
}

/** The signed-in person's id, from their email; the first owner when they are not in the list. */
export const accessActorFor = (email) => users.find((u) => u.email === email)?.id || owners()[0]?.id || 'u1';

// ── Preview as: the rest of the app follows the person picked in Team and access ──
// The app sends the picked person on every request (x-preview-as). The mock then hides what they cannot see, refuses what
// they cannot do and masks numbers for Viewers. With nobody picked, nothing changes.
let previewId = null;
const previewer = () => (previewId ? users.find((u) => u.id === previewId) || null : null);
/** Picks the person for this request; returns them, or null when nobody (or the signed-in person) is picked. */
export function setPreview(aid, realId) { previewId = aid && aid !== realId && users.some((u) => u.id === aid) ? aid : null; return previewer(); }

// Campaigns belong to a team. Demo data has no owner team, so it is spread over the four seed teams by its id;
// a campaign started while previewing goes to the first team where that person may start campaigns.
const SEED_TEAMS = ['t_ops', 't_rfx', 't_pay', 't_uae'];
const campaignUnits = new Map();
export function campaignUnit(key) {
  const k = String(key || ''); if (campaignUnits.has(k)) return campaignUnits.get(k);
  if (!k || k === 'console') return 't_ops';
  let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const t = SEED_TEAMS[h % SEED_TEAMS.length]; return unitOf(t) ? t : 'org';
}
/** Call when a campaign is created, so it lands in the previewed person's team. */
export function claimCampaign(key) { const p = previewer(); if (!p) return; const u = unitsWhere(p, 'campaigns', 'create').sort((a, b) => RANK[unitOf(b).level] - RANK[unitOf(a).level])[0]; if (u) campaignUnits.set(String(key), u); }
const SEE = ['campaigns', 'calls', 'actions'];
/** Whether the previewed person sees this campaign (and its calls). */
export function seesCampaign(key) { const p = previewer(); if (!p) return true; const u = campaignUnit(key); return SEE.some((m) => can(p, u, m, 'view')); }

// Which area each request belongs to (Echo /api/... and Clarix /api/v1/... paths). First match wins; null = not checked here.
const AREAS = [
  [/\/access(\/|$)|\/auth\/|\/api\/me$|\/health$|\/__local/, null],
  [/\/audit/, 'audit'],
  [/\/credits|\/wallet|\/billing/, 'billing'],
  [/\/data-sources|\/admin\/data-functions|\/integrations|\/sync-platforms/, 'data'],
  [/\/follow-ups/, 'actions'],
  [/\/new-campaign|\/campaigns|\/workflows\/sheets|\/workflows\/trigger|\/workflows\/reports/, 'campaigns'],
  [/\/call\/|\/calls(\/|$|\.)|\/live(\/|$)|\/conversations|\/copilot|\/supplier|^\/api\/v1\/workflows(\/[^/]+)?(\/events|\/cancel|\/stop|\/execute-now|\/sync-status)?$|\/ozonetel\/start_call|\/webrtc\/(start_call|recording)/, 'calls'],
  [/\/agents|\/agent-stats|\/versions\/|\/tests\/|\/quality\/|\/call-handling|\/workflow-templates|\/retry-rules|\/transformation-catalog/, 'agents'],
  [/\/orgs\/[^/]+\/(users|groups)|\/admin\/users/, 'people'],
  [/\/settings|\/security|\/telephony|\/calling-rules|\/dnc|\/alerts|\/test-numbers|\/data-policy|\/admin\/|\/call-providers/, 'settings'],
  [/\/report$|\/reports\/calling$|\/metrics|\/tasks|\/dashboard/, 'dashboard'],
];
const READ_LIKE = /\/preview$|\/copilot$|\/messages$|\/test$|\/check$|\/recheck$|\/refresh$/;
const CREATE_AT = /\/api\/campaigns$|\/new-campaign\/start$|\/workflows\/trigger\/bulk$|\/api\/agents$|\/workflow-templates$|\/data-functions$/;
function areaOf(method, path) {
  const hit = AREAS.find(([re]) => re.test(path)); if (!hit || !hit[1]) return null;
  const mod = MOD[hit[1]];
  let act = method === 'GET' ? (/export|\.xlsx|download|transcript\.txt/.test(path) ? 'export' : 'view')
    : READ_LIKE.test(path) ? 'view' : method === 'DELETE' ? 'delete' : CREATE_AT.test(path) || /\/new-campaign\//.test(path) ? 'create' : 'edit';
  if (!mod.actions[act]) act = mod.actions.edit && act !== 'export' ? 'edit' : 'view';
  return { mod: mod.key, act };
}
/** Why the previewed person may not make this request, or '' when they may (or nobody is previewed). */
export function previewBlock(method, path) {
  const p = previewer(); if (!p) return '';
  const a = areaOf(method, path); if (!a) return '';
  // Settings and credits are read by every page (limits, wallet); only their own pages and changes are checked.
  if (method === 'GET' && (a.mod === 'settings' || a.mod === 'billing') && a.act === 'view') return '';
  if (!live(p)) return `${p.name} cannot sign in: their access is ${statusOf(p)}. You are previewing as them.`;
  if (p.type === 'service') return `${p.name} is a service account: it uses the API and cannot sign in. You are previewing as them.`;
  const camp = /\/campaigns\/([^/]+)/.exec(path)?.[1] || /\/sheets\/([^/]+)/.exec(path)?.[1];
  const ok = camp && a.mod !== 'agents' ? can(p, campaignUnit(decodeURIComponent(camp)), a.mod, a.act) : unitsWhere(p, a.mod, a.act).length > 0;
  if (ok) return '';
  const what = MOD[a.mod].actions[a.act]; return `${p.name} cannot ${what[0].toLowerCase()}${what.slice(1)}. You are previewing as them.`;
}
/** Viewers (and anyone who only sees calls through a role that masks numbers) get masked phone numbers. */
const masksVia = (gs) => { const via = gs.filter((g) => roleOf(g.role)?.perms.calls?.includes('view')); return via.length > 0 && via.every((g) => roleOf(g.role).mask_numbers); };
const masks = (p) => masksVia(live(p) ? p.grants : []);
const PHONE_KEY = /phone|mobile|msisdn|called_?number|caller_?number|customer_?number/i;
const maskOne = (v) => { const s = String(v); const d = s.replace(/\D/g, ''); return d.length >= 7 ? '•'.repeat(Math.max(0, d.length - 4)) + d.slice(-4) : v; };
const CAMP_KEY = ['campaign_id', 'batchId', 'batch_id', 'sheetId'];
/** Drops list items from campaigns the previewed person does not see, and masks numbers when their role says so. */
export function previewShape(body) {
  const p = previewer(); if (!p) return body;
  // Masking follows the campaign: Rahul is a Member in RFX desk (numbers shown) and a Viewer in Payables (numbers masked).
  const walk = (x, key, mask) => {
    if (Array.isArray(x)) return x.filter((it) => !(it && typeof it === 'object' && !Array.isArray(it) && CAMP_KEY.some((k) => it[k] != null && !seesCampaign(it[k])))).map((it) => walk(it, key, mask));
    if (x && typeof x === 'object') {
      const ck = CAMP_KEY.find((k) => x[k] != null); const m = ck ? masksVia(grantsReaching(p, campaignUnit(x[ck]))) : mask;
      const o = {}; for (const [k, v] of Object.entries(x)) o[k] = walk(v, k, m); return o;
    }
    if (mask && key && PHONE_KEY.test(key) && (typeof x === 'string' || typeof x === 'number')) return maskOne(x);
    return x;
  };
  return walk(body, '', masks(p));
}
/** What the app needs to show menus and buttons for the previewed person (or the signed-in person when nobody is picked). */
export function accessMe(aid, realId) {
  const p = users.find((u) => u.id === aid) || actorOf(realId); const real = actorOf(realId);
  const canDo = Object.fromEntries(MODULES.map((m) => [m.key, Object.keys(m.actions).filter((a) => unitsWhere(p, m.key, a).length)]));
  const teams = units.filter((u) => SEE.some((m) => can(p, u.id, m, 'view')));
  const blocked = !live(p) ? `${p.name} cannot sign in: their access is ${statusOf(p)}.` : p.type === 'service' ? `${p.name} is a service account. It uses the API and cannot sign in.` : '';
  return { id: p.id, name: p.name, email: p.email, type: typeOf(p.type)?.label || p.type, previewing: p.id !== real.id, blocked,
    roles: p.grants.map((g) => `${roleOf(g.role)?.label} in ${unitOf(g.unit)?.name}`), can: blocked ? {} : canDo, mask_numbers: masks(p),
    units: teams.some((u) => u.id === 'org') ? ['the whole organization'] : teams.filter((u) => !teams.some((x) => x.id === u.parent)).map((u) => u.name),
    people: users.filter((u) => u.id !== real.id).map((u) => ({ id: u.id, name: u.name, summary: u.grants.map((g) => `${roleOf(g.role)?.label} · ${unitOf(g.unit)?.name}`).join(', ') || typeOf(u.type)?.label, state: statusOf(u) })) };
}
