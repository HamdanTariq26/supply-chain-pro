#!/bin/bash

# IoT Sensor Simulator — sends random readings every 5 seconds
# Usage: bash iot-simulator.sh <product_id> <token>

PRODUCT_ID=${1:-"9a32d6fc-7f3f-4e77-a574-d992d64bdf87"}
TOKEN=${2:-""}
API="http://localhost:3000/api/iot/reading"
DEVICE_ID="SENSOR-001"
COUNT=0

if [ -z "$TOKEN" ]; then
  echo "Usage: bash iot-simulator.sh <product_id> <token>"
  exit 1
fi

echo "Starting IoT simulator for product: $PRODUCT_ID"
echo "Device: $DEVICE_ID"
echo "Press Ctrl+C to stop"
echo ""

while true; do
  COUNT=$((COUNT + 1))

  # Generate random readings
  # Normal range: temp 18-28, humidity 40-60
  # Occasionally spike: temp 42-45, humidity 85-90
  SPIKE=$((RANDOM % 10))

  if [ $SPIKE -eq 0 ]; then
    TEMP=$(python3 -c "import random; print(round(random.uniform(42, 45), 1))")
    HUMID=$(python3 -c "import random; print(round(random.uniform(85, 90), 1))")
    echo "⚠️  Reading #$COUNT — SPIKE! Temp: ${TEMP}°C, Humidity: ${HUMID}%"
  else
    TEMP=$(python3 -c "import random; print(round(random.uniform(18, 28), 1))")
    HUMID=$(python3 -c "import random; print(round(random.uniform(40, 60), 1))")
    echo "✓  Reading #$COUNT — Temp: ${TEMP}°C, Humidity: ${HUMID}%"
  fi

  RESPONSE=$(curl -s -X POST "$API" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{
      \"product_id\": \"$PRODUCT_ID\",
      \"temperature\": $TEMP,
      \"humidity\": $HUMID,
      \"location\": \"Warehouse A\",
      \"device_id\": \"$DEVICE_ID\"
    }")

  ALERTS=$(echo $RESPONSE | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('alerts',[]))" 2>/dev/null)
  if [ "$ALERTS" != "[]" ]; then
    echo "   🚨 ALERT: $ALERTS"
  fi

  sleep 5
done
