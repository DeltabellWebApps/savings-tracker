// Ledger quick save for Scriptable. Save it in Scriptable as "Ledger Save".
// Needs "ledger-core" and "ledger-api" saved next to it.
//
// Asks which goal and how much, and logs it today — the same as "+ Add" (or "+ Pay", for a straight-out goal)
// on the website, into wherever the goal's money usually goes. Run it from:
//   - a Home Screen icon: in Scriptable, open the script's settings (the ⓘ) and choose "Add to Home Screen"
//   - Siri: say "Ledger Save"
//   - the Action Button or Back Tap, through a Shortcut that runs the script
//   - the savings widget, which opens this script when tapped

const core = importModule('ledger-core');
const api = importModule('ledger-api');
const { formatMoney, isDone } = core;

async function show(title, message) {
  const a = new Alert();
  a.title = title;
  if (message) a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

// Same shape as the goal card's progress line on the website, just as plain text.
function progressLine(L, g) {
  if (g.resetFrequency) {
    const a = L.goalAllowance(g);
    return `${formatMoney(a.used)} of ${formatMoney(a.allowance)} this cycle`;
  }
  if (g.target > 0) return `${formatMoney(g.saved)} of ${formatMoney(g.target)}`;
  return `${formatMoney(g.saved)} ${g.straightOut ? 'paid' : 'saved'} so far`;
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
  // A straight-out goal (Car Loan, Mortgage) and a periodic-reset one (an allowance that renews each cycle)
  // always take more; an ordinary goal stops offering once it's done — the same as the "+ Add"/"+ Pay" button
  // on the website. (`isDone` keeps climbing past a reset goal's allowance every cycle, so it can't be trusted
  // for this goal shape.)
  const list = L.liveGoals().filter(g => g.straightOut || g.resetFrequency || !isDone(g));
  if (!list.length) return show('No goals to add to', 'Add one on the Goals tab first.');

  // Which goal.
  let choice = 0;
  if (list.length > 1) {
    const pickGoal = new Alert();
    pickGoal.title = 'Log money saved';
    pickGoal.message = 'Which goal?';
    list.forEach(g => pickGoal.addAction(`${g.name} · ${progressLine(L, g)}`));
    pickGoal.addCancelAction('Cancel');
    choice = await pickGoal.presentSheet();
    if (choice === -1) return;
  }
  const g = list[choice];
  const account = L.accountOf(g);

  // How much, and an optional note.
  const ask = new Alert();
  ask.title = g.name;
  ask.message = `${progressLine(L, g)}${account ? ` · kept in ${account.name}` : ''}`;
  const amountField = ask.addTextField('Amount');
  amountField.setDecimalPadKeyboard();
  ask.addTextField('Note (optional)');
  ask.addAction(g.straightOut ? 'Log it' : 'Add it');
  ask.addCancelAction('Cancel');
  if (await ask.presentAlert() === -1) return;
  const amount = parseFloat(ask.textFieldValue(0).replace(/[£,\s]/g, ''));
  if (!(amount > 0)) return show('No amount entered', 'Nothing was logged.');

  try {
    await api.addDeposit(g, account ? account.id : null, amount, ask.textFieldValue(1).trim());
  } catch (e) {
    return show("Couldn't log it", e.message || 'Check your connection and try again.');
  }
  const n = new Notification();
  n.title = `${g.straightOut ? 'Paid' : 'Added'} ${formatMoney(amount)} · ${g.name}`;
  n.body = g.resetFrequency
    ? `${formatMoney(L.goalAllowance(g).used + amount)} of ${formatMoney(g.target)} this cycle`
    : g.target > 0 ? `${formatMoney(g.saved + amount)} of ${formatMoney(g.target)} now` : `${formatMoney(g.saved + amount)} now`;
  await n.schedule();
}

await run();
Script.complete();
