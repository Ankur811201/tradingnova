const express = require("express");
const crypto = require("node:crypto");
const { exec } = require("child_process");

const router = express.Router();

router.post(
  "/api/github-webhook",
  express.raw({ type: "*/*" }),
  (req, res) => {
    const received = req.headers["x-hub-signature-256"];

    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET)
        .update(req.body)
        .digest("hex");

    if (
      !crypto.timingSafeEqual(
        Buffer.from(received),
        Buffer.from(expected)
      )
    ) {
      return res.status(401).send("Invalid signature");
    }

    // Respond immediately to GitHub
    res.status(200).send("Deploy started");

    // Deploy in background
    exec(
      "cd /home/tradingn/tradingapp/nove-trade && git pull origin main && touch tmp/restart.txt",
      (err, stdout, stderr) => {
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        if (err) console.error(err);
      }
    );
  }
);

module.exports = router;