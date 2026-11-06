// Core rules for Ledger: dates, bill schedules, pay periods, money formatting, goal plans, savings accounts, and
// the Overview's sums (ledger()). Shared by the web app and the Scriptable widgets, so both work things out the same way.
// index.html loads this with a <script> tag, as window.LedgerCore; Scriptable loads it with importModule('ledger-core').
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FREQUENCY_LABELS = {
    weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly',
    quarterly: 'Quarterly', yearly: 'Yearly', once: 'One-off'
  };
  const PER_MONTH = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, once: 0 };
  const AVG_MONTH_MS = 1000 * 60 * 60 * 24 * 30.44;

  // ---------- Dates ----------
  function parseLocalDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function startOfToday() {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  function lastDayOfMonth(y, m) {
    return new Date(y, m + 1, 0);
  }

  function monthShort(d) {
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }

  // ---------- Bill schedule ----------
  // nth occurrence from start. Month-based bills keep the start's day, clamped to the month's end (31st -> 30th/28th).
  function occurrence(start, freq, n) {
    if (freq === 'weekly') return addDays(start, 7 * n);
    if (freq === 'fortnightly') return addDays(start, 14 * n);
    const step = { monthly: 1, quarterly: 3, yearly: 12 }[freq];
    const y = start.getFullYear(), m = start.getMonth() + step * n;
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(start.getDate(), lastDay));
  }

  // Occurrences on or after `from`, in order, stopping after the end date (if any).
  function* occurrencesFrom(bill, from) {
    const start = parseLocalDate(bill.startDate);
    if (bill.frequency === 'once') {
      if (start >= from) yield start;
      return;
    }
    const end = bill.endDate ? parseLocalDate(bill.endDate) : null;
    for (let n = 0, d = start; !end || d <= end; d = occurrence(start, bill.frequency, ++n)) {
      if (d >= from) yield d;
    }
  }

  // Occurrences within [from, to], in order.
  function occurrencesBetween(bill, from, to) {
    const out = [];
    for (const d of occurrencesFrom(bill, from)) {
      if (d > to) break;
      out.push(d);
    }
    return out;
  }

  function nextDue(bill) {
    return occurrencesFrom(bill, startOfToday()).next().value || null;
  }

  // Recurring bills are tracked from the day they were added; occurrences before that count as settled.
  function trackFrom(bill) {
    if (bill.frequency === 'once') return parseLocalDate(bill.startDate);
    const c = new Date(bill.createdAt);
    return new Date(c.getFullYear(), c.getMonth(), c.getDate());
  }

  // Average per month across entries that haven't ended.
  function monthlyAverage(list, today) {
    return list
      .filter(b => !b.endDate || parseLocalDate(b.endDate) >= today)
      .reduce((s, b) => s + b.amount * PER_MONTH[b.frequency], 0);
  }

  // ---------- Yearly bills pot ----------
  // Yearly and quarterly bills land in one go, so their money is put aside a month at a time instead.
  // For each one still running (`list` should already leave out archived bills and income):
  //   monthly    — its share per month (a twelfth, or a third for quarterly)
  //   shouldHave — what should be put by today: its share of the time since the last due date (or, before the
  //                first one, since one cycle before it), so it reaches the full amount on the due date
  const POT_FREQUENCIES = ['quarterly', 'yearly'];

  function isPotBill(bill) {
    return POT_FREQUENCIES.includes(bill.frequency);
  }

  function yearlyBillsPot(list, today) {
    const items = [];
    list.filter(b => isPotBill(b)).forEach(bill => {
      const start = parseLocalDate(bill.startDate);
      const end = bill.endDate ? parseLocalDate(bill.endDate) : null;
      let n = 0;
      while (occurrence(start, bill.frequency, n) < today) n++;
      const next = occurrence(start, bill.frequency, n);
      if (end && next > end) return;
      const prev = occurrence(start, bill.frequency, n - 1);
      const share = Math.min(1, Math.max(0, (today - prev) / (next - prev)));
      items.push({ bill, next, monthly: bill.amount * PER_MONTH[bill.frequency], shouldHave: bill.amount * share });
    });
    items.sort((x, y) => x.next - y.next);
    return {
      items,
      monthly: items.reduce((s, i) => s + i.monthly, 0),
      shouldHave: items.reduce((s, i) => s + i.shouldHave, 0)
    };
  }

  // ---------- Pay period ----------
  // Pay lands on the last day of each month, so a period runs from one payday to the day before the next.
  // `back` steps that many periods into the past (1 = the previous period).
  function payPeriodFor(date, back = 0) {
    let start = lastDayOfMonth(date.getFullYear(), date.getMonth());
    if (start > date) start = lastDayOfMonth(date.getFullYear(), date.getMonth() - 1);
    if (back) start = lastDayOfMonth(start.getFullYear(), start.getMonth() - back);
    const nextPayday = lastDayOfMonth(start.getFullYear(), start.getMonth() + 1);
    return { start, end: addDays(nextPayday, -1), nextPayday };
  }

  function currentPayPeriod() {
    return payPeriodFor(startOfToday());
  }

  // ---------- Balance forecast ----------
  // Where the current account is heading, day by day from today to `until`.
  //   balance — the last balance entered
  //   events  — [{ date, amount }] since that balance, signed (money in is positive). Ones dated before today
  //             have already happened, so they move today's starting point rather than a later day.
  //   spread  — a signed amount spread evenly over the days left, for spending with no set date (budgets)
  // Returns today's estimate (`now`), the closing balance on `until` (`end`), the lowest closing balance
  // on the way (`low`, on `lowDate`), and the first day it closes below £0 (`overdrawnDate`, or null).
  function balanceForecast(balance, events, spread, until) {
    const today = startOfToday();
    const days = Math.max(1, Math.round((until - today) / 86400000) + 1);
    const byDay = new Array(days).fill(0);
    let now = balance;
    events.forEach(e => {
      const i = Math.round((e.date - today) / 86400000);
      if (i < 0) now += e.amount;
      else if (i < days) byDay[i] += e.amount;
    });
    let running = now, low = Infinity, lowDate = today, overdrawnDate = null;
    byDay.forEach((amt, i) => {
      running += amt + spread / days;
      if (running < low - 0.005) { low = running; lowDate = addDays(today, i); }
      if (running < -0.005 && !overdrawnDate) overdrawnDate = addDays(today, i);
    });
    return { now, end: running, low, lowDate, overdrawnDate };
  }

  // ---------- Money ----------
  function formatMoney(n) {
    const sign = n < 0 ? '-' : '';
    const abs = Math.round(Math.abs(Number(n)) * 100) / 100;
    const pence = Number.isInteger(abs) ? 0 : 2; // £950, but £174.50 rather than £174.5
    return sign + '£' + abs.toLocaleString('en-GB', { minimumFractionDigits: pence, maximumFractionDigits: 2 });
  }

  // ---------- Goals ----------
  // `saved` is what a goal has saved (pay outs don't lower it). A goal with no target (target 0) is open-ended.
  function hasTarget(g) {
    return g.target > 0;
  }

  function pctOf(g) {
    return hasTarget(g) ? Math.min(100, (g.saved / g.target) * 100) : 0;
  }

  function isDone(g) {
    return hasTarget(g) && g.saved >= g.target;
  }

  // The dates in [from, to] for a goal with a day of the month set, or [] without one.
  function goalDaysBetween(goal, from, to) {
    if (!goal.monthlyDay) return [];
    const schedule = { startDate: `2000-01-${String(goal.monthlyDay).padStart(2, '0')}`, frequency: 'monthly' };
    return occurrencesBetween(schedule, from, to);
  }

  // What a goal asks for this pay period. It's worked out from where the goal stood when the period began,
  // so money added during the period counts towards it rather than shrinking it. `deposits` may hold other
  // goals' and older periods' deposits; only this goal's from this period count. £0 deposits mark a skip.
  // Deposits marked `external` came from somewhere other than income (e.g. a cashback app). They count towards
  // the goal's total but not towards this period's plan, so the plan from income stays the same and the extra
  // just brings the goal closer (next period's plan shrinks to match).
  //   planned   — this period's amount (from the target date, or the goal's monthly amount)
  //   savedThisPeriod — saved from income this period; fromOutside — added from outside this period
  //   committed — what the Overview sets aside: the plan, or more if more was saved; only what was saved if skipped
  //   afterSkip — the monthly amount needed from next period if this one is skipped
  //   projection — a short forecast line (finish month, or ahead/behind a steady pace), or null;
  //                `behindBy` holds the amount when it's behind
  // Pay outs (`paidOut`) don't count here: spending a goal's money doesn't undo the saving.
  // A goal with no target asks for its monthly amount every period, and has no `remaining` (null).
  // `fromIncome(d)`, if given, says whether an entry's money left the current account; entries it rejects are
  // treated like `external` ones (e.g. assigning money that was already in a savings account).
  function goalPlan(goal, deposits, fromIncome) {
    const period = currentPayPeriod();
    const mine = (deposits || []).filter(d => d.goalId === goal.id && !d.paidOut && new Date(d.createdAt) >= period.start);
    const outside = d => d.external || (fromIncome && d.amount !== 0 && !fromIncome(d));
    const skip = mine.find(d => d.amount === 0 && !d.external) || null;
    const savedThisPeriod = mine.filter(d => !outside(d)).reduce((s, d) => s + d.amount, 0);
    const fromOutside = mine.filter(outside).reduce((s, d) => s + d.amount, 0);

    if (!hasTarget(goal)) {
      const planned = goal.monthlyAmount || 0;
      const committed = skip ? Math.max(0, savedThisPeriod) : Math.max(planned, savedThisPeriod);
      return {
        planned, savedThisPeriod, fromOutside, skip, remaining: null, overdue: false, dueLabel: null,
        afterSkip: planned, committed, projection: null
      };
    }

    const remaining = goal.target - goal.saved;
    const remainingAtStart = remaining + savedThisPeriod + fromOutside;
    const plan = { planned: 0, savedThisPeriod, fromOutside, skip, remaining, overdue: false, dueLabel: null, afterSkip: 0 };

    if (goal.targetDate) {
      const due = parseLocalDate(goal.targetDate);
      plan.dueLabel = monthShort(due);
      if (due <= startOfToday()) {
        plan.overdue = remaining > 0;
      } else if (remainingAtStart > 0) {
        const monthsLeft = Math.max(1, Math.ceil((due - period.start) / AVG_MONTH_MS));
        plan.planned = remainingAtStart / monthsLeft;
        plan.afterSkip = Math.max(0, remaining) / Math.max(1, monthsLeft - 1);
      }
    } else if (goal.monthlyAmount) {
      plan.planned = Math.min(goal.monthlyAmount, Math.max(0, remainingAtStart));
      plan.afterSkip = goal.monthlyAmount;
    }

    plan.committed = skip ? Math.max(0, savedThisPeriod) : Math.max(plan.planned, savedThisPeriod);
    plan.projection = isDone(goal) || plan.overdue ? null : projectGoal(goal, plan, period);
    return plan;
  }

  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }

  function projectGoal(goal, plan, period) {
    const today = startOfToday();

    // With a deadline: compare where the goal stood when this pay period began against a steady line from
    // the day it was made to the target date. Using the start of the period means this month's saving (or
    // not having done it yet) doesn't move it; only earlier months falling short or getting ahead do.
    // Gaps under half a month's share count as on schedule.
    if (goal.targetDate) {
      const created = goal.createdAt ? new Date(goal.createdAt) : null;
      const due = parseLocalDate(goal.targetDate);
      if (!created || due <= created) return null;
      const expected = goal.target * Math.min(1, Math.max(0, (period.start - created) / (due - created)));
      const savedAtStart = goal.saved - plan.savedThisPeriod - plan.fromOutside;
      const diff = savedAtStart - expected;
      const monthlyShare = goal.target / Math.max(1, (due - created) / AVG_MONTH_MS);
      if (Math.abs(diff) < Math.max(1, monthlyShare / 2)) return { text: 'On schedule', tone: 'good' };
      return diff > 0
        ? { text: `${formatMoney(diff)} ahead of schedule`, tone: 'good' }
        : { text: `${formatMoney(-diff)} behind schedule`, tone: 'behind', behindBy: -diff };
    }

    // With a monthly amount: count the periods still needed, this one included if its amount isn't in yet.
    if (goal.monthlyAmount) {
      const thisPeriodLeft = plan.skip ? 0 : Math.max(0, plan.planned - Math.max(0, plan.savedThisPeriod));
      const after = plan.remaining - thisPeriodLeft;
      const months = after <= 0 ? 0 : Math.ceil(after / goal.monthlyAmount);
      return { text: `Done around ${monthShort(addMonths(period.end, months))} at ${formatMoney(goal.monthlyAmount)}/mo`, tone: 'neutral' };
    }

    // Neither: extrapolate from the average since the goal was made, once there's a month of history.
    if (goal.createdAt && goal.saved > 0) {
      const months = (today - new Date(goal.createdAt)) / AVG_MONTH_MS;
      if (months < 1) return null;
      const rate = goal.saved / months;
      return { text: `Done around ${monthShort(addMonths(today, Math.ceil(plan.remaining / rate)))} at your average ${formatMoney(rate)}/mo`, tone: 'neutral' };
    }
    return null;
  }

  // ---------- Savings accounts ----------
  // Money is moved from the current account into a savings account (a transfer), and goals then claim some
  // of what's in there. Balances are entered by hand now and then; whatever they moved by beyond the transfers
  // in between is interest.
  const ISA_ALLOWANCE = 20000;
  const PERSONAL_SAVINGS_ALLOWANCE = 1000; // basic-rate taxpayers; £500 for higher rate

  // The UK tax year starts on 6 April.
  function taxYearStart(date) {
    const afterStart = date.getMonth() > 3 || (date.getMonth() === 3 && date.getDate() >= 6);
    return new Date(afterStart ? date.getFullYear() : date.getFullYear() - 1, 3, 6);
  }

  // An account's monthly standing order in, shaped like a bill so the bill schedule rules apply.
  // It stops when the account matures.
  function standingOrder(account) {
    if (!account.standingAmount || !account.standingStart) return null;
    return {
      id: account.id, name: account.name, amount: account.standingAmount, frequency: 'monthly',
      startDate: account.standingStart, endDate: account.maturesOn || null, createdAt: account.createdAt
    };
  }

  // When a transfer happened, for comparing with balance entries. One logged on the day it's dated keeps the
  // time it was logged; a backdated one counts from the start of its date.
  function transferTime(t) {
    const logged = new Date(t.createdAt);
    return toISODate(logged) === t.movedOn ? logged : parseLocalDate(t.movedOn);
  }

  // Everything about one account, from its balance entries and transfers (either list may hold other accounts').
  //   balance    — the latest entry plus transfers since; just the transfers if there's no entry
  //   interest   — [{ date, amount }] per entry after the first
  //   interestThisYear, paidInThisYear, takenOutThisYear — this tax year
  //   isaUsed    — ISA allowance used this tax year, including any paid in before the account was added here
  //                (a flexible ISA gets withdrawals back); isaResetsOn — the next 6 April
  //   paidInThisMonth — this calendar month, for a regular saver's monthly limit
  //   balanceAt(date) — the balance at any time, worked back from the first entry before it
  function accountState(account, entries, transfers, today) {
    const mine = entries.filter(e => e.accountId === account.id)
      .map(e => ({ ...e, time: new Date(e.createdAt) })).sort((a, b) => a.time - b.time);
    const moves = transfers.filter(t => t.accountId === account.id)
      .map(t => ({ ...t, time: transferTime(t) })).sort((a, b) => a.time - b.time);
    const movedBetween = (from, to) => moves
      .filter(t => (!from || t.time > from) && (!to || t.time <= to)).reduce((s, t) => s + t.amount, 0);

    function balanceAt(date) {
      const before = mine.filter(e => e.time <= date).pop();
      if (before) return before.amount + movedBetween(before.time, date);
      if (mine.length) return mine[0].amount - movedBetween(date, mine[0].time);
      return movedBetween(null, date);
    }

    const interest = [];
    for (let i = 1; i < mine.length; i++) {
      const amount = mine[i].amount - mine[i - 1].amount - movedBetween(mine[i - 1].time, mine[i].time);
      if (Math.abs(amount) >= 0.005) interest.push({ date: mine[i].time, amount });
    }

    const yearStart = taxYearStart(today);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const thisYear = moves.filter(t => parseLocalDate(t.movedOn) >= yearStart);
    const paidInThisYear = thisYear.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const takenOutThisYear = -thisYear.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
    const latest = mine[mine.length - 1] || null;
    // What was paid into an ISA this tax year before it was added here, as entered on the account. It only
    // counts in the tax year it was entered for, so it drops off on 6 April like everything else.
    const paidBefore = account.isaPaidBefore && account.isaPaidBeforeYear === toISODate(yearStart) ? account.isaPaidBefore : 0;
    const isaPaidIn = paidInThisYear + paidBefore;

    return {
      balance: latest ? latest.amount + movedBetween(latest.time, null) : movedBetween(null, null),
      latestEntry: latest,
      interest,
      interestThisYear: interest.filter(i => i.date >= yearStart).reduce((s, i) => s + i.amount, 0),
      paidInThisYear,
      takenOutThisYear,
      isaUsed: account.flexible ? Math.max(0, isaPaidIn - takenOutThisYear) : isaPaidIn,
      isaResetsOn: new Date(yearStart.getFullYear() + 1, 3, 6),
      paidInThisMonth: moves.filter(t => t.amount > 0 && parseLocalDate(t.movedOn) >= monthStart)
        .reduce((s, t) => s + t.amount, 0),
      balanceAt
    };
  }

  // ---------- Database rows ----------
  // Supabase rows (snake_case) to the shapes the rules work with.
  const num = v => v == null ? null : Number(v);
  const fromRow = {
    goal: r => ({
      id: r.id, name: r.name, target: r.target == null ? 0 : Number(r.target), saved: Number(r.saved), category: r.category || '',
      targetDate: r.target_date || null, monthlyAmount: num(r.monthly_amount),
      sortOrder: r.sort_order == null ? 0 : Number(r.sort_order), archived: !!r.archived,
      accountId: r.account_id || null, straightOut: !!r.straight_out, monthlyDay: num(r.monthly_day), createdAt: r.created_at
    }),
    deposit: r => ({
      id: r.id, goalId: r.goal_id, amount: Number(r.amount), note: r.note || '', external: !!r.external,
      accountId: r.account_id || null, paidOut: !!r.paid_out, transferId: r.transfer_id || null, createdAt: r.created_at
    }),
    bill: r => ({
      id: r.id, name: r.name, amount: Number(r.amount), frequency: r.frequency, startDate: r.start_date,
      endDate: r.end_date || null, kind: r.kind || 'bill', category: r.category || '', archived: !!r.archived,
      createdAt: r.created_at
    }),
    payment: r => ({ id: r.id, billId: r.bill_id, dueDate: r.due_date, amount: Number(r.amount), paidAt: r.paid_at }),
    budget: r => ({
      id: r.id, name: r.name, amount: Number(r.amount), sortOrder: r.sort_order == null ? 0 : Number(r.sort_order),
      archived: !!r.archived, createdAt: r.created_at
    }),
    spend: r => ({ id: r.id, budgetId: r.budget_id, amount: Number(r.amount), note: r.note || '', spentOn: r.spent_on, createdAt: r.created_at }),
    balance: r => ({ id: r.id, amount: Number(r.amount), createdAt: r.created_at }),
    account: r => ({
      id: r.id, name: r.name, kind: r.kind || 'saver', standingAmount: num(r.standing_amount),
      standingStart: r.standing_start || null, monthlyLimit: num(r.monthly_limit), maturesOn: r.matures_on || null,
      flexible: !!r.flexible, isaPaidBefore: num(r.isa_paid_before), isaPaidBeforeYear: r.isa_paid_before_year || null,
      sortOrder: r.sort_order == null ? 0 : Number(r.sort_order), archived: !!r.archived,
      createdAt: r.created_at
    }),
    accountEntry: r => ({ id: r.id, accountId: r.account_id, amount: Number(r.amount), createdAt: r.created_at }),
    transfer: r => ({
      id: r.id, accountId: r.account_id, amount: Number(r.amount), movedOn: r.moved_on, note: r.note || '',
      depositId: r.deposit_id || null, dueDate: r.due_date || null, external: !!r.external, createdAt: r.created_at
    })
  };

  // ---------- The whole ledger ----------
  // Rules that need several tables at once, shared by the app and the widget. `data` holds mapped rows (see
  // fromRow): goals, deposits, bills, payments, budgets, spends (this pay period's), balances, accounts,
  // accountEntries, transfers. Its properties may be getters, so the app can hand over arrays it later replaces.
  // Call reindex() after payments change.
  const PAY_TAG = 'pay'; // each month's pay is a one-off income row dated on payday, in this category

  function isPay(b) {
    return b.kind === 'income' && b.category === PAY_TAG;
  }

  function ledger(data) {
    let paidIndex = new Map();
    const L = {};

    L.reindex = () => { paidIndex = new Map(data.payments.map(p => [p.billId + '|' + p.dueDate, p])); };
    L.paymentFor = (bill, d) => paidIndex.get(bill.id + '|' + toISODate(d));
    // The occurrence to pay next: the earliest unpaid one (possibly overdue), or null when everything is paid.
    L.firstUnpaid = bill => {
      for (const d of occurrencesFrom(bill, trackFrom(bill))) if (!L.paymentFor(bill, d)) return d;
      return null;
    };
    L.unpaidBetween = (bill, from, to) => occurrencesBetween(bill, from, to).filter(d => !L.paymentFor(bill, d));
    L.payOn = iso => data.bills.find(b => isPay(b) && b.startDate === iso) || null;

    L.liveGoals = () => data.goals.filter(g => !g.archived);
    L.liveBudgets = () => data.budgets.filter(b => !b.archived);
    L.liveAccounts = () => data.accounts.filter(a => !a.archived);

    // Whether a goal entry's money came out of the current account (so out of this period's income):
    //   kept in the current account, or paid straight out of it — no savings account and no transfer; or
    //   moved into savings by a transfer from the current account.
    // Not: money from outside your income, pay outs, money that was already in a savings account and was only
    // assigned, or a goal's money moved between accounts.
    L.fromIncome = d => {
      if (d.external || d.paidOut) return false;
      const t = d.transferId ? data.transfers.find(x => x.id === d.transferId)
        : data.transfers.find(x => x.depositId === d.id);
      if (t) return !t.external && t.amount > 0;
      return !d.accountId;
    };
    L.goalPlan = goal => goalPlan(goal, data.deposits, L.fromIncome);

    // What a budget has used this pay period. `committed` is what the Overview sets aside: the allowance, or more if overspent.
    L.budgetUse = budget => {
      const spent = data.spends.filter(s => s.budgetId === budget.id).reduce((t, s) => t + s.amount, 0);
      return { spent, left: budget.amount - spent, over: spent > budget.amount, committed: Math.max(budget.amount, spent) };
    };

    // A goal's usual account: where its money is kept, or for a straight-out goal where it's usually paid from.
    // Null for none (the current account). It's only the default: each entry records its own account.
    L.accountOf = goal => goal && goal.accountId ? L.liveAccounts().find(a => a.id === goal.accountId) || null : null;
    // The account whose money this period's plan moves: none for a straight-out goal, whose money leaves the
    // current account (or whichever account it's paid from) and is never kept.
    L.planAccount = goal => goal && !goal.straightOut ? L.accountOf(goal) : null;
    // Goals whose plan is paid straight from the current account: no savings account, or straight-out ones
    // paid from it. (A straight-out goal usually paid from savings doesn't touch this month's income.)
    L.fromCurrent = goal => !L.accountOf(goal);

    // What a goal holds now, per account: what it saved there, less what was paid out or moved away.
    // Keys are account ids, '' for the current account. A straight-out goal holds nothing.
    L.goalHeld = goal => {
      const held = new Map();
      if (goal.straightOut) return held;
      data.deposits.forEach(d => {
        if (d.goalId !== goal.id || d.amount === 0) return;
        const key = d.accountId || '';
        held.set(key, (held.get(key) || 0) + d.amount);
      });
      held.forEach((v, k) => { if (Math.abs(v) < 0.005) held.delete(k); });
      return held;
    };
    L.heldIn = (goal, accountId) => L.goalHeld(goal).get(accountId || '') || 0;
    L.heldTotal = goal => [...L.goalHeld(goal).values()].reduce((s, v) => s + v, 0);
    // What has been paid out of a goal (positive), and what has gone to it in all.
    L.paidOut = goal => -data.deposits.filter(d => d.goalId === goal.id && d.paidOut).reduce((s, d) => s + d.amount, 0);

    // An account's balance, interest and allowances (see accountState), plus the goals with money kept in it (or
    // that keep their money there by default), what each holds here, and what's in it that no goal has claimed.
    L.accountInfo = account => {
      const state = accountState(account, data.accountEntries, data.transfers, startOfToday());
      const heldBy = new Map();
      const goalsIn = L.liveGoals().filter(g => {
        if (g.straightOut) return false;
        const here = L.heldIn(g, account.id);
        if (Math.abs(here) < 0.005 && g.accountId !== account.id) return false;
        heldBy.set(g.id, here);
        return true;
      });
      const inGoals = [...heldBy.values()].reduce((s, v) => s + v, 0);
      return { ...state, goalsIn, heldBy, inGoals, unassigned: state.balance - inGoals };
    };

    // Goal money kept in the current account (goals with no savings account), for the Overview.
    L.heldInCurrent = () => L.liveGoals().reduce((s, g) => s + L.heldIn(g, null), 0);

    // Standing order dates in [from, to], from the day the account was added.
    L.standingBetween = (account, from, to) => {
      const so = standingOrder(account);
      if (!so) return [];
      const since = trackFrom(so);
      return occurrencesBetween(so, from, to).filter(d => d >= since);
    };
    L.standingDone = (account, d) => {
      const iso = toISODate(d);
      return data.transfers.find(t => t.accountId === account.id && t.dueDate === iso) || null;
    };

    // What an account takes out of the current account this pay period:
    //   moved          — transfers (net) dated in the period, leaving out money paid in from outside (`external`)
    //   unpaidStanding — standing order dates in the period not yet marked done
    //   goalsLeft      — what its goals still want this period (plans not met yet; skipped goals want nothing)
    //   extra          — the part of goalsLeft that this period's money in (moved so far, plus the standing order
    //                    still to go) doesn't cover. Money that was already in the account doesn't count until
    //                    it's assigned to a goal, which lowers goalsLeft instead.
    //   committed      — moved + standing order still to go + extra
    L.accountSaving = (account, period, info) => {
      info = info || L.accountInfo(account);
      const from = toISODate(period.start), to = toISODate(period.end);
      const moved = data.transfers.filter(t => t.accountId === account.id && !t.external && t.movedOn >= from && t.movedOn <= to)
        .reduce((s, t) => s + t.amount, 0);
      const unpaidStanding = L.standingBetween(account, period.start, period.end).filter(d => !L.standingDone(account, d));
      const standingLeft = unpaidStanding.length * (account.standingAmount || 0);
      const goalsLeft = L.liveGoals().filter(g => L.planAccount(g) === account).reduce((s, g) => {
        const p = L.goalPlan(g);
        return s + (p.skip ? 0 : Math.max(0, p.planned - Math.max(0, p.savedThisPeriod)));
      }, 0);
      const extra = Math.max(0, goalsLeft - Math.max(0, moved) - standingLeft);
      return { moved, unpaidStanding, standingLeft, goalsLeft, extra, committed: Math.max(0, moved + standingLeft + extra) };
    };

    // Carries a balance entered this pay period forward to the day before payday. What counts as already in it:
    //   bills     — due before the day it was entered and marked paid, or marked paid before it was entered;
    //               unpaid overdue ones come out today
    //   income    — dated on or before the day it was entered
    //   transfers — to or from savings accounts, made before it was entered
    //   deposits  — for goals without a savings account (their money is assumed to leave the current account),
    //               made before it was entered; ones from outside (`external`) never touch the current account
    //   spends    — logged before it was entered, or dated before that day
    // Standing orders still to go come out on their dates; what goals still need comes out today; what's left in
    // budgets is spread evenly to payday.
    L.balanceOutlook = (entry, period) => {
      const at = new Date(entry.createdAt);
      const atDay = new Date(at.getFullYear(), at.getMonth(), at.getDate());
      const today = startOfToday();
      const dayOf = iso => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
      const events = [];
      const add = (kind, date, amount) => events.push({ kind, date, amount });

      data.bills.filter(b => !b.archived).forEach(b => {
        occurrencesBetween(b, period.start, period.end).forEach(d => {
          if (b.kind === 'income') {
            if (d > atDay) add('income', d, b.amount);
            return;
          }
          const p = L.paymentFor(b, d);
          if (p && new Date(p.paidAt) > at && d >= atDay) add('bills', dayOf(p.paidAt), -p.amount);
          else if (!p && d >= trackFrom(b)) add('bills', d < today ? today : d, -b.amount);
        });
      });
      // Goal entries that leave the current account: ones kept in it or paid straight out of it. Entries tied to
      // a transfer are counted through the transfer; pay outs from money already set aside don't move it again.
      const paired = new Set(data.transfers.map(t => t.depositId).filter(Boolean));
      data.deposits.filter(d => new Date(d.createdAt) > at && !d.external && !d.paidOut && !d.accountId &&
        !d.transferId && !paired.has(d.id))
        .forEach(d => add('goals', dayOf(d.createdAt), -d.amount));
      data.transfers.filter(t => transferTime(t) > at && !t.external).forEach(t => add('goals', parseLocalDate(t.movedOn), -t.amount));
      L.liveGoals().filter(L.fromCurrent).forEach(g => {
        const plan = L.goalPlan(g);
        const toSave = plan.skip ? 0 : Math.max(0, plan.planned - Math.max(0, plan.savedThisPeriod));
        if (toSave <= 0) return;
        const day = goalDaysBetween(g, period.start, period.end)[0];
        add('goals', day && day > today ? day : today, -toSave);
      });
      L.liveAccounts().forEach(a => {
        const s = L.accountSaving(a, period);
        s.unpaidStanding.forEach(d => add('goals', d < today ? today : d, -a.standingAmount));
        if (s.extra > 0) add('goals', today, -s.extra);
      });
      data.spends.filter(s => new Date(s.createdAt) > at && parseLocalDate(s.spentOn) >= atDay)
        .forEach(s => add('budgets', parseLocalDate(s.spentOn), -s.amount));
      const budgetLeft = L.liveBudgets().reduce((s, b) => s + Math.max(0, L.budgetUse(b).left), 0);

      const total = (kind, ahead) => events
        .filter(e => (!kind || e.kind === kind) && (e.date >= today) === ahead)
        .reduce((s, e) => s + e.amount, 0);
      return {
        forecast: balanceForecast(entry.amount, events, -budgetLeft, period.end),
        since: total(null, false),
        bills: total('bills', true),
        income: total('income', true),
        goals: total('goals', true),
        budgets: total('budgets', true) - budgetLeft
      };
    };

    // The Overview's pay period sums:
    //   leftOver = pay + other income due this period − bills (yearly/quarterly ones left out) − the pot's monthly share
    //   free     = leftOver − savings (each account's committed, plus goals with no account) − budgets
    // Also the latest bank balance and its outlook, if it was entered this pay period.
    L.periodSummary = () => {
      const today = startOfToday();
      const period = currentPayPeriod();
      const billsOnly = data.bills.filter(b => b.kind === 'bill' && !b.archived);
      const otherIncome = data.bills.filter(b => b.kind === 'income' && !isPay(b) && !b.archived);
      const pay = L.payOn(toISODate(period.start));

      const otherItems = [];
      otherIncome.forEach(b => occurrencesBetween(b, period.start, period.end).forEach(d => otherItems.push({ b, d })));
      const otherTotal = otherItems.reduce((s, i) => s + i.b.amount, 0);

      let billsTotal = 0, potLumpTotal = 0, potLumpCount = 0;
      billsOnly.forEach(b => {
        occurrencesBetween(b, period.start, period.end).forEach(d => {
          const p = L.paymentFor(b, d);
          const amt = p ? p.amount : b.amount;
          if (isPotBill(b)) { potLumpTotal += amt; potLumpCount++; }
          else billsTotal += amt;
        });
      });
      const potMonthly = yearlyBillsPot(billsOnly, today).monthly;
      const income = (pay ? pay.amount : 0) + otherTotal;
      const leftOver = income - billsTotal - potMonthly;

      const looseGoals = { committed: 0, saved: 0, skipped: 0 };
      L.liveGoals().filter(L.fromCurrent).forEach(g => {
        const plan = L.goalPlan(g);
        looseGoals.committed += plan.committed;
        looseGoals.saved += Math.max(0, plan.savedThisPeriod);
        if (plan.skip) looseGoals.skipped++;
      });
      const accounts = L.liveAccounts().map(a => {
        const info = L.accountInfo(a);
        return { account: a, info, saving: L.accountSaving(a, period, info) };
      });
      const savings = looseGoals.committed + accounts.reduce((t, x) => t + x.saving.committed, 0);

      let budgetsCommitted = 0, budgetsSpent = 0;
      L.liveBudgets().forEach(b => {
        const use = L.budgetUse(b);
        budgetsCommitted += use.committed;
        budgetsSpent += use.spent;
      });
      const free = leftOver - savings - budgetsCommitted;
      const daysLeft = Math.max(1, Math.round((period.nextPayday - today) / 86400000));

      const latestBalance = data.balances[data.balances.length - 1] || null;
      const outlook = latestBalance && new Date(latestBalance.createdAt) >= period.start
        ? L.balanceOutlook(latestBalance, period) : null;

      return {
        today, period, billsOnly, otherIncome, pay, otherItems, otherTotal, billsTotal, potLumpTotal, potLumpCount,
        potMonthly, income, leftOver, looseGoals, accounts, savings, budgetsCommitted, budgetsSpent, free, daysLeft,
        freePerDay: free / daysLeft, latestBalance, outlook
      };
    };

    // What's still to go out this pay period, soonest first: unpaid bills (overdue ones included) and standing
    // orders not marked done. Income still to come in is included with `income: true`.
    L.comingUp = () => {
      const today = startOfToday();
      const period = currentPayPeriod();
      const items = [];
      data.bills.filter(b => !b.archived).forEach(b => {
        if (b.kind === 'bill') {
          L.unpaidBetween(b, period.start, period.end).filter(d => d >= trackFrom(b))
            .forEach(d => items.push({ kind: 'bill', id: b.id, name: b.name, amount: b.amount, date: d }));
        } else if (!isPay(b)) {
          occurrencesBetween(b, today, period.end)
            .forEach(d => items.push({ kind: 'income', id: b.id, name: b.name, amount: b.amount, date: d }));
        }
      });
      L.liveAccounts().forEach(a => L.standingBetween(a, period.start, period.end).filter(d => !L.standingDone(a, d))
        .forEach(d => items.push({ kind: 'standing', id: a.id, name: `${a.name} standing order`, amount: a.standingAmount, date: d })));
      // Goals with a day of the month: what this period's plan still wants, on that day.
      L.liveGoals().filter(g => g.monthlyDay).forEach(g => {
        const plan = L.goalPlan(g);
        const left = plan.skip ? 0 : plan.planned - Math.max(0, plan.savedThisPeriod);
        const day = goalDaysBetween(g, period.start, period.end)[0];
        if (left > 0.005 && day) items.push({ kind: 'goal', id: g.id, name: g.name, amount: left, date: day });
      });
      return items.sort((x, y) => x.date - y.date);
    };

    L.reindex();
    return L;
  }

  return {
    fromRow, PAY_TAG, isPay, ledger,
    ISA_ALLOWANCE, PERSONAL_SAVINGS_ALLOWANCE, taxYearStart, standingOrder, transferTime, accountState,
    FREQUENCY_LABELS, PER_MONTH, AVG_MONTH_MS,
    parseLocalDate, toISODate, startOfToday, addDays, lastDayOfMonth, monthShort,
    occurrence, occurrencesFrom, occurrencesBetween, nextDue, trackFrom, monthlyAverage,
    isPotBill, yearlyBillsPot, payPeriodFor, currentPayPeriod, balanceForecast, formatMoney, hasTarget, pctOf, isDone,
    goalPlan, goalDaysBetween
  };
});
