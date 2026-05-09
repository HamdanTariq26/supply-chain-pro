# 🛡️ SupplyChain Pro: Blockchain & IoT Traceability Platform

![GitHub stars](https://img.shields.io/badge/Blockchain-Hyperledger%20Fabric-2F3134?style=for-the-badge&logo=hyperledger)
![Cassandra](https://img.shields.io/badge/Database-Apache%20Cassandra-1287B1?style=for-the-badge&logo=apache-cassandra)
![Kafka](https://img.shields.io/badge/Messaging-Apache%20Kafka-231F20?style=for-the-badge&logo=apache-kafka)

**SupplyChain Pro** is a high-performance, enterprise-grade supply chain management system. It leverages **Hyperledger Fabric** for decentralized trust and **Apache Cassandra** combined with **Apache Kafka** for real-time, high-throughput IoT sensor tracking.

---

## 🚀 Key Features

*   **Immutable Ledger:** Every product transfer is recorded on Hyperledger Fabric, ensuring non-repudiation.
*   **Real-time IoT Tracking:** Integrated sensor simulation for temperature and humidity tracking via Kafka event streams.
*   **High-Resolution Audit:** Chronological history logs powered by Cassandra TIMEUUIDs for nanosecond precision.
*   **Role-Based Access Control:** Secure JWT authentication for Manufacturers, Distributors, Retailers, and Customers.
*   **QR Code Verification:** Instant product authenticity checks via mobile-ready QR generation.
*   **Stateless Architecture:** Fully decoupled frontend, API, and blockchain layers for horizontal scalability.

---

## 🛠️ Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Blockchain** | Hyperledger Fabric (CCaaS Mode) |
| **Database** | Apache Cassandra 4.1 |
| **Messaging** | Apache Kafka & Zookeeper |
| **Backend** | Node.js (Express) |
| **Frontend** | React 18, Tailwind CSS, Lucide Icons |
| **Security** | JWT, Bcrypt, TLS, HMAC-SHA256 |
| **Infrastructure** | Docker & Docker Compose |

---

## 📂 Project Structure

*   `/api`: Node.js Express backend and Fabric Gateway logic.
*   `/frontend`: React SPA (Single Page Application) for the dashboard.
*   `/chaincode`: Smart contracts written in JavaScript for the Fabric network.
*   `/cassandra`: Schema definitions and migration scripts for NoSQL storage.
*   `/scripts`: Automation scripts for network startup and IoT simulation.

---

## ⚙️ Installation & Setup

### Prerequisites
*   Ubuntu 20.04+ (or WSL2)
*   Docker & Docker Compose
*   Node.js v18+

### 1. Download Full Release

Download the packaged release from:

https://github.com/HamdanTariq26/supply-chain-pro/releases/tag/v0.1.0

### 2. Start the Infrastructure
Use the master script to start Fabric, Cassandra, Kafka, and the API:
```bash
bash scripts/start.sh
```

### 3. Setup the API Environment
Create a `.env` file in the `/api` directory:
```env
PORT=3001
CASSANDRA_NODES=localhost
KAFKA_BROKERS=localhost:9092
JWT_SECRET=your_secret_key_here
```

### 4. Run the IoT Simulator
To simulate real-time sensor data flowing into the blockchain:
```bash
bash scripts/iot-simulator.sh
```

---

## 📊 System Architecture
The system uses a **Polyglot Persistence** model. Critical ownership data is stored on the **Blockchain**, while heavy time-series IoT data is stored in **Cassandra** for high-speed querying. **Kafka** acts as the high-speed bridge between the API and the data layers.

---

## 👥 The Team

*   **Hamdan Tariq** — *Team Lead & Lead Architect*
    *   System Design, Backend Engineering, Blockchain Integration.
*   **Mubashara Anees** — *Project Collaborator*
    *   Quality Assurance, Business Logic, System Testing.

---

## 📜 License
This project is for academic/enterprise demonstration purposes. See the [LICENSE](LICENSE) file for details.
