const express = require("express");
const crypto = require("node:crypto");

const router = express.Router();

router.post("/api/github-webhook", express.raw({ type: "application/json" }), (req, res) => {
    const signature = req.headers["x-hub-signature-256"];

    const expected =
        "sha256=" +
        crypto
            .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET)
            .update(req.body)
            .digest("hex");

    if (signature !== expected) {
        return res.status(401).send("Invalid signature");
    }

    res.send("Signature OK");
});

module.exports = router;