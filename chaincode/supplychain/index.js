'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

class SupplyChainContract extends Contract {

  async initLedger(ctx) {
    const products = [{
      productId: 'PROD001', name: 'Laptop Model X1', category: 'Electronics',
      currentStatus: 'MANUFACTURED', currentOwner: 'AcmeCorp', manufacturer: 'AcmeCorp',
      metadata: { weight: '2.1kg', color: 'silver' },
      timestamp: new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString(),
      history: []
    }];
    for (const p of products) {
      await ctx.stub.putState(p.productId, Buffer.from(JSON.stringify(p)));
    }
  }

  async createProduct(ctx, productId, name, category, manufacturer, metadataJson) {
    const existing = await ctx.stub.getState(productId);
    if (existing && existing.length > 0) throw new Error(`Product ${productId} exists`);

    const metadata = JSON.parse(metadataJson);
    const txId = ctx.stub.getTxID();
    const timestamp = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();

    const product = {
      productId, name, category,
      currentStatus: 'MANUFACTURED', currentOwner: manufacturer, manufacturer,
      metadata, fabricTxId: txId, createdAt: timestamp, updatedAt: timestamp,
      history: [{
        status: 'MANUFACTURED', owner: manufacturer,
        location: metadata.location || 'Unknown', timestamp, txId,
        notes: 'Product created and quality checked'
      }]
    };
    await ctx.stub.putState(productId, Buffer.from(JSON.stringify(product)));
    ctx.stub.setEvent('ProductCreated', Buffer.from(JSON.stringify({ productId, name, manufacturer, txId, timestamp })));
    return JSON.stringify(product);
  }

  async transferProduct(ctx, productId, newOwner, newStatus, location, notes) {
    const bytes = await ctx.stub.getState(productId);
    if (!bytes || bytes.length === 0) throw new Error(`Product ${productId} not found`);

    const product = JSON.parse(bytes.toString());
    const valid = {
      'MANUFACTURED': ['SHIPPED_TO_DISTRIBUTOR'],
      'SHIPPED_TO_DISTRIBUTOR': ['RECEIVED_BY_DISTRIBUTOR'],
      'RECEIVED_BY_DISTRIBUTOR': ['SHIPPED_TO_RETAILER'],
      'SHIPPED_TO_RETAILER': ['RECEIVED_BY_RETAILER'],
      'RECEIVED_BY_RETAILER': ['SOLD_TO_CUSTOMER'],
      'SOLD_TO_CUSTOMER': []
    };
    const allowed = valid[product.currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid: ${product.currentStatus} -> ${newStatus}`);
    }

    const txId = ctx.stub.getTxID();
    const timestamp = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();

    // Capture previous values BEFORE overwriting
    const previousOwner = product.currentOwner;
    const previousStatus = product.currentStatus;

    product.history.push({ status: newStatus, owner: newOwner, location, timestamp, txId, notes: notes || '' });
    product.currentOwner = newOwner;
    product.currentStatus = newStatus;
    product.fabricTxId = txId;
    product.updatedAt = timestamp;

    await ctx.stub.putState(productId, Buffer.from(JSON.stringify(product)));
    ctx.stub.setEvent('ProductTransferred', Buffer.from(JSON.stringify({
      productId, previousOwner, newOwner, previousStatus, newStatus, location, txId, timestamp
    })));


    return JSON.stringify(product);
  }

  async queryProduct(ctx, productId) {
    const bytes = await ctx.stub.getState(productId);
    if (!bytes || bytes.length === 0) throw new Error(`Product ${productId} not found`);
    return bytes.toString();
  }

  async GetProductHistory(ctx, productId) {
    const bytes = await ctx.stub.getState(productId);
    if (!bytes || bytes.length === 0) throw new Error(`Product ${productId} not found`);
    const product = JSON.parse(bytes.toString());
    return JSON.stringify(product.history || []);
  }

  async queryAllProducts(ctx) {
    const iter = await ctx.stub.getStateByRange('', '');
    const products = [];
    let result = await iter.next();
    while (!result.done) {
      if (result.value && result.value.value) {
        try { products.push(JSON.parse(result.value.value.toString())); } catch(e) {}
      }
      result = await iter.next();
    }
    await iter.close();
    return JSON.stringify(products);
  }

  async verifyProduct(ctx, productId, expectedHash) {
    const bytes = await ctx.stub.getState(productId);
    if (!bytes || bytes.length === 0) throw new Error(`Product ${productId} not found`);
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    return JSON.stringify({ productId, verified: actualHash === expectedHash, actualHash, expectedHash });
  }

   async processPayment(ctx, productId, amount, currency, paymentRef) {
    const bytes = await ctx.stub.getState(productId);
    if (!bytes || bytes.length === 0) throw new Error(`Product ${productId} not found`);

    const product = JSON.parse(bytes.toString());

    // Payment only valid at point of sale
    if (product.currentStatus !== 'SOLD_TO_CUSTOMER') {
      throw new Error(`Payment only allowed when status is SOLD_TO_CUSTOMER. Current: ${product.currentStatus}`);
    }

    // Check not already paid
    const paymentKey = `PAYMENT_${productId}`;
    const existing = await ctx.stub.getState(paymentKey);
    if (existing && existing.length > 0) {
      throw new Error(`Payment already processed for product ${productId}`);
    }

    const txId = ctx.stub.getTxID();
    const timestamp = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();

    const payment = {
      productId,
      amount: parseFloat(amount),
      currency: currency || 'PKR',
      paymentRef,
      txId,
      timestamp,
      status: 'COMPLETED',
      buyer: product.currentOwner
    };

    // Store payment record on ledger (immutable)
    await ctx.stub.putState(paymentKey, Buffer.from(JSON.stringify(payment)));

    // Attach payment info to product record
    product.payment = payment;
    product.updatedAt = timestamp;
    await ctx.stub.putState(productId, Buffer.from(JSON.stringify(product)));

    ctx.stub.setEvent('PaymentProcessed', Buffer.from(JSON.stringify(payment)));
    return JSON.stringify(payment);
  }

  async getPayment(ctx, productId) {
    const paymentKey = `PAYMENT_${productId}`;
    const bytes = await ctx.stub.getState(paymentKey);
    if (!bytes || bytes.length === 0) {
      return JSON.stringify({ exists: false, productId });
    }
    return bytes.toString();
  }


}

module.exports = SupplyChainContract;
