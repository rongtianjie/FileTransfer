# 直达

免登录的一对一文件传输。用随机或自定义的 4 位数字房间码配对，在桌面版 Chrome 或 Edge 上收发单个最大 2 GiB 的文件。网页先尝试 WebRTC 直连，连接失败后由发起方决定是否启用加密中继。

## 本机启动

服务端支持 Linux 和 macOS。需要 Go 1.26 工具链，以及 Node.js 22.12 或更新的 LTS 版本。

```sh
npm --prefix web ci
npm --prefix web run build
go run .
```

在两个桌面浏览器窗口中打开 `http://127.0.0.1:8080`。一个窗口创建房间，另一个输入码申请加入。在创建方同意后，两端均可选择文件发送。接收方选择保存位置后才开始传输。文件保存失败或传输中断时重新发送。其他浏览器标记为实验支持，需具有 WebRTC 和文件流式保存能力。

同时启动本机 STUN 和 TURN 供联调：

```sh
FILETRANSFER_TURN_IP=127.0.0.1 go run .
```

默认只监听回环地址。跨设备访问请使用下面的 HTTPS 部署配置。开发中可另开一个终端运行 `npm --prefix web run dev`，Vite 把 WebSocket 转发至本机的 Go 服务。

## 用 Docker Compose 部署到单台服务器

准备 Docker Engine、Docker Compose v2、域名和浏览器信任的证书。启用中继时还需要稳定的公网 IPv4。将域名的 A 记录指向服务器。Compose 在容器内构建前端和 Go 程序，由 Go 直接提供 HTTPS 和 WSS。

在 Linux 部署主机的仓库根目录执行以下命令，将证书路径换成实际的完整证书链和私钥路径。容器以 UID/GID `10001:10001` 运行。这里通过组权限让容器读取私钥和管理员密码，Compose 以只读方式挂载文件。

```sh
mkdir -p .deployment
sudo install -m 0644 /path/to/fullchain.pem .deployment/fullchain.pem
sudo install -o root -g 10001 -m 0440 /path/to/privkey.pem .deployment/privkey.pem
openssl rand -hex 32 | sudo sh -c 'umask 077; cat > "$1"' sh .deployment/admin-password
sudo chown root:10001 .deployment/admin-password
sudo chmod 0440 .deployment/admin-password
```

用 `sudo cat .deployment/admin-password` 读取生成的密码并保存到密码管理器。将下列配置保存为仓库根目录的 `.env`，并替换域名、公网 IPv4 和管理员账号。`.env` 只记录密码文件路径。

```dotenv
FILETRANSFER_ORIGIN=https://transfer.example.com
FILETRANSFER_TLS_CERT_PATH=./.deployment/fullchain.pem
FILETRANSFER_TLS_KEY_PATH=./.deployment/privkey.pem
FILETRANSFER_TURN_IP=203.0.113.10
FILETRANSFER_TURN_HOST=transfer.example.com
FILETRANSFER_ADMIN_USERNAME=admin
FILETRANSFER_ADMIN_PASSWORD_PATH=./.deployment/admin-password
```

```sh
docker compose config --quiet
docker compose up --build --wait
```

在防火墙开放 TCP 443。启用中继时同时开放并转发 UDP 3478，公网与容器使用相同的 TURN 端口。启动后访问站点的 `/healthz`，再到 `/admin/` 使用配置的账号和密码登录。中继密钥和额度可在后台设置，保存的设置优先于环境变量中的初始值。

### 启用 TURN TLS

TURN TLS 是额外的 TCP 入口，启用后仍需保留 UDP 3478。将以下内容保存为 `compose.override.yaml`，确保 `FILETRANSFER_TURN_HOST` 是站点证书覆盖的域名，在防火墙开放 TCP 5349，再运行 `docker compose up -d`。Go 共用站点证书。

```yaml
services:
  filetransfer:
    environment:
      FILETRANSFER_TURN_TLS_ADDR: 0.0.0.0:5349
    ports:
      - "5349:5349/tcp"
```

删除该覆盖文件并再次运行 `docker compose up -d` 可关闭 TURN TLS。将 `.env` 中的 `FILETRANSFER_TURN_IP` 设为空并重建容器可关闭整个 TURN 服务。关闭后可在防火墙关闭 TURN 端口，基础 Compose 文件仍声明 UDP 3478 的端口映射。重新填入公网 IPv4 并重建容器即可启用。

### 密码、证书与数据卷

更换密码时，在部署主机替换 `.deployment/admin-password` 并设置 `root:10001` 所有权和 `0440` 权限。更新证书时同样替换挂载的证书链和私钥并保留读取权限。运行 `docker compose up -d --force-recreate filetransfer` 重新挂载文件并使更改生效，管理员需要重新登录。

`filetransfer_data` 命名卷保存中继设置、计量账本和历史。保持单实例运行。备份时停止服务，用镜像内的 `tar` 归档整个卷，再启动服务。管理员密码文件和 TLS 文件由部署主机单独保管。

```sh
docker compose stop filetransfer
(umask 077 && docker compose run --rm --no-deps -T --entrypoint tar filetransfer \
  -C /var/lib/filetransfer -czf - . > .deployment/filetransfer-data.tar.gz)
docker compose start filetransfer
```

恢复时，停止原服务，使用一个尚未使用的 Compose 项目名创建空数据卷。还原成功后启动该项目，后续操作继续使用同一个 `-p` 参数。原有数据卷保留，避免运行 `docker compose down -v` 删除持久数据。

```sh
docker compose stop filetransfer
docker compose -p filetransfer-restored build filetransfer
docker compose -p filetransfer-restored run --rm --no-deps -T --entrypoint tar filetransfer \
  -C /var/lib/filetransfer -xzf - < .deployment/filetransfer-data.tar.gz
docker compose -p filetransfer-restored up -d --wait
```

## 直接部署 Go 服务

构建前端和 Go 可执行文件，将 `web/dist` 与二进制复制到同一应用目录。服务器需要支持稳定的公网 IPv4 和 HTTPS 域名证书。域名的 IPv4 记录应指向这台服务器。下面的域名、IP 地址和证书路径都需替换，并通过服务管理器的环境变量注入一个高强度 `FILETRANSFER_RELAY_KEY`。

```sh
npm --prefix web ci
npm --prefix web run build
go build -o bin/filetransfer .

FILETRANSFER_HTTP_ADDR=:443 \
FILETRANSFER_ORIGIN=https://transfer.example.com \
FILETRANSFER_TLS_CERT=/path/to/fullchain.pem \
FILETRANSFER_TLS_KEY=/path/to/privkey.pem \
FILETRANSFER_TURN_IP=203.0.113.10 \
FILETRANSFER_TURN_HOST=transfer.example.com \
FILETRANSFER_TURN_UDP=0.0.0.0:3478 \
FILETRANSFER_TURN_TLS_ADDR=0.0.0.0:5349 \
FILETRANSFER_DATA_DIR=/var/lib/filetransfer \
./bin/filetransfer
```

防火墙开放 TCP 443 和 UDP 3478。启用 TURN over TLS 时另开放 TCP 5349。中继分配地址在服务进程内路由，只允许同一配对的两端通信，虚拟端口 49152–65535 无需开放。上面的配置由 Go 直接终止 HTTPS，配对限流使用真实的连接来源地址。未配对的空闲连接在 5 分钟后回收，失败后未重试的会话在 10 分钟后回收，已配对会话最长保留 24 小时。启动后可通过 `/healthz` 检查 HTTP 服务。

| 环境变量 | 行为与默认值 |
| --- | --- |
| `FILETRANSFER_TURN_IP` | TURN 公告 IPv4。留空禁用中继。 |
| `FILETRANSFER_TURN_HOST` | 浏览器连接 TURN 的域名或 IPv4，默认为公告 IPv4。使用 TLS 时填证书覆盖的域名。 |
| `FILETRANSFER_TURN_UDP` | UDP 监听地址，默认 `127.0.0.1:3478`。 |
| `FILETRANSFER_TURN_TLS_ADDR` | 可选 TURN TLS 监听地址，共用站点证书。 |
| `FILETRANSFER_STUN_URLS` | 可选逗号分隔 STUN 列表。默认用自建 TURN 的 STUN 端口。 |
| `FILETRANSFER_RELAY_KEY` | 后端校验的中继密钥。留空只允许免密中继。 |
| `FILETRANSFER_PUBLIC_DAILY_BYTES` | UTC 每日公共转发额度，默认 20,000,000,000 字节。 |
| `FILETRANSFER_RESERVED_DAILY_BYTES` | 密钥用户的额外每日额度，默认 20,000,000,000 字节。 |
| `FILETRANSFER_DATA_DIR` | 保存中继设置、计量账本和历史的可写持久化目录，默认 `data`。部署时保留该目录。 |
| `FILETRANSFER_WEB_DIR` | 已构建前端目录，默认 `web/dist`。 |
| `FILETRANSFER_ADMIN_USERNAME` | 单管理员账号。账号和密码均未配置时关闭后台，只配一项会导致启动失败。 |
| `FILETRANSFER_ADMIN_PASSWORD_FILE` | 服务进程读取的密码文件路径。Compose 通过 secret 设置此变量。 |
| `FILETRANSFER_ADMIN_PASSWORD` | 密码文件的替代方式。使用其中一种密码来源。 |

登录 `/admin/` 后，流量趋势默认显示最近 30 天，历史按 UTC 日保留最近 90 天。已计量且无流量的日期显示为 0，缺少计量记录的日期留空。重启后，每个额度池可能多计不足 256 KiB 的未用预留。替换或清空中继密钥后，已授权的 TURN 分配可继续使用到凭据过期，新连接和凭据续发需要重新授权。

普通中继每次配对共享 100,000,000 字节额度，包含双方的 WebRTC 协议开销和重传。接近上限的文件可能提前耗尽额度。密钥用户先用公共额度，再用保留额度。服务以 256 KiB 为单位持久化预留流量额度。中继凭据在连接切换和离开房间时即时撤销，每轮最长有效 45 分钟。

## 验证

```sh
go test -race ./...
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
```

Go 集成测试会使用本机 UDP 回环端口验证真实 TURN 客户端、无效凭据、跨配对隔离和共享额度。上线验收时，在两台设备上用 Chrome 和 Edge 分别验证同网、异网直连和手动中继。对 2 GiB 发送源和接收文件比对 SHA-256，观察发送和接收进程的内存，并验证未确认中继时没有转发流量。
