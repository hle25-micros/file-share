# Stage 1: Build Angular
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npx ng build --configuration production

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy built Angular app
COPY --from=build /app/dist/file-share ./dist/file-share

# Copy production server & config
COPY server.prod.js ./
COPY config ./config

# Create uploads directory
RUN mkdir -p uploads

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.prod.js"]
