#!/bin/bash
set -e

echo "=========================================="
echo "  REVERTING & FIXING CHAINCODE"
echo "=========================================="

# ─── 1. Revert chaincode back to original ─────────────────────────────────
cat > ~/supply-chain/chaincode/supplychain/index.js << 'CODE_EOF'
'use strict';

const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

class SupplyChainContract extends Contract {

  async initLedger(ctx) {
    const products = [
      {
        productId:      'PROD001',
        name:           'Laptop Model X1',
        category:       'Electronics',
        currentStatus:  'MANUFACTURED',
        currentOwner:   'AcmeCorp',
        manufacturer:   'AcmeCorp',
        metadata:       { weight: '2.1kg', color: 'silver' },
        timestamp:      new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString(),
        history:        []
      }
    ];

    for (const product of products) {
      await ctx.stub.putState(
        product.productId,
        Buffer.from(JSON.stringify(product))
      );
    }
    console.log('Ledger initialized with sample products');
  }

  async createProduct(ctx, productId, name, category, manufacturer, metadataJson) {
    const existing = await ctx.stub.getState(productId);
    if (existing && existing.length > 0) {
      throw new Error(`Product ${productId} already exists`);
    }

    const metadata = JSON.parse(metadataJson);
    const txId = ctx.stub.getTxID();
    const timestamp = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();

    const product = {
      productId,
      name,
      category,
      currentStatus:  'MANUFACTURED',
      currentOwner:   manufacturer,
      manufacturer,
      metadata,
      fabricTxId:     txId,
      createdAt:      timestamp,
      updatedAt:      timestamp,
      history: [
        {
          status:      'MANUFACTURED',
          owner:       manufacturer,
          location:    metadata.location || 'Unknown',
          timestamp,
          txId,
          notes:       'Product created and quality checked'
        }
      ]
    };

    await ctx.stub.putState(productId, Buffer.from(JSON.stringify(product)));

    ctx.stub.setEvent('ProductCreated', Buffer.from(JSON.stringify({
      productId, name, manufacturer, txId, timestamp
    })));

    return JSON.stringify(product);
  }

  async transferProduct(ctx, productId, newOwner, newStatus, location, notes) {
    const productBytes = await ctx.stub.getState(productId);
    if (!productBytes || productBytes.length === 0) {
      throw new Error(`Product ${productId} does not exist`);
    }

    const product = JSON.parse(productBytes.toString());

    const validTransitions = {
      'MANUFACTURED': ['SHIPPED_TO_DISTRIBUTOR'],
      'SHIPPED_TO_DISTRIBUTOR': ['RECEIVED_BY_DISTRIBUTOR'],
      'RECEIVED_BY_DISTRIBUTOR': ['SHIPPED_TO_RETAILER'],
      'SHIPPED_TO_RETAILER': ['RECEIVED_BY_RETAILER'],
      'RECEIVED_BY_RETAILER': ['SOLD_TO_CUSTOMER'],
      'SOLD_TO_CUSTOMER': []
    };

    const allowed = validTransitions[product.currentStatus];
    if (!allowed) {
      throw new Error(`Unknown current status: ${product.currentStatus}`);
    }
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${product.currentStatus} → ${newStatus}. ` +
        `Allowed: ${allowed.join(', ')}`
      );
    }

    const txId = ctx.stub.getTxID();
    const timestamp = new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString();

    product.history.push({
      status:    newStatus,
      owner:     newOwner,
      location,
      timestamp,
      txId,
      notes:     notes || ''
    });

    const previousOwner   = product.currentOwner;
    const previousStatus  = product.currentStatus;
    product.currentOwner  = newOwner;
    product.currentStatus = newStatus;
    product.fabricTxId    = txId;
    product.updatedAt     = timestamp;

    await ctx.stub.putState(productId, Buffer.from(JSON.stringify(product)));

    ctx.stub.setEvent('ProductTransferred', Buffer.from(JSON.stringify({
      productId, previousOwner, newOwner,
      previousStatus, newStatus, location, txId, timestamp
    })));

    return JSON.stringify(product);
  }

  async queryProduct(ctx, productId) {
    const productBytes = await ctx.stub.getState(productId);
    if (!productBytes || productBytes.length === 0) {
      throw new Error(`Product ${productId} does not exist`);
    }
    return productBytes.toString();
  }

  async GetProductHistory(ctx, productId) {
    const iterator = await ctx.stub.getHistoryForKey(productId);
    const history  = [];

    while (true) {
      const result = await iterator.next();
      if (result.done) break;

      const ts = result.value.timestamp;
      const record = {
        txId:      result.value.txId,
        timestamp: ts ? new Date(Number(ts.seconds.toString()) * 1000).toISOString() : null,
        isDelete:  result.value.isDelete,
        value:     result.value.value
          ? JSON.parse(result.value.value.toString())
          : null
      };
      history.push(record);
    }

    await iterator.close();
    return JSON.stringify(history);
  }

  async queryAllProducts(ctx) {
    const iterator = await ctx.stub.getStateByRange('', '');
    const products = [];

    while (true) {
      const result = await iterator.next();
      if (result.done) break;

      if (result.value && result.value.value) {
        try {
          products.push(JSON.parse(result.value.value.toString()));
        } catch (e) {
          // skip malformed records
        }
      }
    }

    await iterator.close();
    return JSON.stringify(products);
  }

  async verifyProduct(ctx, productId, expectedHash) {
    const productBytes = await ctx.stub.getState(productId);
    if (!productBytes || productBytes.length === 0) {
      throw new Error(`Product ${productId} does not exist`);
    }

    const actualHash = crypto
      .createHash('sha256')
      .update(productBytes)
      .digest('hex');

    const verified = actualHash === expectedHash;

    return JSON.stringify({
      productId,
      verified,
      actualHash,
      expectedHash,
      timestamp: new Date(ctx.stub.getTxTimestamp().seconds.low * 1000).toISOString()
    });
  }
}

module.exports = SupplyChainContract;
CODE_EOF

echo "✅ Chaincode reverted to original"

# ─── 2. Kill old containers ───────────────────────────────────────────────
echo ""
echo "[2/4] Stopping old chaincode containers..."
docker rm -f peer0org1_supplychain_ccaas peer0org2_supplychain_ccaas 2>/dev/null || true
echo "✅ Old containers removed"

# ─── 3. Find the CORRECT committed chaincode ID ──────────────────────────
echo ""
echo "[3/4] Finding committed chaincode ID..."
cd ~/supply-chain/fabric-network/fabric-samples/test-network
export PATH=$PATH:~/supply-chain/fabric-network/fabric-samples/bin
export FABRIC_CFG_PATH=~/supply-chain/fabric-network/fabric-samples/config

# Get the committed chaincode info
COMMITTED=$(peer lifecycle chaincode querycommitted -C supplychainchannel -n supplychain 2>/dev/null || true)

echo "Committed chaincode info:"
echo "$COMMITTED"

# Extract the chaincode ID from committed output
# Format: Version: 1.0, Sequence: 1, Endorsement Plugin: escc, Validation Plugin: vscc, Approvals: [Org1MSP: true, Org2MSP: true]
# We need the package ID that matches this committed chaincode

# Query installed and find the one that matches
INSTALLED=$(peer lifecycle chaincode queryinstalled 2>/dev/null || true)
echo ""
echo "Installed packages:"
echo "$INSTALLED"

# Get the first (or only) ccaas package ID
CHAINCODE_ID=$(echo "$INSTALLED" | grep "Package ID:" | grep "supplychain" | head -1 | awk '{print $3}' | tr -d ',')

if [ -z "$CHAINCODE_ID" ]; then
    CHAINCODE_ID=$(echo "$INSTALLED" | grep "Package ID:" | head -1 | awk '{print $3}' | tr -d ',')
fi

if [ -z "$CHAINCODE_ID" ]; then
    echo "❌ ERROR: Could not find chaincode ID!"
    echo "You may need to redeploy using: ./network.sh deployCCAAS -ccn supplychain -ccp ~/supply-chain/chaincode/supplychain -ccl javascript"
    exit 1
fi

echo ""
echo "✅ Using Chaincode ID: $CHAINCODE_ID"

# ─── 4. Start fresh containers ───────────────────────────────────────────
echo ""
echo "[4/4] Starting fresh chaincode containers..."

docker run -d \
  --name peer0org1_supplychain_ccaas \
  --network fabric_test \
  -v ~/supply-chain/chaincode/supplychain:/app \
  -w /app node:18-alpine \
  sh -c "npm install 2>/dev/null; node_modules/.bin/fabric-chaincode-node server --chaincode-address=0.0.0.0:9999 --chaincode-id=$CHAINCODE_ID"

docker run -d \
  --name peer0org2_supplychain_ccaas \
  --network fabric_test \
  -v ~/supply-chain/chaincode/supplychain:/app \
  -w /app node:18-alpine \
  sh -c "npm install 2>/dev/null; node_modules/.bin/fabric-chaincode-node server --chaincode-address=0.0.0.0:9999 --chaincode-id=$CHAINCODE_ID"

sleep 4

echo ""
echo "Container status:"
docker ps | grep ccaas || echo "❌ No containers running!"

echo ""
echo "=========================================="
echo "  DONE"
echo "=========================================="
echo ""
echo "Now test with:"
echo "  curl -s http://localhost:3000/api/products/YOUR_PRODUCT_ID/history \\"
echo "    -H \"Authorization: Bearer YOUR_TOKEN\""
