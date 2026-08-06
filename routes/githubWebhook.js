const express = require("express");
const crypto = require("crypto");
const { exec } = require("child_process");
require("dotenv").config();

const router = express.Router();


router.post("/api/github-webhook", express.raw({ type: "*/*" }), (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    const signature = req.headers["x-hub-signature-256"];
    const expected =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(req.body).digest("hex");

    if (signature !== expected) {
        return res.status(401).send("Invalid signature");
    }

    exec(
        "cd /home/tradingn/tradingapp/nove-trade && git pull origin main && npm install",
        (err, stdout, stderr) => {
            console.log(stdout);
            console.log(stderr);
        }
    );

    res.send("Deployment started");
});

module.exports = router;