import "dotenv/config";
import { google } from "googleapis";

const SOURCE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SOURCE_TAB = process.env.GOOGLE_SHEET_TAB || "Global";
const DEST_SHEET_ID = process.env.ENGAGEMENT_SHEET_ID;
const DEST_TAB = "Global_Ecomm_TAL";

function getAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function main() {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });

  console.log(`Reading ${SOURCE_TAB} from source sheet ${SOURCE_SHEET_ID}...`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SOURCE_SHEET_ID,
    range: `${SOURCE_TAB}!A1:Z`,
  });
  const values = res.data.values || [];
  console.log(`Read ${values.length} rows (including header).`);
  if (values.length === 0) {
    throw new Error("Source sheet returned no rows - aborting, nothing to migrate.");
  }

  // Check whether the destination tab already exists.
  const destMeta = await sheets.spreadsheets.get({ spreadsheetId: DEST_SHEET_ID });
  const existing = destMeta.data.sheets?.find((s) => s.properties?.title === DEST_TAB);

  if (existing) {
    console.log(`Tab "${DEST_TAB}" already exists in destination sheet - clearing it before re-writing.`);
    await sheets.spreadsheets.values.clear({
      spreadsheetId: DEST_SHEET_ID,
      range: `${DEST_TAB}!A1:Z`,
    });
  } else {
    console.log(`Creating new tab "${DEST_TAB}" in destination sheet...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: DEST_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: DEST_TAB } } }],
      },
    });
  }

  console.log(`Writing ${values.length} rows into ${DEST_TAB}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: DEST_SHEET_ID,
    range: `${DEST_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });

  console.log("Done. Verifying...");
  const verify = await sheets.spreadsheets.values.get({
    spreadsheetId: DEST_SHEET_ID,
    range: `${DEST_TAB}!A1:Z`,
  });
  console.log(`Destination tab now has ${(verify.data.values || []).length} rows (including header).`);
}

main().catch((err) => {
  console.error("Migration failed:", err.message || err);
  process.exit(1);
});
