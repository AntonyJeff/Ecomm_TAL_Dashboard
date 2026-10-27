import "dotenv/config";
import express from "express";
import cors from "cors";
import { accountsRouter } from "./routes/accounts.js";

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
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/accounts", accountsRouter);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`Ecomm TAL server listening on http://localhost:${port}`);
});
