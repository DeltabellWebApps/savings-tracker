# Ledger

A personal money tracker: savings goals, regular bills, monthly budgets, and what's left over each pay period.
It's a single static page backed by [Supabase](https://supabase.com) (auth and Postgres).

Live at <https://deltabellwebapps.github.io/savings-tracker/>.

## What's in the repo

| Path | What it is |
|---|---|
| `index.html` | The whole web app: markup, styles and script. Four tabs: Overview, Goals, Bills, Budgets. |
| `ledger-core.js` | The app's core rules: dates, bill schedules, pay periods, the yearly bills pot, money formatting, goal plans and projections. The app needs it to load. |
| `supabase/` | SQL migrations, run by hand in the Supabase SQL editor. |

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
  A £0 deposit marks a month as skipped. Each goal shows a projection: ahead of or behind a steady pace for
  dated goals, or an estimated finish month for the others.
- **Budgets** are monthly allowances (e.g. Groceries £300). They reset each payday, and spends are logged against them.
  The Budgets tab charts spending per pay period over the last six (all budgets, or one you tap), and each
  budget's average over the finished ones against its allowance. Past periods use today's allowances.
- **Overview.** Pay + other income − bills − the yearly bills pot = *left over*. Then subtract goals and budgets (each one's plan, or
  more if you've gone over it) to get *free to spend*.
- **Bank balance.** You enter your current account balance by hand (a second update on the same day replaces
  that day's). The Overview carries it forward to the day before payday: bills still to come out, income still to
  come in, what's left to save for goals this month, and what's left in budgets (spread evenly over the days left).
  It assumes goal money goes to a separate savings account. Anything marked paid, saved or spent after you
  entered the balance comes off too. It also shows the lowest point before payday, warns if you'd go overdrawn,
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
| `goals` | `name`, `target`, `saved`, `category`, `target_date`, `monthly_amount`, `sort_order`, `archived` | `saved` is kept up to date by a trigger on `deposits`. Never write it directly. |
| `deposits` | `goal_id`, `amount`, `note` | Negative = withdrawal, 0 = skipped month. |
| `bills` | `name`, `amount`, `frequency`, `start_date`, `end_date`, `kind` (`bill` / `income`), `category`, `archived` | Also holds income sources and monthly pay. |
| `bill_payments` | `bill_id`, `due_date`, `amount`, `paid_at` | One row per occurrence marked paid. |
| `budgets` | `name`, `amount`, `sort_order`, `archived` | Added in migration 001. |
| `spends` | `budget_id`, `amount`, `note`, `spent_on` | Added in migration 001. Negative = refund. |
| `balances` | `amount` | Added in migration 002. One row per balance update; the newest is the current one. Negative = overdrawn. |

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

## Running locally

Serve the folder over HTTP (opening `index.html` as a file won't load `ledger-core.js` reliably):

```sh
npx serve .            # or: python -m http.server 8000
```

It talks to the live Supabase project, so you're working with real data.
