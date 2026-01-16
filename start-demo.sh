#!/bin/bash

# N1 Healthcare - Quick Demo Launcher
# This starts the server, client, and creates a public tunnel

echo "🏥 Starting N1 Healthcare Demo..."
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "❌ cloudflared not found. Install with: brew install cloudflared"
    exit 1
fi

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Start server in background
echo "🚀 Starting server..."
cd "$SCRIPT_DIR/server"
npm run dev &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Start client in background
echo "🎨 Starting client..."
cd "$SCRIPT_DIR/client"
npm run dev &
CLIENT_PID=$!

# Wait for client to start
sleep 3

# Start tunnel
echo ""
echo "🌐 Creating public tunnel..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Share the URL below with your colleagues!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down..."
    kill $SERVER_PID 2>/dev/null
    kill $CLIENT_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Run tunnel (this blocks)
cloudflared tunnel --url http://localhost:5173

# Cleanup when tunnel exits
cleanup
