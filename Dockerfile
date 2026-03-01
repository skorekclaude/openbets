FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json .
RUN bun install --production

COPY src/ ./src/
COPY web/ ./web/

EXPOSE 3100
CMD ["bun", "run", "src/index.ts"]
