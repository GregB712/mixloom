# Frontend image: runs the Vite dev server so the /api proxy and SSE streaming
# work against the backend service (VITE_API_PROXY points at it).
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "--port", "5173"]
