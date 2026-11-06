// Ledger quick spend for Scriptable. Save it in Scriptable as "Ledger Spend".
// Needs "ledger-core" and "ledger-api" saved next to it.
//
// Asks which budget and how much, and logs the spend dated today. Run it from:
//   - a Home Screen icon: in Scriptable, open the script's settings (the ⓘ) and choose "Add to Home Screen"
//   - Siri: say "Ledger Spend"
//   - the Action Button or Back Tap, through a Shortcut that runs the script
//   - the budgets widget, which opens this script when tapped

const core = importModule('ledger-core');
const api = importModule('ledger-api');
const { formatMoney } = core;

async function show(title, message) {
  const a = new Alert();
  a.title = title;
  if (message) a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

async function run() {
  if (!api.isSignedIn() && !(await api.signIn())) return;
  const loaded = await api.loadLedger();
  if (loaded.signedOut) {
    if (await api.signIn()) return run();
    return;
  }
  if (loaded.error) return show(loaded.error, 'Check your connection and try again.');

  const L = loaded.L;
  const list = L.liveBudgets().map(b => ({ b, use: L.budgetUse(b) }));
  if (!list.length) return show('No budgets yet', 'Add one on the Budgets tab first.');

  // Which budget: each shows what's left this month.
  let choice = 0;
  if (list.length > 1) {
    const pickBudget = new Alert();
    pickBudget.title = 'Log a spend';
    pickBudget.message = 'Which budget?';
    list.forEach(x => pickBudget.addAction(`${x.b.name} · ${x.use.over ? `${formatMoney(-x.use.left)} over` : `${formatMoney(x.use.left)} left`}`));
    pickBudget.addCancelAction('Cancel');
    choice = await pickBudget.presentSheet();
    if (choice === -1) return;
  }
  const { b, use } = list[choice];

  // How much, and an optional note.
  const ask = new Alert();
  ask.title = b.name;
  ask.message = `${formatMoney(use.left)} left of ${formatMoney(b.amount)} this month. Enter a negative amount for a refund.`;
  const amountField = ask.addTextField('Amount');
  amountField.setDecimalPadKeyboard();
  ask.addTextField('Note (optional)');
  ask.addAction('Log it');
  ask.addCancelAction('Cancel');
  if (await ask.presentAlert() === -1) return;
  const amount = parseFloat(ask.textFieldValue(0).replace(/[£,\s]/g, ''));
  if (!Number.isFinite(amount) || amount === 0) return show('No amount entered', 'Nothing was logged.');

  try {
    await api.addSpend(b.id, amount, ask.textFieldValue(1).trim());
  } catch (e) {
    return show("Couldn't log it", e.message || 'Check your connection and try again.');
  }
  const leftNow = use.left - amount;
  const n = new Notification();
  n.title = `${amount > 0 ? 'Logged' : 'Refunded'} ${formatMoney(Math.abs(amount))} · ${b.name}`;
  n.body = leftNow < 0 ? `${formatMoney(-leftNow)} over this month` : `${formatMoney(leftNow)} left this month`;
  await n.schedule();
}

await run();
Script.complete();
