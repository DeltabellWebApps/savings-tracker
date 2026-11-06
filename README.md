# Ledger

A personal money tracker: savings goals, regular bills, monthly budgets, and what's left over each pay period.
It's a single static page backed by [Supabase](https://supabase.com) (auth and Postgres).

Live at <https://deltabellwebapps.github.io/savings-tracker/>.

## What's in the repo

| Path | What it is |
|---|---|
| `index.html` | The whole web app: markup, styles and script. Four tabs: Overview, Goals, Bills, Budgets. |
| `ledger-core.js` | The app's core rules: dates, bill schedules, pay periods, the yearly bills pot, money formatting, goal plans and projections, savings account balances, interest and allowances. The app needs it to load. |
| `supabase/` | SQL migrations, run by hand in the Supabase SQL editor. |
| `widget/` | iPhone widgets and a quick spend script for [Scriptable](https://scriptable.app). See "Phone widgets" below. |

There's no build step. GitHub Pages serves the files as they are.

## How the money works

- **Pay period.** You're paid on the last day of each month, so a period runs from one payday to the day
  before the next. This is set in `currentPayPeriod()` in `ledger-core.js`.
- **Pay.** Each month's pay is a one-off `bills` row with `kind = 'income'` and `category = 'pay'`, dated on payday.
- **Other income** (benefits, side work, refunds) is a `bills` row with `kind = 'income'` and any other category,
  repeating like a bill. It's listed per source under pay in the Overview's Pay period card, where you add and
  edit it too. Sources due this period count towards left over; the rest are shown greyed with their next date.
- **Bills** repeat weekly, fortnightly, monthly, quarterly or yearly from a start date, with an optional last
  payment date. A recurring bill is tracked from the day it was added; earlier occurrences count as settled.
  "Mark paid" records the usual amount, and "Other amount" records a different one for bills that vary.
  Each recurring bill and category also shows what it costs over a year. The Bills tab's totals show the
  monthly average and what's left to pay this pay period (anything still unpaid up to the day before payday,
  overdue bills included).
- **Yearly bills pot.** Yearly and quarterly bills are budgeted a month at a time: a twelfth (or a third) of
  each counts in every pay period, and the bill itself isn't counted when it lands. The Bills tab lists them with
  how much should be put by today so each is covered on its due date. The app doesn't track the pot's real
  balance, and the bank balance forecast still takes each bill out on its due date.
  The rules are in `yearlyBillsPot()` in `ledger-core.js`.
- **Goals** have either a target date (the app works out the monthly amount) or a fixed monthly amount.
  The target is optional: a goal without one is open-ended and asks for its monthly amount every month.
  A £0 deposit marks a month as skipped. Each goal shows a projection: ahead of or behind a steady pace for
  dated goals, or an estimated finish month for the others. A monthly amount can have a day of the month, which
  puts it in "Coming up" with a "Done" button.
  - Each goal entry records **where its money is kept**: a savings account, or the current account. So one goal's
    money can sit in several accounts, and each account knows how much of its balance belongs to each goal.
  - **Pay out** spends a goal's money: it leaves the account for good. It lowers what the goal *holds* but not
    what it has *saved*, so a goal you've spent on stays complete (and can then be archived).
  - A goal can be set to **money goes straight out** (e.g. mortgage or loan overpayments). Nothing is kept: each
    amount comes off the account it was paid from, and cashback counts as "from outside my income".
- **Moving money.** One "Move money" form does every movement: from the current account, a savings account or
  outside your income, to a savings account, the current account or paid out, optionally split between goals.
  Money not given to a goal stays *unassigned*. "+ Add" and "Pay out" on a goal, "Assign" and "Done" on an
  account all open it filled in. The rules for what it records are in the comment above `openMoveSheet()` in
  `index.html`.
- **Savings accounts** (regular saver, cash ISA, other) are listed at the top of the Goals tab, with what each
  goal holds in them and what's unassigned. "edit" on a goal's line sets how much of the account is that goal's,
  with a date, or removes it: the difference comes from or goes back to unassigned (one goal entry, nothing moves
  between accounts). Balances are entered by hand now and then; any change beyond the transfers in between
  counts as interest. Also per account:
  - a monthly standing order in, which shows in "Coming up" with a "Done" button (you can change the amount
    each time) and stops at maturity
  - for an ISA, the £20,000 allowance used this tax year (from 6 April); a flexible ISA gets withdrawals back
  - for a regular saver, the monthly limit (per calendar month) and the maturity date, with a warning in the last 30 days

  Interest outside ISAs is shown against the £1,000 Personal Savings Allowance. The rules are in
  `accountState()` in `ledger-core.js` and `accountSaving()` in `index.html`.
- **What counts against this month's pay.** Only goal money that left the current account this pay period: kept
  in it, paid straight out of it, or moved by a transfer from it. Assigning money that was already in a savings
  account, money from outside your income and moves between accounts count towards the goal but not this month's
  plan, like cashback. An entry dated before payday belongs to the previous period; goal entries' dates can be
  changed from the goal's History. The rule is `fromIncome` in `ledger-core.js`.
- **Budgets** are monthly allowances (e.g. Groceries £300). They reset each payday, and spends are logged against them.
  The Budgets tab charts spending per pay period over the last six (all budgets, or one you tap), and each
  budget's average over the finished ones against its allowance. Past periods use today's allowances.
- **Overview.** Pay + other income − bills − the yearly bills pot = *left over*. Then subtract savings and budgets
  (each one's plan, or more if you've gone over it) to get *free to spend*. Savings are one row per account:
  what's been moved in this period, plus the standing order still to go, plus whatever its goals still want
  beyond that. Money that was already in the account only counts towards a goal once it's assigned. Goals with
  no account (and straight-out goals paid from the current account) are one "Goals" row.
  The Savings card lists each account's balance, how much of it is for goals and how much is unassigned.
  The charts and past pay are in a History section at the bottom, closed to start with.
- **Bank balance.** You enter your current account balance by hand (a second update on the same day replaces
  that day's). The Overview carries it forward to the day before payday: bills still to come out, income still to
  come in, savings still to move this month (standing orders on their dates), and what's left in budgets
  (spread evenly over the days left). Transfers to and from savings accounts move it; assigning money that's
  already in an account doesn't. For goals with no account, deposits are assumed to leave the current account.
  Anything marked paid, moved or spent after you entered the balance comes off too. It also shows the lowest point before payday, warns if you'd go overdrawn,
  and suggests how much you could move to a goal (one that's behind schedule first) without going below £0.
  The rules are in `balanceOutlook()` in `index.html` and `balanceForecast()` in `ledger-core.js`.
- **Archiving** hides a goal, bill, income source or budget from every list, total and chart without
  deleting its history. You can restore it from the "Archived" list at the bottom of its tab.

## Supabase setup

### Tables

Every table has `id uuid` (primary key), `user_id uuid` (defaults to `auth.uid()`) and `created_at timestamptz`.
Row-level security limits each user to their own rows.

| Table | Columns | Notes |
|---|---|---|
| `goals` | `name`, `target`, `saved`, `category`, `target_date`, `monthly_amount`, `sort_order`, `archived`, `account_id`, `straight_out`, `monthly_day` | `saved` is what the goal has saved, kept up to date by a trigger on `deposits` (pay outs left out). Never write it directly. `target` empty = open-ended (migration 006). `account_id` is only the usual account. |
| `deposits` | `goal_id`, `amount`, `note`, `external`, `account_id`, `paid_out`, `transfer_id` | Goal entries. Negative = taken out, 0 = skipped month. `external` (migration 005) = from outside your income. From migration 006: `account_id` = where the money is kept (null = current account), or for a straight-out goal where it was paid from; `paid_out` = spent (a pay out); `transfer_id` = the transfer that moved it, which several entries can share. |
| `bills` | `name`, `amount`, `frequency`, `start_date`, `end_date`, `kind` (`bill` / `income`), `category`, `archived` | Also holds income sources and monthly pay. |
| `bill_payments` | `bill_id`, `due_date`, `amount`, `paid_at` | One row per occurrence marked paid. |
| `budgets` | `name`, `amount`, `sort_order`, `archived` | Added in migration 001. |
| `spends` | `budget_id`, `amount`, `note`, `spent_on` | Added in migration 001. Negative = refund. |
| `balances` | `amount` | Added in migration 002. One row per balance update; the newest is the current one. Negative = overdrawn. |
| `accounts` | `name`, `kind` (`saver` / `isa` / `other`), `standing_amount`, `standing_start`, `monthly_limit`, `matures_on`, `flexible`, `isa_paid_before`, `isa_paid_before_year`, `sort_order`, `archived` | Added in migration 003 (`isa_paid_*` in 004). Savings accounts; the current account isn't one. `isa_paid_before` is ISA money paid in before the account was added, counted only in the tax year `isa_paid_before_year` starts. |
| `account_balances` | `account_id`, `amount` | Added in migration 003. Savings account balances as entered. |
| `transfers` | `account_id`, `amount`, `moved_on`, `note`, `deposit_id`, `due_date`, `external` | Added in migration 003 (`external` in 005). Positive = into savings. `due_date` marks a standing order occurrence; `external` = the other side isn't the current account (paid in from outside, paid out, or another savings account), so it doesn't move the current account. `deposit_id` is the old link to a goal entry, replaced by `deposits.transfer_id` in migration 006. |

Migration 003 also adds `goals.account_id`, the account a goal's money is kept in.

The first four tables were created in the Supabase dashboard. Their columns are listed above as the app uses them.

### Migrations

Run each file in `supabase/` once, in order: **Dashboard → SQL Editor → New query → paste → Run**.
Deploy the matching app code only *after* running the migration.

- `001_saved_trigger_archive_budgets.sql` does three things:
  - adds the trigger that keeps `goals.saved` in step with deposits
  - adds the `archived` columns
  - creates `budgets` and `spends`

  The file also has an optional query that checks whether any goal's total has drifted from its deposit history.
- `002_balances.sql` creates `balances` for the bank balance on the Overview.
- `003_accounts_transfers.sql` creates `accounts`, `account_balances` and `transfers`, and adds `goals.account_id`.
  Until it's run the app works as before, with savings accounts hidden.
- `006_goal_entries_accounts_payouts.sql` adds `deposits.account_id`, `paid_out` and `transfer_id` (filled in
  from existing data), `goals.straight_out` and `monthly_day`, lets `goals.target` be empty, and changes the
  trigger so pay outs don't lower `saved`. The app needs it from the "Move money" release on.

The `supabase/` folder isn't kept on GitHub, so these files are only in the local copy.

### Auth (email + password, and magic links)

Magic links need the app's address allowed as a redirect:
**Dashboard → Authentication → URL Configuration**

- **Site URL:** `https://deltabellwebapps.github.io/savings-tracker/`
- **Redirect URLs:** add the same URL. To test locally, also add e.g. `http://localhost:8000/`.

The link opens the app and signs you in on whichever device you open it on. Use "Sign up" to get a link
that also creates the account.

As it's a one-person app, turn new sign-ups off once your account exists:
**Dashboard → Authentication → Sign In / Providers → "Allow new users to sign up"**. Row-level security
already keeps other accounts out of your data, but there's no reason to let anyone make one.

## Phone notes

The app is mostly used in Safari on an iPhone. Two things to keep when editing the CSS:

- Inputs, selects and search boxes use **16px or larger** text. Below that, iOS zooms the page in when one
  is focused and the zoom sticks, pushing the fixed tab bar off screen.
- Date inputs drop the native look (`appearance: none`, `min-width: 0`). Otherwise iOS gives them a minimum
  width that runs off the edge of the form.

## Phone widgets

Four files go into Scriptable, each saved under the name shown (in Scriptable: **+**, paste, then rename at the top):

| Scriptable name | File | What it is |
|---|---|---|
| `ledger-core` | `ledger-core.js` | The shared rules, the same file the website uses. Copy it again whenever it changes. |
| `ledger-api` | `widget/ledger-api.js` | Sign-in and loading data. The session is kept in the iOS keychain, never the password. |
| `Ledger Widget` | `widget/ledger-widget.js` | The widget. |
| `Ledger Spend` | `widget/ledger-spend.js` | Logs a spend against a budget. |

Run **Ledger Widget** once in Scriptable to sign in with the website's email and password. Then add a Scriptable
widget to the Home Screen or Lock Screen, choose **Ledger Widget**, and set its **Parameter**:

- `free`: free to spend per day, days to payday, and where the bank balance will be before payday. Medium adds the
  pay period sums; large adds what's coming up.
- `coming`: bills and standing orders still to go out this pay period, with overdue ones in red.
- `savings`: total savings, each account's balance with its unassigned money or maturity warning, and goal progress.
- `budgets`: money left in each budget, against an even pace. Tapping it opens **Ledger Spend**.

Every mode works in the small, medium and large sizes and the three Lock Screen sizes. Widgets refresh when iOS
allows, roughly every 15–30 minutes, and show the last copy (marked "Offline") when there's no signal.

**Ledger Spend** asks which budget and how much, then logs it dated today. Run it from the budgets widget, from Siri
("Ledger Spend"), from a Home Screen icon (the script's ⓘ → Add to Home Screen), or from a Shortcut on the Action Button.

The widget's sums come from `ledger()` in `ledger-core.js`, which the Overview uses too, so the two always agree.

## Running locally

Serve the folder over HTTP (opening `index.html` as a file won't load `ledger-core.js` reliably):

```sh
npx serve .            # or: python -m http.server 8000
```

It talks to the live Supabase project, so you're working with real data.
