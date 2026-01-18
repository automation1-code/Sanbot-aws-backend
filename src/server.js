// ================= IMPORTS =================
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import FormData from "form-data";
import path from "path";
import { fileURLToPath } from "url";

import { SYSTEM_PROMPT } from "./prompt.js";
import { sessionConfig } from "./config.js";

// ================= FIX __dirname (ESM) =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= LOAD ENV =================
dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

// ================= APP SETUP =================
const app = express();
const PORT = process.env.PORT || 3051;

// ================= MIDDLEWARE =================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

// Accept raw SDP or plain text
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

// ================= ROUTES =================

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", ai: "realtime-ready" });
});

// Create realtime AI session
app.post("/session", async (req, res) => {
  try {
    const sdpOffer = req.body;

    if (!sdpOffer) {
      return res.status(400).send("Missing SDP offer");
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).send("OPENAI_API_KEY not set");
    }

    console.log("📡 Session request received");

    const fullSessionConfig = {
      ...sessionConfig,
      instructions: SYSTEM_PROMPT,
    };

    const formData = new FormData();
    formData.append("sdp", sdpOffer);
    formData.append("session", JSON.stringify(fullSessionConfig));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(
      "https://api.openai.com/v1/realtime/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ OpenAI error:", errorText);
      return res.status(response.status).send(errorText);
    }

    const sdpAnswer = await response.text();
    console.log("✅ Session created successfully");
    res.send(sdpAnswer);

  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).send("OpenAI request timed out");
    }
    console.error("❌ Server error:", err.message);
    res.status(500).send(err.message);
  }
});

// ================= START SERVER =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Sanbot AI backend running on port ${PORT}`);
});
