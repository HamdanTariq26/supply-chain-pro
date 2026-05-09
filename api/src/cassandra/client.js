'use strict';

const cassandra = require('cassandra-driver');

let client = null;

async function getClient() {
  if (client) return client;

  client = new cassandra.Client({
    contactPoints: [process.env.CASSANDRA_HOST || 'localhost'],
    localDataCenter: 'dc1',
    keyspace: process.env.CASSANDRA_KEYSPACE || 'supply_chain',
    protocolOptions: { port: parseInt(process.env.CASSANDRA_PORT) || 9042 }
  });

  await client.connect();
  console.log('Cassandra connected');
  return client;
}

async function execute(query, params = []) {
  const db = await getClient();
  return db.execute(query, params, { prepare: true });
}

module.exports = { getClient, execute };
