#!/bin/bash

echo "=========================================="
echo "  COMPLETE FIX"
echo "=========================================="

# ─── 1. Revert chaincode to original ──────────────────────────────────────
cat > ~/supply-chain/chaincode/supplychain/index.js << 'CODE_EOF'
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

    product.history.push({ status: newStatus, owner: newOwner, location, timestamp, txId, notes: notes || '' });
    product.currentOwner = newOwner;
    product.currentStatus = newStatus;
    product.fabricTxId = txId;
    product.updatedAt = timestamp;

    await ctx.stub.putState(productId, Buffer.from(JSON.stringify(product)));
    ctx.stub.setEvent('ProductTransferred', Buffer.from(JSON.stringify({
      productId, previousOwner: product.currentOwner, newOwner, previousStatus: product.currentStatus, newStatus, location, txId, timestamp
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
}

module.exports = SupplyChainContract;
CODE_EOF

echo "✅ Chaincode reverted + fixed GetProductHistory"

# ─── 2. Kill and restart chaincode containers ─────────────────────────────
echo ""
echo "[2/3] Restarting chaincode containers..."
docker rm -f peer0org1_supplychain_ccaas peer0org2_supplychain_ccaas 2>/dev/null || true

cd ~/supply-chain/fabric-network/fabric-samples/test-network

# Source the environment properly
export PATH=${PWD}/../bin:$PATH
export FABRIC_CFG_PATH=$PWD/../config/

# Set Org1 environment
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE=${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
export CORE_PEER_MSPCONFIGPATH=${PWD}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
export CORE_PEER_ADDRESS=localhost:7051

# Get the package ID
PKG_ID=$(peer lifecycle chaincode queryinstalled 2>/dev/null | grep "Package ID:" | head -1 | awk '{print $3}' | tr -d ',')

if [ -z "$PKG_ID" ]; then
    echo "❌ No installed chaincode found. Need to redeploy."
    echo "Run: cd ~/supply-chain/fabric-network/fabric-samples/test-network"
    echo "     ./network.sh deployCCAAS -ccn supplychain -ccp ~/supply-chain/chaincode/supplychain -ccl javascript"
    exit 1
fi

echo "Package ID: $PKG_ID"

docker run -d \
  --name peer0org1_supplychain_ccaas \
  --network fabric_test \
  -v ~/supply-chain/chaincode/supplychain:/app \
  -w /app node:18-alpine \
  sh -c "npm install 2>/dev/null; node_modules/.bin/fabric-chaincode-node server --chaincode-address=0.0.0.0:9999 --chaincode-id=$PKG_ID"

docker run -d \
  --name peer0org2_supplychain_ccaas \
  --network fabric_test \
  -v ~/supply-chain/chaincode/supplychain:/app \
  -w /app node:18-alpine \
  sh -c "npm install 2>/dev/null; node_modules/.bin/fabric-chaincode-node server --chaincode-address=0.0.0.0:9999 --chaincode-id=$PKG_ID"

sleep 5
docker ps | grep ccaas

# ─── 3. Fix frontend to use /events as fallback ──────────────────────────
echo ""
echo "[3/3] Patching frontend to use /events for timeline..."

FRONTEND_FILE=$(find ~/supply-chain -name "*.html" -type f | head -1)

if [ -z "$FRONTEND_FILE" ]; then
    echo "⚠️  No HTML file found. Skipping frontend patch."
    echo "   You need to manually edit your frontend:"
    echo "   In ProductDetailModal, replace the timeline useEffect to call api.getEvents()"
else
    echo "Found frontend: $FRONTEND_FILE"
    echo "⚠️  Please manually edit the timeline useEffect in your HTML file"
    echo "   to use api.getEvents() instead of api.getHistory()"
fi

echo ""
echo "=========================================="
echo "  RESTART API SERVER NOW:"
echo "  pkill -f \"node src/app.js\""
echo "  cd ~/supply-chain/api && node src/app.js"
echo "=========================================="
