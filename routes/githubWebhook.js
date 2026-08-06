const express = require("express");
const crypto = require("crypto");
const { exec } = require("child_process");
require("dotenv").config();

const router = express.Router();


router.post("/api/github-webhook", express.raw({ type: "*/*" }), (req, res) => {
    try {
        console.log("Webhook received");

        // your code

    } catch (e) {
        console.error(e);
        return res.status(500).json({
            message: e.message,
            stack: e.stack
        });
    }
});

module.exports = router;