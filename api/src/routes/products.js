'use strict';

const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const cassandra = require('cassandra-driver');
const QRCode    = require('qrcode');
const { getContract }  = require('../fabric/gateway');
const { execute }      = require('../cassandra/client');
const { publishEvent } = require('../kafka/producer');
const { authenticate } = require('../middleware/auth');

const STATUS_FLOW = [
  "MANUFACTURED","SHIPPED_TO_DISTRIBUTOR","RECEIVED_BY_DISTRIBUTOR",
  "SHIPPED_TO_RETAILER","RECEIVED_BY_RETAILER","SOLD_TO_CUSTOMER"
];
const ROLE_ALLOWED = {
  MANUFACTURER: ['SHIPPED_TO_DISTRIBUTOR'],
  DISTRIBUTOR:  ['RECEIVED_BY_DISTRIBUTOR', 'SHIPPED_TO_RETAILER'],
  RETAILER:     ['RECEIVED_BY_RETAILER', 'SOLD_TO_CUSTOMER']
};

// ─── Create Product ───────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'MANUFACTURER') {
      return res.status(403).json({ error: 'Only manufacturers can create products' });
    }

    const { name, category, metadata = {}, description } = req.body;
    const user = req.user;

    if (!name || !category) {
      return res.status(400).json({ error: 'name and category are required' });
    }

    const productId      = uuidv4();
    const manufacturerId = cassandra.types.Uuid.fromString(user.userId);
    const manufacturerOrg = user.org_name;

    const { gateway, contract } = await getContract();
    const result = await contract.submitTransaction(
      'createProduct',
      productId, name, category, manufacturerOrg,
      JSON.stringify(metadata)
    );
    gateway.disconnect();

    const product = JSON.parse(result.toString());

    await execute(
      `INSERT INTO products
         (product_id, name, category, description, manufacturer_id, manufacturer_org,
          current_status, current_owner_id, current_owner_org,
          fabric_tx_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()), toTimestamp(now()))`,
      [
        cassandra.types.Uuid.fromString(productId),
        name, category, description || null, manufacturerId, manufacturerOrg,
        'MANUFACTURED', manufacturerId, manufacturerOrg,
        product.fabricTxId, metadata
      ]
    );

    await execute(
      `INSERT INTO product_events
         (product_id, event_time, event_type, from_user_id, from_org,
          to_user_id, to_org, location, fabric_tx_id, notes)
       VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(productId),
        'MANUFACTURED', manufacturerId, manufacturerOrg, manufacturerId, manufacturerOrg,
        metadata.location || 'Unknown', product.fabricTxId,
        'Product created and quality checked'
      ]
    );

    await execute(
      `INSERT INTO products_by_user (user_id, product_id, added_at, role)
       VALUES (?, ?, now(), ?)`,
      [manufacturerId, cassandra.types.Uuid.fromString(productId), 'MANUFACTURER']
    );

    await publishEvent('product-events', {
      eventType: 'PRODUCT_CREATED',
      productId, name, manufacturer: manufacturerOrg,
      fabricTxId: product.fabricTxId
    });

    res.status(201).json({ success: true, product });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List All Products ────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await execute('SELECT * FROM products LIMIT 100', []);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Products by User ID (for dashboards) ─────────────────────────────
router.get('/user/:userId', authenticate, async (req, res) => {
  try {
    if (req.user.userId !== req.params.userId) return res.status(403).json({ error: 'Unauthorized: Cannot access data of another user' });
    const userId = cassandra.types.Uuid.fromString(req.params.userId);

    const result = await execute(
      'SELECT product_id, role, added_at FROM products_by_user WHERE user_id = ?',
      [userId]
    );

    const products = [];
    for (const row of result.rows) {
      const p = await execute('SELECT * FROM products WHERE product_id = ?', [row.product_id]);
      if (p.rows.length > 0) {
        products.push({ ...p.rows[0], associationRole: row.role, associatedAt: row.added_at });
      }
    }

    res.json({ success: true, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Product by ID ────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { gateway, contract } = await getContract();
    const result = await contract.evaluateTransaction('queryProduct', req.params.id);
    gateway.disconnect();
    res.json({ success: true, product: JSON.parse(result.toString()) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── Get Product History (Blockchain) ─────────────────────────────────────
router.get('/:id/history', authenticate, async (req, res) => {
  try {
    const { gateway, contract } = await getContract();
    const result = await contract.evaluateTransaction('GetProductHistory', req.params.id);
    gateway.disconnect();
    res.json({ success: true, history: JSON.parse(result.toString()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Product Events (Cassandra) ───────────────────────────────────────
router.get('/:id/events', authenticate, async (req, res) => {
  try {
    const result = await execute(
      'SELECT * FROM product_events WHERE product_id = ? LIMIT 5000',
      [cassandra.types.Uuid.fromString(req.params.id)]
    );
    res.json({ success: true, events: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transfer Product ─────────────────────────────────────────────────────
router.post('/:id/transfer', authenticate, async (req, res) => {
  try {
    const { newOwner, newStatus, location, notes, toUserId, price } = req.body;
    if (!newOwner || !newStatus || !location || !toUserId) {
      return res.status(400).json({ error: 'newOwner, newStatus, location, toUserId are required' });
    }

    let toUser;
    try {
      toUser = cassandra.types.Uuid.fromString(toUserId);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid recipient user ID format' });
    }

    const currentResult = await execute(
      'SELECT current_owner_id, current_owner_org, current_status FROM products WHERE product_id = ?',
      [cassandra.types.Uuid.fromString(req.params.id)]
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const current = currentResult.rows[0];

    if (current.current_owner_id.toString() !== req.user.userId) {
      return res.status(403).json({ error: 'You are not the current owner' });
    }

    const allowed = ROLE_ALLOWED[req.user.role] || [];
    if (!allowed.includes(newStatus)) {
      return res.status(403).json({ error: 'Your role cannot set this status' });
    }

    const currentIdx = STATUS_FLOW.indexOf(current.current_status);
    const newIdx = STATUS_FLOW.indexOf(newStatus);
    if (newIdx !== currentIdx + 1) {
      return res.status(400).json({ error: 'Invalid status transition' });
    }

    const fromUserId = current.current_owner_id;
    const fromOrg = current.current_owner_org;

    const { gateway, contract } = await getContract();
    const result = await contract.submitTransaction(
      'transferProduct',
      req.params.id, newOwner, newStatus, location, notes || ''
    );
    gateway.disconnect();

    const product = JSON.parse(result.toString());

    // Update product
    let query = `UPDATE products SET current_status = ?, current_owner_id = ?,
       current_owner_org = ?, fabric_tx_id = ?, updated_at = toTimestamp(now())
       WHERE product_id = ?`;
    let params = [newStatus, toUser, newOwner, product.fabricTxId, cassandra.types.Uuid.fromString(req.params.id)];
    
    if (price) {
      query = `UPDATE products SET current_status = ?, current_owner_id = ?,
       current_owner_org = ?, fabric_tx_id = ?, metadata = metadata + ?, updated_at = toTimestamp(now())
       WHERE product_id = ?`;
      params = [newStatus, toUser, newOwner, product.fabricTxId, { price: String(price) }, cassandra.types.Uuid.fromString(req.params.id)];
    }
    
    await execute(query, params);

    // Insert ownership history
    await execute(
      `INSERT INTO ownership_history
         (product_id, transfer_time, from_user_id, from_org, to_user_id, to_org, transfer_type, fabric_tx_id)
       VALUES (?, now(), ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(req.params.id),
        fromUserId, fromOrg, toUser, newOwner, 'TRANSFER', product.fabricTxId
      ]
    );

    // Insert product event
    await execute(
      `INSERT INTO product_events
         (product_id, event_time, event_type, from_user_id, from_org,
          to_user_id, to_org, location, fabric_tx_id, notes)
       VALUES (?, now(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(req.params.id),
        newStatus, fromUserId, fromOrg, toUser, newOwner, location, product.fabricTxId, notes || ''
      ]
    );

    // Lookup role of new owner
    let toRole = 'CUSTOMER';
    if (toUser) {
      const roleRes = await execute('SELECT role FROM users WHERE user_id = ?', [toUser]);
      if (roleRes.rows.length > 0) toRole = roleRes.rows[0].role;
    }

    await execute(
      `INSERT INTO products_by_user (user_id, product_id, added_at, role)
       VALUES (?, ?, now(), ?)`,
      [toUser, cassandra.types.Uuid.fromString(req.params.id), toRole]
    );

    await publishEvent('product-events', {
      eventType: 'PRODUCT_TRANSFERRED',
      productId: req.params.id,
      fromOrg, toOrg: newOwner, newStatus, location,
      fabricTxId: product.fabricTxId
    });

    res.json({ success: true, product });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Verify Product Authenticity ──────────────────────────────────────────
router.get('/:id/verify', async (req, res) => {
  try {
    const { gateway, contract } = await getContract();

    const bcResult = await contract.evaluateTransaction('queryProduct', req.params.id);
    const bcProduct = JSON.parse(bcResult.toString());

    const csResult = await execute(
      'SELECT * FROM products WHERE product_id = ?',
      [cassandra.types.Uuid.fromString(req.params.id)]
    );
    const csProduct = csResult.rows[0];

    const histResult = await contract.evaluateTransaction('GetProductHistory', req.params.id);
    const history = JSON.parse(histResult.toString());
    gateway.disconnect();

    const isAuthentic = csProduct && bcProduct.productId === csProduct.product_id.toString();

    res.json({
      success: true,
      isAuthentic,
      blockchain: bcProduct,
      database: csProduct,
      history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get QR Code Data ─────────────────────────────────────────────────────
router.get('/:id/qrcode', async (req, res) => {
  try {
    const { gateway, contract } = await getContract();
    const result = await contract.evaluateTransaction('queryProduct', req.params.id);
    gateway.disconnect();
    const product = JSON.parse(result.toString());
    // The URL a customer scans to verify the product
    const verifyUrl = `http://localhost:3000/api/products/${product.productId}/verify`;
    // Embed full product info into QR payload
    const qrPayload = JSON.stringify({
      productId:    product.productId,
      name:         product.name,
      manufacturer: product.manufacturer,
      status:       product.currentStatus,
      verifyUrl
    });
    // format=png  → returns base64 PNG (default, good for <img> tags)
    // format=svg  → returns raw SVG string
    // format=url  → returns just the verify URL (minimal QR)
    const format = req.query.format || 'png';
    if (format === 'svg') {
      const svg = await QRCode.toString(qrPayload, { type: 'svg' });
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    if (format === 'url') {
      const svg = await QRCode.toString(verifyUrl, { type: 'svg' });
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    // Default: base64 PNG data URL
    const dataUrl = await QRCode.toDataURL(qrPayload, {
      width: 300,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    res.json({
      success:    true,
      productId:  product.productId,
      name:       product.name,
      verifyUrl,
      qrDataUrl:  dataUrl,          // paste directly into <img src="...">
      qrPayload                     // raw string that was encoded
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Process Payment ──────────────────────────────────────────────────────
// Process Payment (SOLD_TO_CUSTOMER only)
router.post('/:id/payment', authenticate, async (req, res) => {
  try {
    const { amount, currency, paymentRef } = req.body;

    if (!amount || !paymentRef) {
      return res.status(400).json({ error: 'amount and paymentRef are required' });
    }

    const { gateway, contract } = await getContract();
    const result = await contract.submitTransaction(
      'processPayment',
      req.params.id,
      amount.toString(),
      currency || 'PKR',
      paymentRef
    );
    gateway.disconnect();

    const payment = JSON.parse(result.toString());

    // Store in Cassandra
    await execute(
      `INSERT INTO payments
         (product_id, payment_time, amount, currency, payment_ref,
          fabric_tx_id, buyer_org, status)
       VALUES (?, now(), ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(req.params.id),
        amount, currency || 'PKR', paymentRef,
        payment.txId, payment.buyer, 'COMPLETED'
      ]
    );

    // Publish to Kafka
    await publishEvent('payment-events', {
      eventType:  'PAYMENT_PROCESSED',
      productId:  req.params.id,
      amount,
      currency:   currency || 'PKR',
      paymentRef,
      fabricTxId: payment.txId,
      buyer:      payment.buyer
    });

    res.status(201).json({ success: true, payment });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get Payment status for a product
router.get('/:id/payment', authenticate, async (req, res) => {
  try {
    const { gateway, contract } = await getContract();
    const result = await contract.evaluateTransaction('getPayment', req.params.id);
    gateway.disconnect();

    const payment = JSON.parse(result.toString());

    if (!payment.exists && payment.exists !== undefined) {
      return res.json({ success: true, paid: false, payment: null });
    }

    res.json({ success: true, paid: true, payment });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
