# Deployment Notes

This file records the current server layout and the commands used to update this custom new-api build.

Do not put database passwords, Redis passwords, `SESSION_SECRET`, or `CRYPTO_SECRET` in this file.

## Server

- Host label: `shameless-sun`
- Custom source directory: `/opt/new-api-custom`
- 1Panel compose directory: `/opt/1panel/apps/new-api/new-api`
- Backup directory: `/opt/new-api-backup`

## Runtime

- App compose service: `new-api`
- App container: `1Panel-new-api-YEmY`
- App image: `new-api-custom:ai-creation`
- PostgreSQL container: `1Panel-postgresql-joeA`
- Redis container: `1Panel-redis-FJDe`
- Docker network: `1panel-network`
- Public port mapping: `0.0.0.0:3000 -> 3000`

The active 1Panel files are:

```bash
/opt/1panel/apps/new-api/new-api/docker-compose.yml
/opt/1panel/apps/new-api/new-api/.env
```

The source checkout at `/opt/new-api-custom` also contains a `docker-compose.yml`, but that file is only the upstream example stack. Do not use it for this 1Panel deployment unless intentionally creating a separate deployment.

## Current Compose Expectations

In `/opt/1panel/apps/new-api/new-api/docker-compose.yml`:

```yaml
image: new-api-custom:ai-creation
ports:
  - ${HOST_IP}:${PANEL_APP_PORT_HTTP}:3000
```

In `/opt/1panel/apps/new-api/new-api/.env`:

```env
HOST_IP='0.0.0.0'
PANEL_APP_PORT_HTTP=3000
```

## Database Backup

Run before risky upgrades:

```bash
PG=1Panel-postgresql-joeA
BACKUP_DIR=/opt/new-api-backup/$(date +%F_%H%M%S)

mkdir -p "$BACKUP_DIR"

docker exec "$PG" pg_dump -U postgres -d newapi -Fc > "$BACKUP_DIR/newapi.dump"
docker exec "$PG" pg_dump -U postgres -d newapi > "$BACKUP_DIR/newapi.sql"

ls -lh "$BACKUP_DIR"
docker exec -i "$PG" pg_restore -l < "$BACKUP_DIR/newapi.dump" | head
```

## Update And Deploy

Pull the latest code and build the image while the old container is still running:

```bash
cd /opt/new-api-custom
git pull --ff-only
docker build -t new-api-custom:ai-creation .
```

Restart only the app service. Do not recreate PostgreSQL or Redis:

```bash
cd /opt/1panel/apps/new-api/new-api
docker compose up -d --no-deps --force-recreate new-api
```

## Verify

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" | grep new-api
curl http://127.0.0.1:3000/api/status
curl http://YOUR_PUBLIC_IP:3000/api/status
```

Expected port output includes:

```text
0.0.0.0:3000->3000/tcp
```

If public access fails, check the server firewall and cloud security group:

```bash
ufw allow 3000/tcp
```

## Rollback

If the new container fails immediately, restore the previous compose backup from the 1Panel compose directory:

```bash
cd /opt/1panel/apps/new-api/new-api
ls -lh docker-compose.yml.bak.* .env.bak.* 2>/dev/null

cp docker-compose.yml.bak.YYYY-MM-DD_HHMMSS docker-compose.yml
cp .env.bak.YYYY-MM-DD_HHMMSS .env

docker compose up -d --no-deps --force-recreate new-api
```

Do not stop, remove, or recreate:

```text
1Panel-postgresql-joeA
1Panel-redis-FJDe
```
