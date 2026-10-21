# Debian (glibc) base: @livekit/rtc-node ships no Alpine/musl binaries.
FROM node:20-bookworm-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .

# Cloud Run expects the app to listen on port 8080 by default
EXPOSE 8080

CMD [ "npm", "start" ]
