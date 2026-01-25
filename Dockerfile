FROM node:18-bullseye

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bin ./bin
COPY docs ./docs
COPY dukascopy-api.js package.json README.md .env.example jforex-websocket-api-1.0.0.jar ./

RUN npm install -g .

ENV NODE_ENV=production
ENV SERVER_ADDRESS=0.0.0.0
ENV SERVER_PORT=8080

EXPOSE 8080

ENTRYPOINT ["dukascopy-api"]
CMD ["server", "run"]
