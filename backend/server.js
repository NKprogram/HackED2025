const dotenv = require("dotenv");
const OpenAI = require("openai");
const express = require("express");
const cors = require("cors");
const path = require('path');
const multer = require("multer");
const fs = require("fs");
const FormData = require("form-data");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();
const app = express();
const port = 8000;

app.use(express.json());

app.use(cors({
    origin: "*", // Allow all origins (for development only)
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

// Ensure CORS headers are included in responses
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // Allow all origins (for development only)
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// Handle CORS preflight requests
app.options("*", (req, res) => {
    res.header("Access-Control-Allow-Origin", "*"); // Allow all origins (for development only)
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.sendStatus(200);
});

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => cb(null, "audio.wav"),
});
const upload = multer({ storage });

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_SERVICE_ACCOUNT_SECRET_KEY,
    organization: process.env.OPENAI_ORG_ID,
    project: process.env.OPENAI_PROJECT_ID,
});

app.get("/api/v1/question", async (req, res) => {
    let interviewType = req.query.type || "general"; // Default to "general"

    try {
        const { data, error } = await supabase
            .from("interview_questions")
            .select("*")
            .eq("category", interviewType)

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(404).json({ question: "No questions available." });
        }

        const randomIndex = Math.floor(Math.random() * data.length);
        res.json({ question: data[randomIndex].question });
    } catch (error) {
        console.error("❌ Supabase Error:", error);
        res.status(500).json({ error: "Error fetching interview question." });
    }
});

async function getAIResponse(answer, interview_qn, interview_type, context) {
    try {
        let system_prompt = `You are a professional interviewer conducting a ${interview_type} interview. 
        The user has been asked an interview question and has provided their response.
        You must evaluate the response while keeping the previous conversation in mind.
        - Assess the response based on **clarity, structure, relevance, and professionalism**.
        - Identify **strengths** in the response.
        - Provide **constructive feedback** for improvement.
        - **Do not ask another question** or continue the conversation beyond feedback.
        - Keep your feedback professional, clear, and concise.
        - **Do not use any HTML formatting, bullet points, or markdown. Respond in a single concise paragraph.** 
        
        Interview Type: ${interview_type} 
        Interview Question: "${interview_qn}"
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: system_prompt },
                // ...context, // Include previous messages
                { role: "user", content: answer }
            ],
            temperature: 1.0,
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("OpenAI Error:", error);
        return "Error processing response";
    }
}

async function getAIQuestions(role) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `You are a professional interviewer generating behavioral interview
                    questions for a candidate applying for the following role: 
                    Role: "${role}"
                    - Your job is to provide exactly **five** interview questions.
                    - These should be **behavioral** or **situational** questions, relevant to the role.
                    - Your output should strictly follow the JSON structure below:
                    
                    {
                      "questions": [
                        "q1",
                        "q2",
                        "q3",
                        "q4",
                        "q5"
                      ]
                    }
                    
                    - DO NOT provide explanations, instructions, or any additional text. Only return a valid JSON object.`
                }
            ],
            temperature: 1.0,
        });

        const jsonResponse = JSON.parse(response.choices[0].message.content.trim());
        return jsonResponse.questions;
    } catch (error) {
        console.error("OpenAI Error:", error);
        return ["Error processing response"];
    }
}

async function testDBConnection() {
    try {
        const { data, error } = await supabase.from("interview_questions").select("id").limit(1);
        if (error) throw error;
        console.log("✅ Supabase connection successful and accessible!");
    } catch (error) {
        console.error("❌ Failed to connect to Supabase:", error.message);
    }
}

app.post("/api/v1/email-feedback", async (req, res) => {
    try {
        const email_address = req.body.email;
        const questions = req.body.interviewQuestions;
        const responses = req.body.interviewResponses;
        const feedbacks = req.body.interviewFeedback;
        // console.log('Email:', email_address);
        // console.log('Questions:', questions);
        // console.log('Responses:', responses);
        // console.log('Feedbacks:', feedbacks);

        if (!email_address || !feedbacks || !questions || !responses) {
            return res.status(400).json({ error: "Missing fields." });
        }

        console.log('Creating transporter...');
        const transporter = nodemailer.createTransport({
            service: "Gmail",
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: {
                user: process.env.GMAIL_ADDRESS,
                pass: process.env.GMAIL_PASSWORD,
            },
        });

        console.log('Transporter created. Preparing email...');
        let emailBody = "<h2>Interview Prep Feedback</h2>";
        for (let i = 0; i < questions.length; i++) {
            emailBody += `<h3>Question: ${questions[i]}</h3>`;
            emailBody += `<p>Response: ${responses[i]}</p>`;
            emailBody += `<h3>Feedback: ${feedbacks[i]}</h3>`; 
        }
        emailBody += "<p>Thank you for using Flux AI!</p>";
        emailBody += "<p>Best Regards, <br> Flux AI Team</p>";

        console.log('Sending email...');
        const info = await transporter.sendMail({
            from: '"Flux AI" <' + process.env.GMAIL_ADDRESS + '>', 
            to: email_address,  
            subject: "Interview Prep Feedback", 
            html: emailBody,
        });

        console.log("✅ Email sent: %s", info.messageId);
        res.json({ success: true, message: "Email sent successfully!" }); 
    } catch (error) {
        console.error("❌ Email sending error:", error);
        res.status(500).json({ error: "Failed to send email.", details: error.message });
    }
});

// API to handle audio upload & transcription
app.post("/api/v1/transcribe", upload.single("audio"), async (req, res) => {
    try {
        const filePath = req.body.filePath;
        if (!filePath) {
            return res.status(400).json({ error: "File path is required" });
        }

        // Get the public URL of the file (ensure the bucket is publicly accessible)
        const { data } = await supabase.storage.from("user_audio_recordings").getPublicUrl(filePath);
        const fileUrl = data.publicUrl;

        if (!fileUrl) {
            return res.status(404).json({ error: "File not found in Supabase" });
        }

        // Fetch the file as a stream
        const response = await axios.get(fileUrl, { responseType: "stream" });

        // Use FormData to send the file as a stream
        const formData = new FormData();
        formData.append("file", response.data, {
            filename: "audio.wav",
            contentType: "audio/wav",
        });
        formData.append("model", "whisper-1");

        // Send the file to OpenAI Whisper
        const transcriptionResponse = await axios.post("https://api.openai.com/v1/audio/transcriptions", formData, {
            headers: {
                ...formData.getHeaders(),
                Authorization: `Bearer ${process.env.OPENAI_SERVICE_ACCOUNT_SECRET_KEY}`,
            },
        });
        // delete the file after transcription

        res.json({ text: transcriptionResponse.data.text });
        const { status, error } = await supabase
            .storage
            .from('user_audio_recordings')
            .remove([filePath])
    } catch (error) {
        console.error("Transcription error:", error);
        res.status(500).json({ error: "Transcription failed" });
    }
});

app.post("/api/v1/generate-questions", async (req, res) => {
    let role = req.body.role;

    if (!role) {
        return res.status(400).json({ error: "Missing 'role' in request body." });
    }

    const response = await getAIQuestions(role);
    console.log(response);
    res.json({ response });
});

app.post("/api/v1/answer", async (req, res) => {
    console.log(req.body);
    let answer = req.body.answer;
    let interview_qn = req.body.interview_qn;
    let interview_type = req.body.interview_type || "general";
    // let context = req.body.context || [];

    if (!answer) {
        return res.status(400).json({ error: "Missing 'answer' in request body." });
    }

    const response = await getAIResponse(answer, interview_qn, interview_type);

    res.json({ feedback: response });
});

app.get("/", (req, res) => res.send("Access the app at: https://hacked2025.onrender.com/"));


app.get('/testing', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/my-react-app/public', 'testing.html'));
});

app.listen(port, () => {
    console.log(`✅ Backend server LIVE on port ${port}`);
    testDBConnection();
});