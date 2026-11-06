---
name: deployment-plan
description: Create a Light Rollout deployment plan (DPL) document from a ticket. Use when the user gives a ticket (ID, link, or pasted text) and asks for a deployment plan, DPL doc, rollout plan, or deployment documentation, or invokes /deployment-plan.
---

# Deployment Plan (DPL) — Light Rollout

Turn a ticket into a filled-in deployment plan document based on
`light-rollout-template.csv` (in this folder). The template is the source of
truth for the steps; never drop, reorder or rename them.

## 1. Gather inputs from the ticket

Read the ticket the user gives (ID, link, or pasted text). For a Jira link or
key, use the Atlassian connector (`getJiraIssue` with `view: "evidence"`, plus
`listJiraIssueComments`). If no ticket tool is connected, ask the user to paste
the ticket text.

| Field | Where to look | If missing |
| --- | --- | --- |
| Ticket ID + summary | Key and title | Ask before starting |
| Change description / scope | Description, acceptance criteria | Write "TBD" |
| PROD target date (D) | Due date, fix version, release field, user's message | **Ask** — all dates depend on it |
| Owners | Assignee, reporter, QA / IT / CS watchers | Leave blank, add an open question |
| Components / artifacts | Components, linked PRs, build numbers | Add an open question |
| FULL refresh needed? (DPL-1) | Comments, labels (`refresh`, `data-migration`) | Mark DPL-1 as Open |
| Known risks | Linked issues, comments, priority | One placeholder row in the risk table |

Data rule: use ticket data only. Never copy customer production data, worker
or candidate records, government IDs, financial or health data, or
credentials into the plan. If the ticket contains any, leave it out and say so.

## 2. Compute dates

Count back from the PROD date D in calendar days (as in the CSV, where
20–27 Jun = D−7 … D). If a date lands on Saturday or Sunday, move it to the
previous Friday. Format dates as `DD-Mon` to match the template, plus the
full date in the header.

| # | Process step | Env | DPL | Target | Comment |
| --- | --- | --- | --- | --- | --- |
| 1 | QA Complete | QA | — | D−7 | QA tested before Staging DPL (rehearsal) |
| 2 | Decision: Refresh FULL? | — | DPL-1 | D−7 | Decide before FULL deploy |
| 3 | Prepare artifacts & plan for Staging | FULL | DPL-2 | D−7 | Deployment checklist (DPL) and package/artifacts ready |
| 4 | Review & update plan (FULL) | FULL | DPL-2 | D−6 | Peer review with IT/CS (rehearsal) |
| 5 | Deploy to FULL | FULL | DPL-2 | D−5 | |
| 6 | Log & resolve issues (DPL issues) | FULL | DPL-2 | D−4 | Critical feedback loop to PROD plan |
| 7 | Review & update plan (PROD) | PROD | DPL-3 | D−3 | Critical feedback loop to PROD plan |
| 8 | Review issues & resolution/mitigation (cross reference) | PROD | DPL-3 | D−2 | |
| 9 | Risk assessment (Go / No-Go / Repeat) | PROD | DPL-3 | D−1 | |
| 10 | Deploy to PROD | PROD | DPL-3 | D | |

All rows are Level `Basic`. Status starts at `Planned` for steps 1–9 and
blank for step 10 (as in the CSV). If DPL-1 is "Yes", insert a
"Refresh FULL environment" step (FULL, DPL-2) right before Deploy to FULL.

**Already deployed?** If the ticket is Done or has a promotion date in the
past, use the actual promotion date as D, say in the summary that the plan is a
retrospective record, mark only steps the ticket proves as `Done` (cite the
evidence in Comment), and leave the rest blank — never `Planned` for past dates.

## 3. Gate rules to state in the plan

- **DPL-1 — Refresh decision:** answered Yes/No before step 3.
- **DPL-2 — FULL rehearsal (steps 3–6):** every issue logged in step 6 has a
  resolution or mitigation before step 7.
- **DPL-3 — PROD readiness (steps 7–10):** step 9 records Go / No-Go / Repeat.
  No-Go or Repeat sends the plan back to step 4 with new dates.

## 4. Write the document

Create it as a Claude Doc when the Docs tools are available (follow the docs
skill / server instructions); otherwise write
`deployment-plans/DPL-<ticket-id>.md` in the repo. Title:
`DPL — <ticket ID> — <summary>`. Sections, in order:

1. **Summary** — one sentence: what ships, to PROD on which date, ticket link.
   Then a short table: Ticket, Scope, Components/artifacts, PROD date, Owners.
2. **Rollout plan** — the 10-step table above with real dates, columns
   `# · Level · Process step · Environment · Status · Target date · Owner(s) · DPL · Comment`.
   Use a Status dropdown (Planned, In progress, Done, Blocked) in a Claude Doc.
3. **Gates** — the three DPL gate rules, with the DPL-1 decision filled if known.
4. **DPL-2 issues log** — empty table: `# · Issue · Found in step · Resolution / mitigation · Owner · Status`.
5. **DPL-3 risk assessment** — table: `Risk · Likelihood · Impact · Mitigation · Owner`,
   seeded from ticket risks; then a line `Decision: Go / No-Go / Repeat — pending`.
6. **Rollback** — how to revert (from the ticket if stated, else an open question).
7. **Open questions** — `- [ ]` checklist of everything missing from step 1.

Keep it factual: no invented owners, dates, artifacts or risks. Finish by
giving the user the doc link and listing the open questions in one line.
