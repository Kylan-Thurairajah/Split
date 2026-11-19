FROM node:22-alpine AS web
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.24-alpine AS api
WORKDIR /app
COPY backend/go.* ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /split .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=api /split /usr/local/bin/split
COPY --from=web /app/dist /srv/split
ENV STATIC_DIR=/srv/split PORT=8080
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["split"]
