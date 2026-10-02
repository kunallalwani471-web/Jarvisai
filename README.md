# JARVIS — Groq Fixed Version

This project keeps the existing Jarvis UI, browser speech recognition,
speech synthesis, TV display, YouTube tool, website tool, time tool,
and Big/Small prediction engine.

## Deploy on Vercel

1. Upload this repository to GitHub or import the folder into Vercel.
2. In Vercel Project Settings → Environment Variables, add:
   - Name: `GROQ_API_KEY`
   - Value: your Groq API key
3. Redeploy.

Do NOT put the Groq API key inside `index.html`.

## API

The frontend calls:

`POST /api/groq`

The server calls Groq's OpenAI-compatible Chat Completions API and
translates tool calls back into the response format expected by the
existing Jarvis frontend.

## Model

The server uses:

`openai/gpt-oss-20b`

This model supports function/tool calling.

## Local development

A Vercel deployment is the intended runtime because `/api/groq.js`
is a Vercel serverless function.
