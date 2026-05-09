#!/bin/bash

echo "========================================"
echo "  SupplyChain Pro - Fresh Start"
echo "========================================"

# ─── Step 1: Kill everything ──────────────────────────────────────────────────
echo ""
echo "[1/8] Stopping all previous services..."
pkill -f "node src/app.js" 2>/dev/null
docker rm -f peer0org1_supplychain_ccaas peer0org2_supplychain_ccaas 2>/dev/null

cd ~/supply-chain/fabric-network/fabric-samples/test-network
export DOCKER_SOCK=/var/run/docker.sock
./network.sh down 2>/dev/null

cd ~/supply-chain
docker compose down 2>/dev/null
echo "    Done."

# ─── Step 2: Start Cassandra one by one ──────────────────────────────────────
echo ""
echo "[2/8] Starting Cassandra cluster (takes ~3 mins)..."
docker compose up -d cassandra1
echo "    Waiting for cassandra1 to be ready..."
until docker exec cassandra1 cqlsh -e "SELECT now() FROM system.local" > /dev/null 2>&1; do
    sleep 5
    echo -n "."
done
echo ""
docker compose up -d cassandra2
sleep 45
docker compose up -d cassandra3
sleep 45

# ─── Step 3: Start Kafka ──────────────────────────────────────────────────────
echo ""
echo "[3/8] Starting Kafka and Zookeeper..."
docker compose up -d zookeeper kafka
sleep 15
echo "    Done."

# ─── Step 4: Load Cassandra schema (Enhanced Timeout) ─────────────────────────
echo ""
echo "[4/8] Loading Cassandra schema..."
# We added --request-timeout=120 and a retry loop to prevent 'OperationTimedOut'
for i in 1 2 3; do
    if docker exec -i cassandra1 cqlsh --request-timeout=120 < ~/supply-chain/cassandra/schema.cql; then
        echo "    Schema loaded successfully."
        break
    else
        echo "    Cassandra busy, retry $i/3 in 15s..."
        sleep 15
    fi
done

# ─── Step 5: Start Fabric network ────────────────────────────────────────────
echo ""
echo "[5/8] Starting Hyperledger Fabric network..."
FABRIC_DIR=~/supply-chain/fabric-network/fabric-samples/test-network
export DOCKER_SOCK=/var/run/docker.sock
export PATH=$PATH:~/supply-chain/fabric-network/fabric-samples/bin
export FABRIC_CFG_PATH=~/supply-chain/fabric-network/fabric-samples/config

# Your critical permission fixes
chmod +x $FABRIC_DIR/network.sh
chmod +x $FABRIC_DIR/scripts/*.sh
chmod +x $FABRIC_DIR/organizations/*.sh 2>/dev/null || true
chmod +x ~/supply-chain/fabric-network/fabric-samples/bin/*
chmod +x ~/supply-chain/chaincode/supplychain/node_modules/.bin/* 2>/dev/null || true

cd $FABRIC_DIR
bash network.sh up createChannel -c supplychainchannel
bash network.sh deployCCAAS -c supplychainchannel -ccn supplychain -ccp ~/supply-chain/chaincode/supplychain -ccl javascript

# ─── Step 6: Verify CCaaS containers ─────────────────────────────────────────
echo ""
echo "[6/8] Verifying chaincode containers..."
sleep 5

# Check if deployCCAAS already started working containers
EXISTING_ID=$(docker exec peer0org1_supplychain_ccaas printenv CHAINCODE_ID 2>/dev/null)
if [ -n "$EXISTING_ID" ]; then
    echo "    Chaincode containers already running with ID: $EXISTING_ID"
else
    echo "    Containers missing CHAINCODE_ID, recreating..."
    # Query package ID using host peer CLI with admin identity
    export CORE_PEER_TLS_ENABLED=true
    export CORE_PEER_LOCALMSPID=Org1MSP
    export CORE_PEER_TLS_ROOTCERT_FILE=$HOME/supply-chain/fabric-network/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem
    export CORE_PEER_MSPCONFIGPATH=$HOME/supply-chain/fabric-network/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
    export CORE_PEER_ADDRESS=localhost:7051
    CHAINCODE_ID=$(peer lifecycle chaincode queryinstalled --output json 2>/dev/null | jq -r '.installed_chaincodes[-1].package_id // empty')
    echo "    Chaincode ID: $CHAINCODE_ID"

    if [ -z "$CHAINCODE_ID" ]; then
        echo "    ERROR: Could not retrieve chaincode package ID!"
        exit 1
    fi

    docker rm -f peer0org1_supplychain_ccaas peer0org2_supplychain_ccaas 2>/dev/null
    sleep 2

    docker run -d --name peer0org1_supplychain_ccaas --network fabric_test \
        -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 \
        -e CHAINCODE_ID="$CHAINCODE_ID" \
        -e CORE_CHAINCODE_ID_NAME="$CHAINCODE_ID" \
        supplychain_ccaas_image:latest

    docker run -d --name peer0org2_supplychain_ccaas --network fabric_test \
        -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 \
        -e CHAINCODE_ID="$CHAINCODE_ID" \
        -e CORE_CHAINCODE_ID_NAME="$CHAINCODE_ID" \
        supplychain_ccaas_image:latest
fi
sleep 10

# ─── Step 7: Configure and start API ─────────────────────────────────────────
echo ""
echo "[7/8] Configuring and starting API..."
cp ~/supply-chain/fabric-network/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/connection-org1.json ~/supply-chain/api/connection.json
sed -i "s/CASSANDRA_HOST=.*/CASSANDRA_HOST=localhost/" ~/supply-chain/api/.env
sed -i "s/KAFKA_BROKER=.*/KAFKA_BROKER=localhost:9092/" ~/supply-chain/api/.env
rm -rf ~/supply-chain/api/wallet/*

cd ~/supply-chain/api
node src/app.js > /tmp/api.log 2>&1 &
echo "    API is running on http://localhost:3000"

# ─── Step 8: IoT Setup Prompt ─────────────────────────────────────────────────
echo ""
echo "========================================"
echo "         IOT INTEGRATION SETUP"
echo "========================================"
echo "Would you like to prepare for IoT Sensor Simulation? (y/n)"
read -p "> " ENABLE_IOT

if [[ "$ENABLE_IOT" =~ ^[Yy]$ ]]; then
    echo "Ready! Copy your Token from the App Settings and run:"
    echo "  bash scripts/iot-simulator.sh <PRODUCT_ID> <TOKEN>"
fi

echo "========================================"
echo "  Startup Complete!"
echo "========================================"