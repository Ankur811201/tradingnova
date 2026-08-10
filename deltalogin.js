const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();

const API_KEY = process.env.DELTA_API_KEY;
const API_SECRET = process.env.DELTA_API_SECRET;
const BASE_URL = "https://api.india.delta.exchange";

async function verifyCredentials() {
  try {
    const method = "GET";
    const path = "/v2/profile";
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const signature = crypto
      .createHmac("sha256", API_SECRET)
      .update(method + timestamp + path)
      .digest("hex");

    const res = await axios.get(BASE_URL + path, {
      headers: {
        "api-key": API_KEY,
        "timestamp": timestamp,
        "signature": signature,
      },
    });

    console.log("✅ Authentication Successful");
    console.log("User ID:", res.data.result?.id);
    console.log("Email:", res.data.result?.email || "Hidden");
    console.log("Response:", res.data);
  } catch (err) {
    console.log("❌ Authentication Failed");
    console.log("HTTP Status:", err.response?.status);
    console.log("Response:", err.response?.data || err.message);
  }
  console.log("API Key:", API_KEY.substring(0, 6) + "..." + API_KEY.slice(-4));
  require("dotenv").config();

console.log("API_KEY exists:", !!process.env.DELTA_API_KEY);
console.log("SECRET exists:", !!process.env.DELTA_API_SECRET);
}

verifyCredentials();