'use strict';

const { Gateway, Wallets } = require('fabric-network');
const fs   = require('fs');
const path = require('path');

const CONNECTION_PROFILE = path.resolve(__dirname, '../../connection.json');
const WALLET_PATH        = path.resolve(__dirname, '../../wallet');
const TEST_NETWORK       = '/home/hamdan/supply-chain/fabric-network/fabric-samples/test-network';

async function buildWallet() {
  return await Wallets.newFileSystemWallet(WALLET_PATH);
}

async function enrollAdmin() {
  const wallet = await buildWallet();
  if (await wallet.get('admin')) {
    console.log('Admin already in wallet');
    return;
  }

  const certPath = path.join(
    TEST_NETWORK,
    'organizations/peerOrganizations/org1.example.com',
    'users/Admin@org1.example.com/msp/signcerts/Admin@org1.example.com-cert.pem'
  );
  const keyDir = path.join(
    TEST_NETWORK,
    'organizations/peerOrganizations/org1.example.com',
    'users/Admin@org1.example.com/msp/keystore'
  );

  const certificate = fs.readFileSync(certPath, 'utf8');
  const keyFiles    = fs.readdirSync(keyDir);
  const privateKey  = fs.readFileSync(path.join(keyDir, keyFiles[0]), 'utf8');

  const identity = {
    credentials: { certificate, privateKey },
    mspId: process.env.FABRIC_MSP_ID || 'Org1MSP',
    type: 'X.509'
  };

  await wallet.put('admin', identity);
  console.log('Admin loaded into wallet from crypto files');
}

async function getContract(userId = 'admin') {
  await enrollAdmin();

  const wallet  = await buildWallet();
  const profile = JSON.parse(fs.readFileSync(CONNECTION_PROFILE, 'utf8'));

  const gateway = new Gateway();
  await gateway.connect(profile, {
    wallet,
    identity: userId,
    discovery: { enabled: true, asLocalhost: true }
  });

  const network  = await gateway.getNetwork(process.env.FABRIC_CHANNEL);
  const contract = network.getContract(process.env.FABRIC_CHAINCODE);

  return { gateway, contract };
}

module.exports = { enrollAdmin, getContract };
