// Ledger widget for Scriptable (https://scriptable.app). Save it in Scriptable as "Ledger Widget".
// Needs "ledger-core" (from the root of the repo) and "ledger-api" (from this folder) saved next to it.
//
// Run it once in the Scriptable app to sign in. Then add a Scriptable widget, pick this script, and set the
// widget's Parameter to one of:
//   free     — free to spend per day, days to payday, the bank balance forecast (the default)
//   coming   — bills and standing orders still to go out this pay period
//   savings  — savings accounts, unassigned money and goal progress
//   budgets  — what's left in each budget, against an even pace. Tapping it opens "Ledger Spend" if you have it.
// Every mode works in the small, medium and large Home Screen sizes and the three Lock Screen sizes.

const core = importModule('ledger-core');
const api = importModule('ledger-api');
const { formatMoney, startOfToday, addDays, pctOf, isDone, ISA_ALLOWANCE } = core;

const MODES = ['free', 'coming', 'savings', 'budgets'];
const SPEND_SCRIPT = 'Ledger Spend';
const SAVE_SCRIPT = 'Ledger Save';
const REFRESH_MINUTES = 15;

// Same palette as the web app, light and dark.
const dyn = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
const C = {
  bg: dyn('#FFFDF8', '#202823'),
  ink: dyn('#1F2A24', '#EDE8DC'),
  soft: dyn('#5B6459', '#A6ADA2'),
  line: dyn('#D8D2C2', '#34403A'),
  gold: dyn('#B8863B', '#D6A758'),
  done: dyn('#22392F', '#DDE7DE'),
  danger: dyn('#A24A3B', '#D98C79'),
};

// ---------- Formatting ----------
const money = n => formatMoney(n);
const pounds = n => (n < 0 ? '-' : '') + '£' + Math.round(Math.abs(n)).toLocaleString('en-GB'); // no pence, for tight spots
const shortDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const dayName = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function whenLabel(d) {
  const days = Math.round((d - startOfToday()) / 86400000);
  if (days < 0) return `Overdue · ${shortDate(d)}`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return dayName(d);
}

function timeLabel(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Drawing ----------
function addText(parent, str, font, color, opts = {}) {
  const t = parent.addText(String(str));
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = opts.lines || 1;
  if (opts.scale) t.minimumScaleFactor = opts.scale;
  return t;
}

function addBar(parent, width, pct, color, track) {
  const height = 6;
  const bar = parent.addStack();
  bar.size = new Size(width, height);
  bar.cornerRadius = height / 2;
  bar.backgroundColor = track || C.line;
  const fillWidth = pct > 0 ? Math.max(height, (width * Math.min(100, pct)) / 100) : 0;
  if (fillWidth > 0) {
    const fill = bar.addStack();
    fill.size = new Size(fillWidth, height);
    fill.cornerRadius = height / 2;
    fill.backgroundColor = color || C.gold;
  }
  bar.addSpacer();
}

function addLabel(parent, str, color) {
  addText(parent, str, Font.semiboldMonospacedSystemFont(10), color || C.gold);
}

function addHeader(w, title, right, rightColor) {
  const head = w.addStack();
  head.centerAlignContent();
  addText(head, title, Font.boldSystemFont(15), C.ink);
  head.addSpacer();
  if (right) addText(head, right, Font.mediumMonospacedSystemFont(11), rightColor || C.gold, { scale: 0.7 });
}

// A name on the left and an amount on the right, with an optional line under the name.
function addRow(parent, name, amount, sub, opts = {}) {
  const row = parent.addStack();
  row.centerAlignContent();
  const left = row.addStack();
  left.layoutVertically();
  addText(left, name, Font.mediumSystemFont(opts.compact ? 12 : 13), C.ink);
  if (sub) addText(left, sub, Font.regularSystemFont(10), opts.subColor || C.soft);
  row.addSpacer(6);
  row.addSpacer();
  addText(row, amount, Font.mediumMonospacedSystemFont(opts.compact ? 11 : 12), opts.amountColor || C.ink, { scale: 0.7 });
}

// A name and amount over a progress bar.
function addBarRow(parent, name, right, pct, width, opts = {}) {
  const row = parent.addStack();
  row.layoutVertically();
  const top = row.addStack();
  top.centerAlignContent();
  addText(top, name, Font.mediumSystemFont(opts.compact ? 12 : 13), C.ink);
  top.addSpacer();
  addText(top, right, Font.regularMonospacedSystemFont(11), opts.rightColor || C.soft, { scale: 0.7 });
  row.addSpacer(4);
  addBar(row, width, pct, opts.color);
  if (opts.sub) {
    row.addSpacer(3);
    addText(row, opts.sub, Font.regularSystemFont(10), opts.subColor || C.soft);
  }
}

function addFooter(w, ctx, always) {
  if (!always && !ctx.stale) return;
  w.addSpacer(6);
  addText(w, `${ctx.stale ? 'Offline · ' : ''}Updated ${timeLabel(ctx.at)}`, Font.regularSystemFont(9), C.soft);
}

function circular(w, big, small) {
  w.addAccessoryWidgetBackground = true;
  const s = w.addStack();
  s.layoutVertically();
  s.centerAlignContent();
  [addText(s, big, Font.boldRoundedSystemFont(15), null, { scale: 0.5 }), addText(s, small, Font.regularSystemFont(9))]
    .forEach(t => t.centerAlignText());
}

function messageWidget(w, family, title, body) {
  if (family.startsWith('accessory')) {
    addText(w, title, Font.semiboldSystemFont(12), null, { lines: 2 });
    return w;
  }
  addLabel(w, 'LEDGER');
  w.addSpacer(6);
  addText(w, title, Font.semiboldSystemFont(14), C.ink, { lines: 2 });
  w.addSpacer(4);
  addText(w, body, Font.regularSystemFont(11), C.soft, { lines: 3 });
  w.addSpacer();
  return w;
}

// ---------- Free to spend ----------
// What the bank balance forecast says about payday: overdrawn, or the closing balance.
function balanceLine(s) {
  const o = s.outlook;
  if (!o) return { text: s.latestBalance ? 'Bank balance is from last month' : 'No bank balance entered', color: C.soft };
  const fc = o.forecast;
  if (fc.overdrawnDate) return { text: `Overdrawn ${shortDate(fc.overdrawnDate)}`, color: C.danger };
  return { text: `${money(fc.end)} before payday`, color: C.soft };
}

function freeBlock(parent, s) {
  addLabel(parent, 'FREE PER DAY');
  parent.addSpacer(4);
  addText(parent, money(s.freePerDay), Font.boldSystemFont(26), s.free < 0 ? C.danger : C.ink, { scale: 0.5 });
  addText(parent, `${money(s.free)} until payday`, Font.regularMonospacedSystemFont(10), C.soft, { scale: 0.7 });
  parent.addSpacer();
  addText(parent, `Payday ${dayName(s.period.nextPayday)}`, Font.mediumSystemFont(12), C.ink, { scale: 0.7 });
  addText(parent, `${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} to go`, Font.regularSystemFont(10), C.soft);
  const b = balanceLine(s);
  parent.addSpacer(3);
  addText(parent, b.text, Font.regularSystemFont(10), b.color, { scale: 0.7 });
}

// The Overview's pay period card in short.
function periodLines(parent, s, compact) {
  const lines = [
    ['Coming in', `+${money(s.income)}`],
    ['Bills & pot', `−${money(s.billsTotal + s.potMonthly)}`],
    ['Savings', `−${money(s.savings)}`],
    ['Budgets', `−${money(s.budgetsCommitted)}`],
  ];
  lines.forEach(([name, amt], i) => {
    if (i > 0) parent.addSpacer(compact ? 3 : 5);
    const row = parent.addStack();
    addText(row, name, Font.regularSystemFont(11), C.soft);
    row.addSpacer();
    addText(row, amt, Font.regularMonospacedSystemFont(11), C.ink, { scale: 0.7 });
  });
  parent.addSpacer(compact ? 4 : 6);
  const total = parent.addStack();
  addText(total, 'Free to spend', Font.semiboldSystemFont(12), C.ink);
  total.addSpacer();
  addText(total, money(s.free), Font.semiboldMonospacedSystemFont(12), s.free < 0 ? C.danger : C.ink, { scale: 0.7 });
}

function freeLayout(w, family, ctx) {
  const s = ctx.L.periodSummary();
  if (!s.pay) return messageWidget(w, family, "Enter this month's pay", 'Add it on the Overview to see what you can spend.');

  if (family === 'accessoryInline') {
    w.addText(`${money(s.freePerDay)}/day · ${s.daysLeft}d to payday`);
  } else if (family === 'accessoryCircular') {
    circular(w, pounds(s.freePerDay), 'a day');
  } else if (family === 'accessoryRectangular') {
    addText(w, `${money(s.freePerDay)} a day`, Font.semiboldSystemFont(14), null, { scale: 0.7 });
    addText(w, `${money(s.free)} · ${s.daysLeft} days to payday`, Font.regularSystemFont(11), null, { scale: 0.7 });
    addText(w, balanceLine(s).text, Font.regularSystemFont(11), null, { scale: 0.7 });
  } else if (family === 'small') {
    freeBlock(w, s);
  } else {
    const cols = w.addStack();
    const left = cols.addStack();
    left.layoutVertically();
    left.size = new Size(130, family === 'medium' ? 0 : 150);
    freeBlock(left, s);
    cols.addSpacer(16);
    const right = cols.addStack();
    right.layoutVertically();
    addLabel(right, 'THIS PAY PERIOD');
    right.addSpacer(8);
    periodLines(right, s, family === 'medium');
    right.addSpacer();
    if (family !== 'medium') {
      w.addSpacer(16);
      comingList(w, ctx, 4);
      w.addSpacer();
      addFooter(w, ctx, true);
    }
  }
}

// ---------- Coming up ----------
function comingSummary(items) {
  const today = startOfToday();
  const overdue = items.filter(i => i.kind !== 'income' && i.date < today).length;
  const out = items.filter(i => i.kind !== 'income').reduce((t, i) => t + i.amount, 0);
  return overdue
    ? { text: `${overdue} overdue`, color: C.danger }
    : { text: `${money(out)} to go`, color: C.gold };
}

function comingRow(parent, i, compact) {
  const overdue = i.kind !== 'income' && i.date < startOfToday();
  addRow(parent, i.name, `${i.kind === 'income' ? '+' : ''}${money(i.amount)}`, whenLabel(i.date), {
    compact, subColor: overdue ? C.danger : C.soft, amountColor: i.kind === 'income' ? C.gold : C.ink
  });
}

function comingList(w, ctx, max) {
  const items = ctx.L.comingUp();
  const s = comingSummary(items);
  addHeader(w, 'Coming up', items.length ? s.text : 'all paid', s.color);
  w.addSpacer(8);
  if (!items.length) addText(w, 'Nothing left to pay before payday.', Font.regularSystemFont(11), C.soft);
  items.slice(0, max).forEach((i, n) => {
    if (n > 0) w.addSpacer(6);
    comingRow(w, i);
  });
}

function comingLayout(w, family, ctx) {
  const items = ctx.L.comingUp();
  const next = items.find(i => i.kind !== 'income');
  if (!next) {
    if (family.startsWith('accessory')) w.addText('All paid this period');
    else messageWidget(w, family, 'All paid', 'Nothing left to go out before payday.');
    return;
  }
  if (family === 'accessoryInline') {
    w.addText(`${next.name} ${money(next.amount)} · ${whenLabel(next.date)}`);
  } else if (family === 'accessoryCircular') {
    const soon = items.filter(i => i.kind !== 'income' && i.date <= addDays(startOfToday(), 7)).length;
    circular(w, String(soon), 'this week');
  } else if (family === 'accessoryRectangular') {
    addText(w, 'Next out', Font.regularSystemFont(11));
    addText(w, `${next.name} · ${money(next.amount)}`, Font.semiboldSystemFont(13), null, { scale: 0.7 });
    addText(w, whenLabel(next.date), Font.regularSystemFont(11));
  } else if (family === 'small') {
    addLabel(w, 'NEXT OUT');
    w.addSpacer(6);
    addText(w, next.name, Font.mediumSystemFont(14), C.ink, { lines: 2, scale: 0.8 });
    addText(w, money(next.amount), Font.boldSystemFont(24), C.ink, { scale: 0.6 });
    addText(w, whenLabel(next.date), Font.regularSystemFont(11), next.date < startOfToday() ? C.danger : C.soft);
    w.addSpacer();
    const s = comingSummary(items);
    addText(w, s.text, Font.mediumMonospacedSystemFont(10), s.color, { scale: 0.7 });
  } else {
    const large = family !== 'medium';
    comingList(w, ctx, large ? 8 : 3);
    w.addSpacer();
    addFooter(w, ctx, large);
  }
}

// ---------- Savings ----------
// Goals not finished yet first, in the app's order.
function sortedGoals(L) {
  const live = L.liveGoals();
  return [...live.filter(g => !isDone(g)), ...live.filter(isDone)];
}

// The ISA allowance is per person, so an ISA shows the total used across all of them (LedgerCore's isaAllowance).
function accountNote(a, info, L) {
  const today = startOfToday();
  if (a.maturesOn) {
    const days = Math.round((core.parseLocalDate(a.maturesOn) - today) / 86400000);
    if (days < 0) return { text: 'Matured — move the money', color: C.danger };
    if (days <= 30) return { text: `Matures in ${days} day${days === 1 ? '' : 's'}`, color: C.danger };
  }
  if (info.unassigned > 0.005) return { text: `${money(info.unassigned)} unassigned`, color: C.soft };
  if (a.kind === 'isa') return { text: `${money(L.isaAllowance().used)} of ${pounds(ISA_ALLOWANCE)} ISA allowance`, color: C.soft };
  return null;
}

function goalLine(L, g) {
  const p = L.goalPlan(g);
  if (p.overdue) return `Target date passed · ${money(p.remaining)} to go`;
  if (p.skip && (g.resetFrequency || !isDone(g))) return 'Skipped this month';
  if (p.planned > 0 && p.savedThisPeriod >= p.planned) return `✓ ${money(p.savedThisPeriod)} saved this month`;
  if (p.projection) {
    // Same "chronic" callout as the website: behind for 3 pay periods running (this one included), not just today.
    const streak = p.projection.tone === 'behind' ? L.goalBehindStreak(g) : 0;
    return streak >= 3 ? `${p.projection.text} · ${streak} periods running` : p.projection.text;
  }
  if (p.planned > 0) return `Save ${money(p.planned)}/mo`;
  return null;
}

function savingsLayout(w, family, ctx) {
  const L = ctx.L;
  const accounts = L.liveAccounts().map(a => ({ a, info: L.accountInfo(a) }));
  const goals = sortedGoals(L);
  // What goals hold now (pay outs and straight-out goals' money have left), and how far the ones with targets are.
  const inGoals = goals.reduce((t, g) => t + L.heldTotal(g), 0);
  const total = accounts.length ? accounts.reduce((t, x) => t + x.info.balance, 0) : inGoals;
  const targets = goals.reduce((t, g) => t + g.target, 0);
  const top = goals.find(g => g.target > 0 && !isDone(g)) || goals.find(g => g.target > 0) || goals[0];
  const ofTarget = g => g.target > 0 ? `${money(g.saved)} of ${money(g.target)}` : `${money(g.saved)} so far`;

  if (!accounts.length && !goals.length) return messageWidget(w, family, 'No savings yet', 'Add a savings account or a goal in the app.');

  if (family === 'accessoryInline') {
    w.addText(`${money(total)} saved${top ? ` · ${top.name} ${pctOf(top).toFixed(0)}%` : ''}`);
  } else if (family === 'accessoryCircular') {
    circular(w, top ? `${pctOf(top).toFixed(0)}%` : pounds(total), top ? top.name : 'saved');
  } else if (family === 'accessoryRectangular') {
    addText(w, `${money(total)} saved`, Font.semiboldSystemFont(13), null, { scale: 0.7 });
    if (top) {
      addText(w, `${top.name} · ${ofTarget(top)}`, Font.regularSystemFont(11), null, { scale: 0.7 });
      w.addSpacer(4);
      addBar(w, 140, pctOf(top), Color.white(), new Color('#ffffff', 0.3));
    }
  } else if (family === 'small') {
    addLabel(w, 'SAVINGS');
    w.addSpacer(4);
    addText(w, money(total), Font.boldSystemFont(24), C.ink, { scale: 0.5 });
    addText(w, accounts.length ? `${money(inGoals)} in goals` : `of ${money(targets)}`, Font.regularMonospacedSystemFont(10), C.soft, { scale: 0.7 });
    w.addSpacer();
    if (top) {
      addText(w, top.name, Font.mediumSystemFont(13), C.ink);
      w.addSpacer(5);
      addBar(w, 120, pctOf(top), isDone(top) ? C.done : C.gold);
      w.addSpacer(4);
      addText(w, `${pctOf(top).toFixed(0)}% · ${money(top.saved)}`, Font.regularMonospacedSystemFont(10), C.soft, { scale: 0.7 });
    }
    w.addSpacer();
    if (ctx.saveScript) addText(w, 'Tap to add savings', Font.regularSystemFont(9), C.soft);
  } else {
    const large = family !== 'medium';
    addHeader(w, 'Savings', money(total));
    w.addSpacer(large ? 10 : 8);
    const accountMax = large ? 3 : (goals.length ? 2 : 3);
    accounts.slice(0, accountMax).forEach((x, i) => {
      if (i > 0) w.addSpacer(6);
      const note = accountNote(x.a, x.info, L);
      addRow(w, x.a.name, money(x.info.balance), note && note.text, { compact: !large, subColor: note && note.color });
    });
    const goalMax = large ? 4 : Math.max(0, 3 - Math.min(accounts.length, accountMax));
    if (goalMax && goals.length) {
      w.addSpacer(accounts.length ? (large ? 14 : 8) : 0);
      goals.slice(0, goalMax).forEach((g, i) => {
        if (i > 0) w.addSpacer(large ? 10 : 6);
        addBarRow(w, `${isDone(g) ? '✓ ' : ''}${g.name}`,
          g.target > 0 ? (large ? `${money(g.saved)} / ${money(g.target)}` : `${pctOf(g).toFixed(0)}%`) : money(g.saved),
          pctOf(g), 285, { compact: !large, color: isDone(g) ? C.done : C.gold, sub: large ? goalLine(L, g) : null });
      });
    }
    w.addSpacer();
    addFooter(w, ctx, large);
  }
}

// ---------- Budgets ----------
function budgetsLayout(w, family, ctx) {
  const L = ctx.L;
  const s = L.periodSummary();
  const list = L.liveBudgets().map(b => ({ b, use: L.budgetUse(b) }));
  if (!list.length) return messageWidget(w, family, 'No budgets yet', 'Add one on the Budgets tab.');

  const total = list.reduce((t, x) => t + x.b.amount, 0);
  const spent = list.reduce((t, x) => t + x.use.spent, 0);
  const left = total - spent;
  // Even pace: the share of the pay period gone so far, as in the app's Budget pace card.
  const periodDays = Math.round((s.period.nextPayday - s.period.start) / 86400000);
  const dayNum = Math.round((s.today - s.period.start) / 86400000) + 1;
  const ahead = spent - total * (dayNum / periodDays);
  const pace = spent > total
    ? { text: `${money(spent - total)} over`, color: C.danger }
    : ahead > Math.max(1, total * 0.05)
      ? { text: `${money(ahead)} ahead of pace`, color: C.danger }
      : { text: 'On pace', color: C.soft };
  const budgetRow = (parent, x, width, compact) => addBarRow(parent, x.b.name,
    x.use.over ? `${money(-x.use.left)} over` : `${money(x.use.left)} left`, (x.use.spent / x.b.amount) * 100, width,
    { compact, color: x.use.over ? C.danger : C.gold, rightColor: x.use.over ? C.danger : C.soft });

  if (family === 'accessoryInline') {
    w.addText(list.length === 1 ? `${list[0].b.name} ${money(list[0].use.left)} left` : `${money(left)} left in budgets`);
  } else if (family === 'accessoryCircular') {
    circular(w, pounds(left), 'left');
  } else if (family === 'accessoryRectangular') {
    list.slice(0, 3).forEach(x => addText(w, `${x.b.name} ${money(x.use.left)}`, Font.regularSystemFont(12), null, { scale: 0.7 }));
  } else if (family === 'small') {
    addLabel(w, 'BUDGETS');
    w.addSpacer(4);
    addText(w, money(left), Font.boldSystemFont(24), left < 0 ? C.danger : C.ink, { scale: 0.5 });
    addText(w, `left of ${money(total)}`, Font.regularMonospacedSystemFont(10), C.soft, { scale: 0.7 });
    w.addSpacer(6);
    addBar(w, 120, total > 0 ? (spent / total) * 100 : 0, spent > total ? C.danger : C.gold);
    w.addSpacer(4);
    addText(w, pace.text, Font.regularSystemFont(10), pace.color);
    w.addSpacer();
    if (ctx.spendScript) addText(w, 'Tap to log a spend', Font.regularSystemFont(9), C.soft);
  } else {
    const large = family !== 'medium';
    addHeader(w, 'Budgets', `${money(left)} left`, left < 0 ? C.danger : C.gold);
    w.addSpacer(4);
    addText(w, `${pace.text} · day ${dayNum} of ${periodDays}`, Font.regularSystemFont(10), pace.color);
    w.addSpacer(large ? 12 : 8);
    list.slice(0, large ? 7 : 3).forEach((x, i) => {
      if (i > 0) w.addSpacer(large ? 10 : 6);
      budgetRow(w, x, 285, !large);
    });
    w.addSpacer();
    if (large || ctx.stale) addFooter(w, ctx, large);
  }
}

// ---------- Widget ----------
// Whether a script of that name is in Scriptable (so tapping the budgets widget can run it).
function scriptExists(name) {
  for (const open of [() => FileManager.iCloud(), () => FileManager.local()]) {
    try {
      const f = open();
      if (f.fileExists(f.joinPath(f.documentsDirectory(), `${name}.js`))) return true;
    } catch (e) { /* iCloud turned off for Scriptable */ }
  }
  return false;
}

function buildWidget(family, mode, loaded) {
  const w = new ListWidget();
  const accessory = family.startsWith('accessory');
  if (!accessory) {
    w.backgroundColor = C.bg;
    if (family === 'small') w.setPadding(14, 14, 14, 14);
  }
  const spendScript = mode === 'budgets' && scriptExists(SPEND_SCRIPT);
  const saveScript = mode === 'savings' && scriptExists(SAVE_SCRIPT);
  w.url = spendScript
    ? `scriptable:///run/${encodeURIComponent(SPEND_SCRIPT)}`
    : saveScript
    ? `scriptable:///run/${encodeURIComponent(SAVE_SCRIPT)}`
    : api.APP_URL + { free: '#overview', coming: '#overview', savings: '#goals', budgets: '#budgets' }[mode];
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

  if (loaded.signedOut) return messageWidget(w, family, 'Sign in needed', `Open Scriptable and run "${Script.name()}" to sign in.`);
  if (loaded.error) return messageWidget(w, family, loaded.error, 'Will try again shortly.');

  const ctx = { ...loaded, spendScript, saveScript };
  ({ free: freeLayout, coming: comingLayout, savings: savingsLayout, budgets: budgetsLayout })[mode](w, family, ctx);
  return w;
}

// ---------- Running in the app ----------
async function pick(title, message, options) {
  const a = new Alert();
  a.title = title;
  if (message) a.message = message;
  options.forEach(o => a.addAction(o));
  a.addCancelAction('Cancel');
  return a.presentAlert();
}

async function runInApp() {
  if (!api.isSignedIn() && !(await api.signIn())) return;
  const choice = await pick(
    'Ledger widget',
    "You're signed in. Add a Scriptable widget, choose this script, and set its Parameter to free, coming, savings or budgets.",
    ['Preview free', 'Preview coming', 'Preview savings', 'Preview budgets', 'Sign out']
  );
  if (choice === 4) {
    api.signOut();
    return;
  }
  const mode = MODES[choice];
  if (!mode) return;
  const family = ['small', 'medium', 'large'][await pick('Size', null, ['Small', 'Medium', 'Large'])];
  if (!family) return;
  const w = buildWidget(family, mode, await api.loadLedger());
  if (family === 'small') await w.presentSmall();
  else if (family === 'medium') await w.presentMedium();
  else await w.presentLarge();
}

if (config.runsInWidget) {
  const param = String(args.widgetParameter || '').trim().toLowerCase();
  const mode = MODES.includes(param) ? param : 'free';
  Script.setWidget(buildWidget(config.widgetFamily || 'small', mode, await api.loadLedger()));
} else {
  await runInApp();
}
Script.complete();
