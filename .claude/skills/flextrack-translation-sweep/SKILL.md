---
name: flextrack-translation-sweep
description: Sweep a Flextrack environment (QA, UAT, demo or other non-production instance) for missing translations. Crawls the app once per locale with a headless browser and reports raw translation keys (e.g. "label.worker.startDate", "???key???"), unrendered placeholders ("{{count}}"), and text left in the base language (English text on a French page). Use when someone asks to find missing or broken translations, check localization or i18n coverage, or audit a language in a Flextrack environment.
---

# Flextrack translation sweep

Crawl a Flextrack environment in a reference locale (usually `en-US`) and in each target locale, then compare the pages to find strings that were not translated.

The crawler is `scripts/sweep.js` (Node + Playwright). It is read-only: it only follows `<a href>` links, never clicks buttons or submits forms (apart from the login form), and skips links that look destructive (logout, delete, approve, reject, export, …).

## Data handling (required)

- **Only sweep non-production environments with synthetic or anonymized data** (QA, UAT, demo, sandbox). If the user names a production environment or a customer's live instance, stop and ask them for a non-production one instead. Customer production data is not permitted.
- The crawler does not collect table cells (`<td>`), input values, text areas or `[data-no-translate]` content, so worker and customer records shown in grids are left out. Don't turn that off. If a page shows personal data outside tables, add a selector for it with `--exclude-selector`.
- Credentials go in environment variables (`FLEXTRACK_USER`, `FLEXTRACK_PASSWORD`). Never write them into files, commands that are echoed back, or the report. Don't commit saved sessions (`--save-storage-state` files). They contain session cookies.
- Write output to the scratchpad or another git-ignored folder, not into the repository.

## Steps

### 1. Gather inputs

Ask the user only for the details you don't already have:

| Input | Example | Notes |
| --- | --- | --- |
| Environment URL | `https://qa.flextrack.example.com` | Must be non-production. |
| Target locales | `fr-CA, es-US` | The languages to check. |
| Reference locale | `en-US` | Default `en-US`. |
| How the app switches language | browser setting / `?lang=` / cookie / URL prefix | If unknown, start with `browser`. See step 3. |
| Login | username + password, or SSO | SSO: use a saved session (step 2). |
| Scope | whole app, or specific modules/paths | Defaults to crawling from `/`. |

### 2. Prepare

```bash
cd .claude/skills/flextrack-translation-sweep/scripts
node -e "require('playwright')" 2>/dev/null || (npm install playwright && npx playwright install chromium)
```

In a Claude Code cloud session Playwright and Chromium are already installed, so skip the install.

Login options:
- **Username/password form:** the user sets `FLEXTRACK_USER` and `FLEXTRACK_PASSWORD` in their shell or environment secrets. Pass `--login-url` if the login page isn't the root. Override `--user-selector`, `--pass-selector` and `--submit-selector` if the default selectors don't match the form. Two-step logins (username first, then password) are supported.
- **SSO / MFA:** on a machine with a display, run once with `--headful --save-storage-state ./ft-session.json`. The user logs in by hand, and later runs pass `--storage-state ./ft-session.json`.

### 3. Find the locale switch with a small trial run

Before a full sweep, run with `--max-pages 3` for one target locale. Then check the **`<html lang>` seen** column and the untranslated count in `report.md`:

- If everything is listed as untranslated, the language didn't switch. Try another `--locale-mode`:
  - `browser` sets the browser locale and `Accept-Language` (default).
  - `query` appends `?<param>=<code>`. Set the name with `--locale-param`, e.g. `--locale-param culture`.
  - `cookie` sets cookie `<param>=<code>`.
  - `path` prefixes URLs with `/<code>/`.
  - `none` is for when the language comes from the user profile. Run the reference locale and each target as separate users: change the profile language, then sweep each one with `--storage-state`.
- If the app uses its own codes, map them, e.g. `--locale-value-map "fr-CA=fr_CA,es-US=es"`.
- To find the switch, look at the language picker in the UI or ask the user how Flextrack's language selector works in that environment.

### 4. Run the sweep

```bash
node sweep.js \
  --base-url "$FT_URL" \
  --locales fr-CA,es-US \
  --base-locale en-US \
  --locale-mode query --locale-param lang \
  --max-pages 200 \
  --ignore-file ../ignore.txt \
  --out "<scratchpad>/translation-sweep"
```

Useful scope options:
- `--start-paths /requisitions,/workers,/timesheets` starts the crawl from specific modules.
- `--paths-file paths.txt` visits exactly these paths, one per line, with no link following. Use it for single-page-app routes the crawler can't discover.
- `--include` / `--exclude` take a regex on the URL.
- `--wait-ms 3000` is for slow pages that render after load.

Run with `--help` for every option. Pages with numeric or GUID ids (`/worker/123`) count as one page type, so the crawl doesn't revisit every record.

### 5. Review and report

Outputs in `--out`:
- `report.md` has a summary per locale and unique findings grouped by string, with the pages they appear on.
- `findings.csv` has one row per occurrence, for spreadsheets or importing into Jira.
- `findings.json` has the raw findings, crawl metadata and page errors.

Before reporting, triage the findings:

1. **raw-key** and **placeholder** findings are almost always real bugs. A raw key in the reference locale too means the key is missing from every resource file.
2. **untranslated** at "same element" is high confidence. *(medium)* means the text matched the base locale somewhere on the page but not at the same element, so check those by hand.
3. Drop false positives: product and brand names, cognates that are the same in both languages (e.g. "Total", "Date" in French), customer-configured labels, and data values. Add recurring ones to `ignore.txt` (exact strings or `/regex/`) so later sweeps stay clean.
4. List pages that failed to load or returned 4xx/5xx separately. They weren't checked.

Give the user:
- a short summary table per locale: pages crawled, raw keys, placeholders, untranslated
- the top findings by number of pages affected, with the resource key where it is visible
- known gaps in coverage: pages behind buttons or modals the crawler can't open, and pages that errored
- the path to `report.md` / `findings.csv`

If the user wants tickets, give them a ready-to-paste list grouped by module (first path segment). Don't create Jira issues unless they ask.

## Limits

- Text that only appears after clicking (modals, tabs, dropdown menus, validation messages, emails, PDFs) is not reached. Use `--paths-file` for direct routes and mention the gap in the report.
- Heuristics can't tell a correct cognate from an untranslated string. That's what step 5's triage is for.
- The crawl runs in the user's environment, so its network policy must allow the environment URL.
