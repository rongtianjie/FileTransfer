FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/filetransfer .

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 filetransfer \
    && useradd --uid 10001 --gid 10001 --no-create-home filetransfer \
    && install -d -m 0700 -o filetransfer -g filetransfer /var/lib/filetransfer
WORKDIR /app
COPY --from=build /out/filetransfer /usr/local/bin/filetransfer
COPY --from=web /src/web/dist /app/web/dist
ENV FILETRANSFER_HTTP_ADDR=:8443 \
    FILETRANSFER_WEB_DIR=/app/web/dist \
    FILETRANSFER_DATA_DIR=/var/lib/filetransfer
EXPOSE 8443/tcp 3478/udp 5349/tcp
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/filetransfer"]
