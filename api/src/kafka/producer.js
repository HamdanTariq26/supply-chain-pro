'use strict';

const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'supply-chain-api',
  brokers: [process.env.KAFKA_BROKER || 'localhost:9092']
});

const producer = kafka.producer();
let connected = false;

async function connect() {
  if (connected) return;
  await producer.connect();
  connected = true;
  console.log('Kafka producer connected');
}

async function publishEvent(topic, message) {
  await connect();
  await producer.send({
    topic,
    messages: [
      {
        key: message.productId || 'general',
        value: JSON.stringify({ ...message, timestamp: new Date().toISOString() })
      }
    ]
  });
}

module.exports = { publishEvent };
