'use strict';

const express   = require('express');
const router    = express.Router();
const cassandra = require('cassandra-driver');
const { execute }      = require('../cassandra/client');
const { publishEvent } = require('../kafka/producer');
const { authenticate } = require('../middleware/auth');

// Sensor thresholds — alerts if exceeded
const THRESHOLDS = {
  temperature: { min: -10, max: 40 },  // Celsius
  humidity:    { min: 20,  max: 80 }   // Percent
};

// POST /api/iot/reading — submit a sensor reading for a product
router.post('/reading', authenticate, async (req, res) => {
  try {
    const {
      product_id, temperature, humidity,
      location, device_id, notes
    } = req.body;

    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    // Check product exists
    const productResult = await execute(
      'SELECT product_id, name, current_status, current_owner_org FROM products WHERE product_id = ?',
      [cassandra.types.Uuid.fromString(product_id)]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];

    // Check for threshold violations
    const alerts = [];
    if (temperature !== undefined && temperature !== null) {
      if (temperature > THRESHOLDS.temperature.max) {
        alerts.push(`TEMPERATURE_HIGH: ${temperature}°C exceeds max ${THRESHOLDS.temperature.max}°C`);
      }
      if (temperature < THRESHOLDS.temperature.min) {
        alerts.push(`TEMPERATURE_LOW: ${temperature}°C below min ${THRESHOLDS.temperature.min}°C`);
      }
    }
    if (humidity !== undefined && humidity !== null) {
      if (humidity > THRESHOLDS.humidity.max) {
        alerts.push(`HUMIDITY_HIGH: ${humidity}% exceeds max ${THRESHOLDS.humidity.max}%`);
      }
      if (humidity < THRESHOLDS.humidity.min) {
        alerts.push(`HUMIDITY_LOW: ${humidity}% below min ${THRESHOLDS.humidity.min}%`);
      }
    }

    const eventNotes = [
      notes || 'IoT sensor reading',
      device_id ? `Device: ${device_id}` : null,
      alerts.length > 0 ? `⚠️ ALERTS: ${alerts.join(', ')}` : null
    ].filter(Boolean).join(' | ');

    // Save to product_events with sensor data
    await execute(
      `INSERT INTO product_events
         (product_id, event_time, event_type, from_user_id, from_org,
          to_user_id, to_org, location, fabric_tx_id,
          temperature, humidity, notes)
       VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(product_id),
        'IOT_READING',
        cassandra.types.Uuid.fromString(req.user.userId),
        req.user.org_name,
        cassandra.types.Uuid.fromString(req.user.userId),
        req.user.org_name,
        location || product.current_owner_org,
        'iot-sensor',
        temperature !== undefined ? temperature : null,
        humidity    !== undefined ? humidity    : null,
        eventNotes
      ]
    );

    // Publish to Kafka
    await publishEvent('iot-events', {
      eventType:  'IOT_READING',
      product_id,
      productName: product.name,
      temperature,
      humidity,
      location,
      device_id,
      alerts,
      org: req.user.org_name
    });

    res.status(201).json({
      success: true,
      reading: { product_id, temperature, humidity, location, device_id },
      alerts,
      hasAlerts: alerts.length > 0
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/iot/:productId/readings — get all sensor readings for a product
router.get('/:productId/readings', authenticate, async (req, res) => {
  try {
    const result = await execute(
      `SELECT event_time, temperature, humidity, location, notes
       FROM product_events
       WHERE product_id = ? AND event_type = 'IOT_READING'
       ALLOW FILTERING`,
      [cassandra.types.Uuid.fromString(req.params.productId)]
    );

    const readings = result.rows.map(row => ({
      timestamp:   uuidToTimestamp(row.event_time),
      temperature: row.temperature,
      humidity:    row.humidity,
      location:    row.location,
      notes:       row.notes
    }));

    res.json({ success: true, readings });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/iot/:productId/latest — get latest sensor reading
router.get('/:productId/latest', authenticate, async (req, res) => {
  try {
    const result = await execute(
      `SELECT event_time, temperature, humidity, location, notes
       FROM product_events
       WHERE product_id = ? AND event_type = 'IOT_READING'
       LIMIT 1
       ALLOW FILTERING`,
      [cassandra.types.Uuid.fromString(req.params.productId)]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, reading: null });
    }

    const latest = result.rows[0];
    res.json({
      success: true,
      reading: {
        timestamp:   uuidToTimestamp(latest.event_time),
        temperature: latest.temperature,
        humidity:    latest.humidity,
        location:    latest.location,
        notes:       latest.notes
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/iot/:productId/alerts — get all alert events
router.get('/:productId/alerts', authenticate, async (req, res) => {
  try {
    const result = await execute(
      `SELECT event_time, temperature, humidity, location, notes
       FROM product_events
       WHERE product_id = ?
       LIMIT 100`,
      [cassandra.types.Uuid.fromString(req.params.productId)]
    );

    const alerts = result.rows
      .filter(r => r.notes && r.notes.includes('⚠️'))
      .map(row => ({
        timestamp:   uuidToTimestamp(row.event_time),
        temperature: row.temperature,
        humidity:    row.humidity,
        location:    row.location,
        alert:       row.notes
      }));

    res.json({ success: true, alerts, count: alerts.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: convert TIMEUUID to ISO timestamp
function uuidToTimestamp(timeuuid) {
  if (!timeuuid) return null;
  try {
    const uuidStr = timeuuid.toString();
    const parts = uuidStr.split('-');
    const timeHigh = parseInt(parts[2].substring(1), 16);
    const timeMid  = parseInt(parts[1], 16);
    const timeLow  = parseInt(parts[0], 16);
    const t = ((timeHigh * Math.pow(2, 48)) + (timeMid * Math.pow(2, 32)) + timeLow - 122192928000000000) / 10000;
    return new Date(t).toISOString();
  } catch(e) { return null; }
}

module.exports = router;
