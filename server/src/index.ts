import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import { accountsRouter, prewarmCaches } from "./routes/accounts.js";

// Defense-in-depth: a background job (stale-while-revalidate refresh,
// cache prewarming, etc.) that rejects without its own .catch would
// otherwise take the whole process down on Node's default unhandled-
// rejection behavior. Every such call site should already have a .catch,
// but this keeps one bad background failure from becoming a full outage.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

const app = express();
app.use(cors());
// The API's JSON is extremely repetitive (thousands of accounts x the same
// keys) - gzip shrinks it ~10-20x, which matters far more over the internet
// to Render than it ever did on localhost.
app.use(compression());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/accounts", accountsRouter);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`Ecomm TAL server listening on http://localhost:${port}`);
  // Load the roster, Contact/Lead maps, owner buckets, live Factors and the
  // current week's touchpoints right away, so the first person to open the
  // dashboard after a deploy/restart isn't the one who pays for all of it.
  prewarmCaches();
});
