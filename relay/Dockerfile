FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js media.js ./
COPY tools ./tools
ENV PORT=8765 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 8765
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8765/lain/health || exit 1
CMD ["node", "server.js"]
