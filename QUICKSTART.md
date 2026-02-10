# Quick Start Guide

Get the N1 Personal Realm Generator running in 5 minutes.

## Prerequisites

- Node.js 18+
- A Gemini API key ([Get one here](https://makersuite.google.com/app/apikey))

## Setup

```bash
# 1. Install server dependencies
cd server
npm install

# 2. Install client dependencies
cd ../client
npm install

# 3. Configure environment
cd ../server
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```

## Running the Application

You need **two terminal windows** open:

### Terminal 1: Backend Server

```bash
cd server
npm run dev
# Server starts on http://localhost:3000
```

### Terminal 2: Frontend Client

```bash
cd client
npm run dev
# Client starts on http://localhost:5173
```

## Usage

1. Open http://localhost:5173 in your browser
2. Drag and drop a document (PDF, TXT, etc.)
3. Enter a prompt like "Analyze this document and create a visual dashboard"
4. Click "Generate Realm"
5. Watch the AI thinking process in real-time
6. Click "Enter Realm" when complete

## Example Prompts

- "Analyze this medical record and create an interactive health dashboard"
- "Summarize this financial statement with charts and key metrics"
- "Extract key findings from this research paper and visualize the methodology"
- "Create a timeline visualization of events mentioned in this document"

## Troubleshooting

**Server won't start?**
- Check that port 3000 isn't already in use
- Verify your `.env` file has `GEMINI_API_KEY` set

**Upload fails?**
- File might be too large (default limit: 300MB)
- Check server logs for specific errors

**AI generation fails?**
- Verify your API key is valid
- Check that you have quota remaining on your Gemini API key
- Ensure the model names in `.env` are correct

## Next Steps

- Read the full [README.md](README.md) for detailed documentation and architecture details
