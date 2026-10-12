# Sprint Pulse

Live Jira dashboard for the Prod sprint board (board 1282 on megatron.atlassian.net).

- **Published dashboard:** https://claude.ai/artifact/BWQZsZo4eiMK7iy6kV6ooJ
- **Source of the page:** `index.html` (the dashboard's `files/index.html`)

## Data

Every viewer's browser queries Jira live through their own claude.ai **Atlassian** connector
(tool `searchJiraIssuesUsingJql`, cloud `megatron.atlassian.net`). Nothing is stored in this repo.

| Dataset | JQL |
| --- | --- |
| `sprint_tickets` | `project in (IP, IR, CR) AND sprint is not EMPTY AND updated >= -90d` |
| `worklogs` | same as above, `worklog` field only |
| `backlog` | `project in (IP, IR, CR) AND statusCategory != Done` |
| `stale` | `project in (IP, IR, CR) AND statusCategory != Done AND updated <= -60d` |

The sprint field on this site is `customfield_10021`; tickets are kept when their latest sprint is on board 1282.

## Risk score (Backlog risk tab)

| Signal | Points |
| --- | --- |
| No update in 60+ days | +3 |
| Highest / High priority | +3 / +2 |
| Open "is blocked by" / "depends on" link | +3 (status Blocked only: +2) |
| Invoicing / financial keywords in summary or labels | +3 |
| High priority with no assignee | +1 |

"Needs management action" = high priority and blocked or stale; or financial and blocked, stale or high
priority; or score ≥ 7. The daily watchlist shows the top 10 of those (topped up to 5 with the riskiest others).
