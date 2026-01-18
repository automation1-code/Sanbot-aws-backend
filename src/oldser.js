// import express from "express";
// import dotenv from "dotenv";
// import { SYSTEM_PROMPT } from "./prompt.js";
// import { sessionConfig } from "./config.js";

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 3000;

// // Accept raw SDP
// app.use(express.text({ type: ["application/sdp", "text/plain"] }));

// app.post("/session", async (req, res) => {
//   try {
//     const sdpOffer = req.body;

//     if (!sdpOffer) {
//       console.error("❌ No SDP offer received");
//       return res.status(400).send("Missing SDP offer");
//     }

//     console.log("📞 Session request received");
//     console.log("🔑 Using API key:", process.env.OPENAI_API_KEY ? "✅ Set" : "❌ NOT SET");

//     const fullSessionConfig = {
//       ...sessionConfig,
//       instructions: SYSTEM_PROMPT,
//     };

//     const formData = new FormData();
//     formData.set("sdp", sdpOffer);
//     formData.set("session", JSON.stringify(fullSessionConfig));

//     console.log("📤 Sending request to OpenAI...");

//     // Add timeout and retry logic
//     const controller = new AbortController();
//     const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

//     try {
//       const response = await fetch(
//         "https://api.openai.com/v1/realtime/calls",
//         {
//           method: "POST",
//           headers: {
//             Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
//           },
//           body: formData,
//           signal: controller.signal
//         }
//       );

//       clearTimeout(timeout);

//       console.log("📥 OpenAI response status:", response.status);

//       if (!response.ok) {
//         const errorText = await response.text();
        
//         // Check if it's a 504 timeout
//         if (response.status === 504) {
//           console.error("⏱️ OpenAI API timeout (504) - OpenAI servers are busy");
//           console.log("💡 Suggestion: Try again in a few seconds");
//           return res.status(503).send("OpenAI API is temporarily busy. Please try again.");
//         }

//         console.error("❌ OpenAI error:", errorText);
//         return res.status(response.status).send(`OpenAI API error: ${errorText}`);
//       }

//       const sdpAnswer = await response.text();
//       console.log("✅ Session created successfully");
//       res.send(sdpAnswer);

//     } catch (fetchError) {
//       clearTimeout(timeout);
      
//       if (fetchError.name === 'AbortError') {
//         console.error("⏱️ Request timeout after 30 seconds");
//         return res.status(504).send("Request to OpenAI timed out");
//       }
      
//       throw fetchError;
//     }

//   } catch (err) {
//     console.error("❌ Server error:", err.message);
//     res.status(500).send(`Server error: ${err.message}`);
//   }
// });

// app.get("/health", (_, res) => {
//   res.json({ status: "ok", ai: "realtime-ready" });
// });

// app.listen(PORT, () => {
//   console.log(`🚀 Sanbot AI backend running on port ${PORT}`);
// });
