#!/bin/bash
cd "$(dirname "$0")"
lsof -ti:8088 | xargs kill -9 2>/dev/null
python3 server.py &
SERVER_PID=$!
trap "kill -9 $SERVER_PID 2>/dev/null; exit" INT TERM EXIT
while ! nc -z 127.0.0.1 8088 2>/dev/null; do
  sleep 0.05
done
open -a "Safari" "http://127.0.0.1:8088" 2>/dev/null || open "http://127.0.0.1:8088"
wait $SERVER_PID
