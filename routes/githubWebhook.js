const express = require("express");
const crypto = require("crypto");
const { exec } = require("child_process");


const router = express.Router();

router.post("/api/github-webhook", express.raw({ type: "*/*" }), (req, res) => {
    try {
        console.log("Webhook hit");
        console.log("Secret exists:", !!process.env.GITHUB_WEBHOOK_SECRET);
        console.log("Body type:", Buffer.isBuffer(req.body));
        console.log("Body length:", req.body.length);

        const secret = process.env.GITHUB_WEBHOOK_SECRET;

        const signature = req.headers["x-hub-signature-256"];

        const expected =
            "sha256=" +
            crypto
                .createHmac("sha256", secret)
                .update(req.body)
                .digest("hex");

        console.log("Received:", signature);
        console.log("Expected:", expected);

        if (signature !== expected) {
            return res.status(401).send("Invalid signature");
        }

        exec(
            "cd /home/tradingn/tradingapp/nove-trade && git pull origin main && npm install",
            (err, stdout, stderr) => {

                console.log(stdout);
                console.log(stderr);

                if (err) {
                    console.error(err);
                    return res.status(500).json({
                        error: err.message,
                        stderr,
                        stdout
                    });
                }

                return res.json({
                    success: true
                });
            }
        );

    } catch (e) {
        console.error(e);
        return res.status(500).json({
            message: e.message,
            stack: e.stack
        });
    }
});

module.exports = router;