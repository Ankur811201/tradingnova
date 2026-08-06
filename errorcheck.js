require("dotenv").config();
const mongoose = require("mongoose");

const INSTANCE_ID = "inst_eb02da30-a2a5-44f3-86fe-f7b6e0bd757f";

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    console.log("========================================");
    console.log(" NOVA TRADE - DECISION DEBUG");
    console.log("========================================\n");

    const db = mongoose.connection.db;

    const events = await db.collection("strategyevents")
      .find({
        instanceId: INSTANCE_ID,
        eventType: "DECISION"
      })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    console.log("Instance :", INSTANCE_ID);
    console.log("Total Decision Events :", events.length);
    console.log("");

    let buy = 0;
    let sell = 0;
    let wait = 0;

    events.forEach((e, index) => {

      const p = e.payload || {};

      const decision =
        p.finalDecision ||
        p.decision ||
        p.action ||
        "UNKNOWN";

      if (decision === "BUY") buy++;
      else if (decision === "SELL") sell++;
      else wait++;

      console.log("\n====================================================");
      console.log(`Decision #${index + 1}`);
      console.log("====================================================");

      console.log("Time :", e.createdAt);
      console.log("Decision :", decision);
      console.log("Reason :", p.reason);
      console.log("Rule :", p.ruleId);

      console.log("\n------------- CANDLE ----------------");
      console.dir(p.candle, { depth: null });

      console.log("\n------------- LEVELS ----------------");
      console.dir(p.levels, { depth: null });

      console.log("\n------------- CHECKS ----------------");

      if (!p.checks) {
        console.log("No checks (probably insufficient_history)");
      } else {

        console.dir(p.checks, { depth: null });

        console.log("\nCHECK RESULT SUMMARY");

        for (const [key, value] of Object.entries(p.checks)) {

          if (typeof value !== "object") {
            console.log(`${key}:`, value);
            continue;
          }

          const pass =
            value.pass ??
            value.passed ??
            value.success ??
            value.result ??
            value.valid ??
            value.triggered;

          console.log(
            `${key} =>`,
            pass,
            JSON.stringify(value)
          );
        }

      }

      console.log("\n------------- RAW PAYLOAD ----------------");
      console.dir(p, { depth: null });

    });

    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");

    console.log("BUY :", buy);
    console.log("SELL :", sell);
    console.log("WAIT :", wait);

    console.log("\n========================================");
    console.log("BOT");
    console.log("========================================");

    const bot = await db.collection("botinstances").findOne({
      instanceId: INSTANCE_ID
    });

    console.dir(bot, { depth: 3 });

    console.log("\n========================================");
    console.log("OPEN POSITION");
    console.log("========================================");

    const position = await db.collection("positions").findOne({
      instanceId: INSTANCE_ID,
      status: "OPEN"
    });

    console.dir(position, { depth: null });

    console.log("\n========================================");
    console.log("TRADES");
    console.log("========================================");

    const trades = await db.collection("trades")
      .find({
        instanceId: INSTANCE_ID
      })
      .toArray();

    console.log("Trade Count :", trades.length);

    trades.forEach((t, i) => {
      console.log("\nTrade", i + 1);

      console.log({
        side: t.side,
        symbol: t.symbol,
        entry: t.entryPrice,
        exit: t.exitPrice,
        pnl: t.realizedPnl,
        openedAt: t.openedAt,
        closedAt: t.closedAt
      });
    });

    console.log("\n========================================");
    console.log("END");
    console.log("========================================");

    process.exit(0);

  } catch (err) {

    console.error(err);

    process.exit(1);

  }

}

main();