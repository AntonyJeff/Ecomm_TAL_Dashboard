"""
Daily Factors.ai engagement snapshot sync.

What this does, every time it runs:
  1. Reads the live TAL account list (5,555+ accounts) from the
     "Global_Ecomm_TAL" tab of the engagement Google Sheet - the same source
     the dashboard itself uses. (Everything now lives in one spreadsheet.)
  2. Queries Salesforce for every Factors.ai-related field on those Account
     records (Engagement_Level__c - Hot/Warm/Cold/Ice - plus the raw score,
     score bucket, last engagement date, and a few related text fields).
  3. APPENDS one row per account to the "Factors_Score" tab of the
     engagement Google Sheet, stamped with today's date and a run timestamp.

Append-only, by design: a past day's row is never edited or overwritten.
That's what lets the dashboard show "Week 2 was Hot, Week 4 is Cold" as two
different historical facts instead of one value that silently changes
underneath you - same snapshot pattern already used for the LinkedIn data.

Run manually:
    python automation/factors_score_sync.py
    python automation/factors_score_sync.py --dry-run   # fetch + print only, no write
    python automation/factors_score_sync.py --limit 10  # only the first N accounts (testing)
    python automation/factors_score_sync.py --backdate 2026-11-02T23:55  # catch-up for a missed day

Scheduled (e.g. GitHub Actions cron) - needs these as secrets/env vars,
same values as server/.env:
    SF_LOGIN_URL, SF_CONSUMER_KEY, SF_CONSUMER_SECRET
    GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY
    ENGAGEMENT_SHEET_ID (single sheet: account list + where this writes)
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# Load the same .env the Node server uses - one source of truth for credentials.
load_dotenv(Path(__file__).resolve().parent.parent / "server" / ".env")

# .strip() every secret read from the environment - GitHub Actions secrets
# are stored byte-for-byte, so a trailing newline picked up from copy-pasting
# a value (e.g. SF_LOGIN_URL becoming "https://...salesforce.com\n") silently
# breaks the first network call that uses it. Confirmed as a real incident:
# urllib3.exceptions.LocationParseError on SF_LOGIN_URL with a trailing \n.
SF_LOGIN_URL = os.environ["SF_LOGIN_URL"].strip()
SF_CONSUMER_KEY = os.environ["SF_CONSUMER_KEY"].strip()
SF_CONSUMER_SECRET = os.environ["SF_CONSUMER_SECRET"].strip()

GOOGLE_CLIENT_EMAIL = os.environ["GOOGLE_CLIENT_EMAIL"].strip()
GOOGLE_PRIVATE_KEY = os.environ["GOOGLE_PRIVATE_KEY"].strip().replace("\\n", "\n")
ENGAGEMENT_SHEET_ID = os.environ["ENGAGEMENT_SHEET_ID"].strip()
# The account roster and this script's output now live in the same spreadsheet.
GOOGLE_SHEET_ID = ENGAGEMENT_SHEET_ID
GOOGLE_SHEET_TAB = os.environ.get("GOOGLE_SHEET_TAB", "Global_Ecomm_TAL").strip()

FACTORS_SHEET_TAB = "Factors_Score"
SOQL_BATCH_SIZE = 300  # stays well under Salesforce's IN-list/URL length limits

# Every Factors.ai-related Account field found via live Salesforce describe
# (not guessed from labels - confirmed API names). (sheet_column_header, api_field_name)
FACTORS_FIELDS = [
    ("Engagement Level", "Engagement_Level__c"),  # Hot / Warm / Cold / Ice
    ("Factors Engagement Score", "Factors_Engagement_Score__c"),
    ("Factors Engagement Score Bucket", "Factors_Engagement_Score_Bucket__c"),
    ("Factors Identified Account", "Factors_Identified_Account__c"),
    ("Factors SDR Tracker", "Factors_SDR_Tracker__c"),
    ("Last Engagement Date", "Last_Engagement_Date__c"),
    ("Top Engagement Signals", "Top_Engagement_Signals__c"),
    ("Interest Groups", "Interest_groups__c"),
    ("Research Intents", "Research__c"),
    ("Customer Engagement (Uber Account)", "Uber_Account__c"),
]


def sf_authenticate() -> tuple[str, str]:
    res = requests.post(
        f"{SF_LOGIN_URL}/services/oauth2/token",
        data={
            "grant_type": "client_credentials",
            "client_id": SF_CONSUMER_KEY,
            "client_secret": SF_CONSUMER_SECRET,
        },
        timeout=30,
    )
    res.raise_for_status()
    body = res.json()
    return body["access_token"], body["instance_url"]


def sf_query(access_token: str, instance_url: str, soql: str) -> list[dict]:
    """Runs one SOQL query, following pagination until all records are collected."""
    records: list[dict] = []
    url = f"{instance_url}/services/data/v61.0/query?q={requests.utils.quote(soql)}"
    headers = {"Authorization": f"Bearer {access_token}"}
    while url:
        res = requests.get(url, headers=headers, timeout=60)
        res.raise_for_status()
        body = res.json()
        records.extend(body["records"])
        next_path = body.get("nextRecordsUrl")
        url = f"{instance_url}{next_path}" if next_path else None
    return records


def chunk(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def sheets_client():
    creds = Credentials.from_service_account_info(
        {
            "client_email": GOOGLE_CLIENT_EMAIL,
            "private_key": GOOGLE_PRIVATE_KEY,
            "token_uri": "https://oauth2.googleapis.com/token",
        },
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def get_account_list(sheets) -> list[dict]:
    """Reads the live TAL account list - same source the dashboard reads from."""
    result = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=GOOGLE_SHEET_ID, range=f"{GOOGLE_SHEET_TAB}!A1:F")
        .execute()
    )
    rows = result.get("values", [])
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]

    def col(name: str) -> int:
        for i, h in enumerate(header):
            if name in h:
                return i
        return -1

    id_idx, name_idx, website_idx = col("account id"), col("account name"), col("website")
    accounts = []
    for r in rows[1:]:
        if not r or id_idx >= len(r) or not r[id_idx]:
            continue
        accounts.append(
            {
                "id": r[id_idx].strip(),
                "name": r[name_idx].strip() if name_idx >= 0 and name_idx < len(r) else "",
                "website": r[website_idx].strip() if website_idx >= 0 and website_idx < len(r) else "",
            }
        )
    return accounts


def expected_header() -> list[str]:
    return ["run_date", "run_timestamp", "account_id", "account_name", "domain"] + [
        f[0] for f in FACTORS_FIELDS
    ]


def ensure_factors_tab_exists(sheets):
    """
    Creates the tab if it's missing, AND writes the header if row 1 doesn't
    already have one - these are two independent checks, not one. A tab that
    was pre-created (e.g. manually, to pin down its gid in a shared link)
    exists but is empty, and was previously mistaken for "already has a
    header" just because the tab itself existed - that silently produced a
    sheet with real data starting on row 1 and no column labels at all.
    """
    meta = sheets.spreadsheets().get(spreadsheetId=ENGAGEMENT_SHEET_ID).execute()
    existing = {s["properties"]["title"] for s in meta["sheets"]}
    if FACTORS_SHEET_TAB not in existing:
        print(f"Creating '{FACTORS_SHEET_TAB}' tab (did not exist yet)...")
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=ENGAGEMENT_SHEET_ID,
            body={"requests": [{"addSheet": {"properties": {"title": FACTORS_SHEET_TAB}}}]},
        ).execute()

    row1 = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=ENGAGEMENT_SHEET_ID, range=f"{FACTORS_SHEET_TAB}!A1:A1")
        .execute()
        .get("values", [])
    )
    has_header = bool(row1) and bool(row1[0]) and row1[0][0] == "run_date"
    if has_header:
        return

    print("Tab has no header row yet - writing one now...")
    sheet_id = next(
        s["properties"]["sheetId"] for s in meta["sheets"] if s["properties"]["title"] == FACTORS_SHEET_TAB
    )
    # Refresh in case the tab was just created above and isn't in `meta` yet.
    if sheet_id is None:
        meta = sheets.spreadsheets().get(spreadsheetId=ENGAGEMENT_SHEET_ID).execute()
        sheet_id = next(
            s["properties"]["sheetId"] for s in meta["sheets"] if s["properties"]["title"] == FACTORS_SHEET_TAB
        )

    if row1 and row1[0]:
        # Existing data already sits at row 1 - insert a fresh blank row
        # above it rather than overwriting real data.
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=ENGAGEMENT_SHEET_ID,
            body={
                "requests": [
                    {
                        "insertDimension": {
                            "range": {"sheetId": sheet_id, "dimension": "ROWS", "startIndex": 0, "endIndex": 1},
                            "inheritFromBefore": False,
                        }
                    }
                ]
            },
        ).execute()

    sheets.spreadsheets().values().update(
        spreadsheetId=ENGAGEMENT_SHEET_ID,
        range=f"{FACTORS_SHEET_TAB}!A1",
        valueInputOption="RAW",
        body={"values": [expected_header()]},
    ).execute()


IST_OFFSET = timedelta(hours=5, minutes=30)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch and print only, don't write to the sheet")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N accounts (testing)")
    parser.add_argument(
        "--backdate",
        metavar="YYYY-MM-DDTHH:MM",
        default=None,
        help=(
            "Catch-up run for a day the scheduled job missed - stamps the "
            "row with this IST date/time instead of right now (e.g. "
            "'2026-11-02T23:55' for an 11:55 PM IST run that never "
            "happened). The data fetched is always live/current; only the "
            "run_date/run_timestamp written to the sheet are backdated, so "
            "the history reads as if the job had actually run then."
        ),
    )
    args = parser.parse_args()

    t0 = time.time()
    if args.backdate:
        ist_dt = datetime.strptime(args.backdate, "%Y-%m-%dT%H:%M")
        run_dt = ist_dt - IST_OFFSET  # IST -> UTC, for the stored timestamp
        run_date = ist_dt.strftime("%Y-%m-%d")  # the calendar day this snapshot represents, in IST
        run_timestamp = run_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        print(f"BACKDATING: writing this run as {run_date} {args.backdate} IST ({run_timestamp} UTC)")
    else:
        run_dt = datetime.now(timezone.utc)
        run_date = run_dt.strftime("%Y-%m-%d")
        run_timestamp = run_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    print("Authenticating to Salesforce...")
    access_token, instance_url = sf_authenticate()

    print("Authenticating to Google Sheets...")
    sheets = sheets_client()

    print(f"Reading account list from Google Sheet ({GOOGLE_SHEET_ID}, tab '{GOOGLE_SHEET_TAB}')...")
    accounts = get_account_list(sheets)
    if args.limit:
        accounts = accounts[: args.limit]
    print(f"  {len(accounts)} accounts to process")

    id_to_account = {a["id"]: a for a in accounts}
    field_names = ", ".join(f[1] for f in FACTORS_FIELDS)

    rows: list[list] = []
    batches = chunk(list(id_to_account.keys()), SOQL_BATCH_SIZE)
    for i, batch in enumerate(batches, 1):
        id_list = ",".join(f"'{aid}'" for aid in batch)
        soql = f"SELECT Id, Name, Website, {field_names} FROM Account WHERE Id IN ({id_list})"
        records = sf_query(access_token, instance_url, soql)
        print(f"  batch {i}/{len(batches)}: queried {len(batch)} accounts, got {len(records)} back")

        for rec in records:
            acct = id_to_account.get(rec["Id"], {})
            row = [
                run_date,
                run_timestamp,
                rec["Id"],
                rec.get("Name") or acct.get("name", ""),
                rec.get("Website") or acct.get("website", ""),
            ]
            for _, api_name in FACTORS_FIELDS:
                val = rec.get(api_name)
                row.append("" if val is None else str(val))
            rows.append(row)

    print(f"\nFetched Factors data for {len(rows)} of {len(accounts)} accounts.")

    if args.dry_run:
        print("\n--dry-run set - not writing to the sheet. First 5 rows:")
        print(expected_header())
        for r in rows[:5]:
            print(r)
    else:
        ensure_factors_tab_exists(sheets)
        print(f"Appending {len(rows)} rows to '{FACTORS_SHEET_TAB}'...")
        sheets.spreadsheets().values().append(
            spreadsheetId=ENGAGEMENT_SHEET_ID,
            range=f"{FACTORS_SHEET_TAB}!A1",
            valueInputOption="RAW",
            insertDataOption="INSERT_ROWS",
            body={"values": rows},
        ).execute()
        print("Done.")

    print(f"\nTotal time: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
