'use strict';
const express = require('express');
const router = express.Router();
const { execute } = require('../cassandra/client');
const { getContract } = require('../fabric/gateway');
const { authenticate } = require('../middleware/auth');

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
]);

router.get('/full', authenticate, async (req, res) => {
  const stats = { 
    cassandra: { avgMs: 0, minMs: 0, maxMs: 0 }, 
    fabric: { avgMs: 0, minMs: 0, maxMs: 0 } 
  };
  try {
    const cl = [];
    for (let i = 0; i < 3; i++) {
      const s = Date.now(); await execute('SELECT now() FROM system.local', []); cl.push(Date.now() - s);
    }
    stats.cassandra = { avgMs: Math.round(cl.reduce((a,b)=>a+b)/3), minMs: Math.min(...cl), maxMs: Math.max(...cl) };
    
    try {
      const { gateway, contract } = await withTimeout(getContract(), 10000);
      const fs = Date.now();
      try { 
        // We don't care if the product exists, we just want to measure the round-trip speed!
        await contract.evaluateTransaction('queryProduct', 'benchmark-ping'); 
      } catch (e) {
        // Ignore "not found" errors as they still give us a valid latency measurement
      }
      const lat = Date.now() - fs;
      stats.fabric = { avgMs: lat, minMs: lat, maxMs: lat };
      gateway.disconnect();
    } catch (e) { 
      stats.fabric.avgMs = null;
      stats.fabric.error = "Fabric connection error: " + e.message; 
    }
    res.json({ success: true, results: stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tps', authenticate, async (req, res) => {
  const count = req.body.count || 5;
  const start = Date.now();
  const results = [];
  try {
    for (let i = 0; i < count; i++) {
      const txStart = Date.now();
      try {
        await execute('SELECT now() FROM system.local', []);
        results.push({ tx: i + 1, status: 'success', latency: Date.now() - txStart });
      } catch (e) {
        results.push({ tx: i + 1, status: 'error', latency: Date.now() - txStart });
      }
    }
    const totalTime = Date.now() - start;
    const lats = results.map(r => r.latency);
    res.json({ 
      success: true, 
      config: { transactions: count }, 
      results: { 
        tps: (results.filter(r=>r.status==='success').length / (totalTime / 1000)).toFixed(2), 
        totalTimeMs: totalTime, 
        successful: results.filter(r=>r.status==='success').length, 
        latency: { avgMs: Math.round(lats.reduce((a,b)=>a+b)/count), maxMs: Math.max(...lats), minMs: Math.min(...lats) } 
      }, 
      breakdown: results 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
module.exports = router;
