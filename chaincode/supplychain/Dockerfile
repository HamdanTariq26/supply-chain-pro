FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 9999

# Use shell form so environment variables are expanded
CMD sh -c "npm start -- --chaincode-address 0.0.0.0:9999 --chaincode-id $CHAINCODE_ID"
