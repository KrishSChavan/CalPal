const express = require("express");
const OpenAI = require("openai");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


// File upload setup
const upload = multer({ dest: "uploads/" });


// OpenAI config
const token = process.env.OPENAI_TOKEN;
const endpoint = "https://models.github.ai/inference/";
const modelName = "openai/gpt-4o-mini";

const openai = new OpenAI({ baseURL: endpoint, apiKey: token });



function getImageDataUrl(imageFile, imageFormat) {
  try {
    const imageBuffer = fs.readFileSync(imageFile);
    const imageBase64 = imageBuffer.toString("base64");
    return `data:image/${imageFormat};base64,${imageBase64}`;
  } catch (error) {
    console.error("Image read error:", error);
    return null;
  }
}




// Route to handle image upload and process it
app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  const filePath = req.file.path;
  const extension = path.extname(req.file.originalname).slice(1); // "jpg", "png", etc.

  const dataUrl = getImageDataUrl(filePath, extension);

  const notes = req.body.notes;

  if (!dataUrl) {
    return res.status(400).json({ error: "Invalid image data." });
  }

  if (!notes) {
    return res.status(400).json({ error: "Invalid notes data." });
  }

  try {
    const response = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that breifly describes images and mainly states how many total estimated calories are in the food in the image.",
        },
        {
          role: "system",
          content:
            "You use the information provided about the food in the image to better understand what is in the image and how many calories it may contain.",
        },
        {
          role: "system",
          content:
            "When giving a response structure it with 'Description' and 'Estimated Calories' and only give a number of calories for the estimated calories.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image and how many calories is it?" },
            { type: "text", text: "These are some of the notes on the food in the picture, " + notes },
            { type: "image_url", image_url: { url: dataUrl, details: "low" } },
          ],
        },
      ],
      model: modelName,
    });

    const reply = response.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error("OpenAI error:", error);
    res.status(500).json({ error: "Failed to analyze image." });
  } finally {
    fs.unlinkSync(filePath); // clean up uploaded image
  }
});



// Route to ask the AI
app.post("/api/ask", async (req, res) => {
  const userMessage = req.body.message;

  if (!userMessage) {
    return res.status(400).json({ error: "Missing 'message' in request body." });
  }

  try {
    const response = await openai.chat.completions.create({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: userMessage }
      ],
      model: modelName,
      temperature: 1.0,
      max_tokens: 1000,
      top_p: 1.0
    });

    const aiReply = response.choices[0].message.content;
    res.json({ reply: aiReply });
  } catch (error) {
    console.error("AI error:", error);
    res.status(500).json({ error: "Failed to get response from OpenAI." });
  }
});

// Test route
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from the Express server!" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});