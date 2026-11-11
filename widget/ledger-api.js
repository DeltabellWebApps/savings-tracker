// Ledger for Scriptable: sign-in and loading data from Supabase, shared by "Ledger Widget" and "Ledger Spend".
// Save this in Scriptable as "ledger-api", next to "ledger-core" (copied from the root of the repo).
// Only the Supabase session (never the password) is kept, in the iOS keychain.

const core = importModule('ledger-core');

const SUPABASE_URL = 'https://vpbrurxowgneplxpwkkv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwYnJ1cnhvd2duZXBseHB3a2t2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MzAwNzcsImV4cCI6MjEwNjEwNjA3N30.3yq74-z1tkQDNA8BB6JFG3_yFwLN-yjHz_7WJyrAqDs';
const APP_URL = 'https://deltabellwebapps.github.io/savings-tracker/';
const SESSION_KEY = 'ledger.session';

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), 'ledger-cache.json');

class AuthError extends Error {}

// ---------- Auth ----------
async function authRequest(grant, body) {
  const req = new Request(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`);
  req.method = 'POST';
  req.headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  req.body = JSON.stringify(body);
  const res = await req.loadJSON();
  if (req.response.statusCode !== 200) {
    throw new AuthError(res.error_description || res.msg || 'Sign-in failed');
  }
  const session = {
    access: res.access_token,
    refresh: res.refresh_token,
    expiresAt: Date.now() + (res.expires_in - 60) * 1000,
  };
  Keychain.set(SESSION_KEY, JSON.stringify(session));
  return session;
}

function isSignedIn() {
  return Keychain.contains(SESSION_KEY);
}

async function getAccessToken(forceRefresh) {
  if (!isSignedIn()) return null;
  const session = JSON.parse(Keychain.get(SESSION_KEY));
  if (!forceRefresh && Date.now() < session.expiresAt) return session.access;
  try {
    return (await authRequest('refresh_token', { refresh_token: session.refresh })).access;
  } catch (e) {
    if (e instanceof AuthError) Keychain.remove(SESSION_KEY);
    throw e;
  }
}

// Asks for email and password in an alert. Returns true once signed in.
async function signIn() {
  const a = new Alert();
  a.title = 'Sign in to Ledger';
  a.message = 'Use the same email and password as the website.';
  a.addTextField('Email');
  a.addSecureTextField('Password');
  a.addAction('Sign in');
  a.addCancelAction('Cancel');
  if (await a.presentAlert() === -1) return false;
  try {
    await authRequest('password', { email: a.textFieldValue(0).trim(), password: a.textFieldValue(1) });
    return true;
  } catch (e) {
    const err = new Alert();
    err.title = "Couldn't sign in";
    err.message = e.message;
    err.addAction('OK');
    await err.presentAlert();
    return false;
  }
}

function signOut() {
  if (isSignedIn()) Keychain.remove(SESSION_KEY);
  if (fm.fileExists(cachePath)) fm.remove(cachePath);
}

// ---------- REST ----------
// Calls the Supabase REST API, refreshing the session once if the token is turned down.
async function call(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(attempt > 0);
    if (!token) throw new AuthError('Signed out');
    const req = new Request(`${SUPABASE_URL}/rest/v1/${path}`);
    req.method = method;
    req.headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (method !== 'GET') req.headers.Prefer = 'return=representation';
    if (body) req.body = JSON.stringify(body);
    const res = await req.loadJSON();
    const status = req.response.statusCode;
    if (status === 401 && attempt === 0) continue;
    if (status === 401) throw new AuthError('Session expired');
    if (status < 200 || status >= 300) {
      const err = new Error((res && res.message) || `Supabase returned ${status}`);
      err.status = status;
      err.code = res && res.code;
      throw err;
    }
    return res;
  }
}

// Supabase hands back at most 1,000 rows per request, so a list is fetched a page at a time until a short page
// comes back. `path` must be ordered down to `id` so the pages can't overlap or skip rows.
const PAGE_SIZE = 1000;

async function getAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await call('GET', `${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// Savings accounts need migration 003; until it's run those tables don't exist, so treat them as empty.
// Any other failure (no signal, say) is a real one, so it's passed on rather than read as "no accounts".
async function optional(path) {
  try {
    return await getAll(path);
  } catch (e) {
    if (e.code === 'PGRST205' || e.code === '42P01') return [];
    throw e;
  }
}

// Everything the widget and the quick spend script need, as raw rows.
async function fetchRows() {
  const period = core.currentPayPeriod();
  const sinceDay = core.toISODate(period.start);
  const [goals, deposits, bills, payments, budgets, spends, balances, accounts, accountEntries, transfers] = await Promise.all([
    getAll('goals?select=*&order=sort_order.asc.nullslast,id.asc'),
    // All goal entries, not just this period's: what each goal holds in each account adds them all up.
    getAll('deposits?select=*&order=created_at.asc,id.asc'),
    getAll('bills?select=*&order=created_at.asc,id.asc'),
    getAll('bill_payments?select=*&order=due_date.desc,id.asc'),
    getAll('budgets?select=*&order=sort_order.asc,created_at.asc,id.asc'),
    getAll(`spends?select=*&spent_on=gte.${sinceDay}&order=spent_on.asc,id.asc`),
    getAll('balances?select=*&order=created_at.asc,id.asc'),
    optional('accounts?select=*&order=sort_order.asc,created_at.asc,id.asc'),
    optional('account_balances?select=*&order=created_at.asc,id.asc'),
    optional('transfers?select=*&order=moved_on.asc,id.asc'),
  ]);
  return { goals, deposits, bills, payments, budgets, spends, balances, accounts, accountEntries, transfers };
}

// Raw rows to the shapes ledger-core works with, plus the ledger itself.
function build(rows) {
  const map = (list, fn) => (list || []).map(fn);
  const r = core.fromRow;
  const data = {
    goals: map(rows.goals, r.goal),
    deposits: map(rows.deposits, r.deposit),
    bills: map(rows.bills, r.bill),
    payments: map(rows.payments, r.payment),
    budgets: map(rows.budgets, r.budget),
    spends: map(rows.spends, r.spend),
    balances: map(rows.balances, r.balance),
    accounts: map(rows.accounts, r.account),
    accountEntries: map(rows.accountEntries, r.accountEntry),
    transfers: map(rows.transfers, r.transfer),
  };
  return { data, L: core.ledger(data) };
}

function readCache() {
  try {
    return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null;
  } catch (e) {
    return null;
  }
}

// Returns { L, data, at, stale } or { signedOut: true } or { error }. Falls back to the last copy when offline.
// A copy from an earlier pay period is no use, so it's only used if it was fetched since this payday.
async function loadLedger() {
  if (!isSignedIn()) return { signedOut: true };
  try {
    const rows = await fetchRows();
    const at = Date.now();
    fm.writeString(cachePath, JSON.stringify({ rows, at }));
    return { ...build(rows), at, stale: false };
  } catch (e) {
    if (e instanceof AuthError) return { signedOut: true };
    const cached = readCache();
    if (cached && cached.at >= core.currentPayPeriod().start.getTime()) {
      return { ...build(cached.rows), at: cached.at, stale: true };
    }
    return { error: "Couldn't connect" };
  }
}

// Logs a spend against a budget, dated today. Returns the new row.
async function addSpend(budgetId, amount, note) {
  const rows = await call('POST', 'spends', [{
    budget_id: budgetId, amount, note: note || null, spent_on: core.toISODate(core.startOfToday())
  }]);
  return core.fromRow.spend(rows[0]);
}

// Logs money added to a goal today — straight from the current account, or paid straight out of it for a
// straight-out goal — into wherever the goal's money usually goes (`accountId`, from `L.accountOf(goal)`, or
// null for the current account). The same shapes the website's Move money sheet builds for "+ Add"/"+ Pay",
// just this one simple case (one goal, one direction, the current account on the other side), through the
// same all-or-nothing `move_money` function (migration 007) so a deposit and its transfer never save apart.
async function addDeposit(goal, accountId, amount, note) {
  const today = core.toISODate(core.startOfToday());
  const transfers = accountId ? [{
    key: accountId, account_id: accountId, moved_on: today, note: null, due_date: null,
    amount: goal.straightOut ? -amount : amount, external: goal.straightOut
  }] : [];
  const entries = [{
    goal_id: goal.id, amount, note: note || null, external: false, paid_out: false,
    account_id: accountId || null, transfer_key: accountId || null, created_at: null
  }];
  const made = await call('POST', 'rpc/move_money', { p_transfers: transfers, p_entries: entries });
  return core.fromRow.deposit(made.deposits[0]);
}

module.exports = {
  APP_URL, AuthError, isSignedIn, signIn, signOut, loadLedger, addSpend, addDeposit,
};
