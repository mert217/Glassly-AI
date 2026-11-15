FROM node:22-alpine
WORKDIR /app
COPY index.js ./
COPY config.json ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.js"]
