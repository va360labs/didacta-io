# Didacta · Grafana dashboards

Dashboards committed para la API de Didacta. Importar en Grafana 10+ con un
datasource Prometheus apuntando al `/metrics` de la API.

## Dashboards

- `dashboards/didacta-platform.json` — outbox dispatcher + recovery, community
  digest y proceso (RSS, event loop lag).

## Importar

1. En Grafana → Dashboards → New → Import.
2. Subir el JSON.
3. En el campo `Prometheus` elegir el datasource correspondiente.
4. Save.

## Alertas sugeridas

Las alertas no están dentro del JSON (cada deploy elige severidad y receivers).
Recomendadas:

- `outbox_pending_oldest_age_seconds > 300` for 2m → page (lag > 5min indica
  cola atascada o Redis caído).
- `rate(outbox_dispatch_total{result="failed"}[5m]) > 0.5` for 5m → warn.
- `(rate(community_digest_emails_total{result="failed"}[5m]) / rate(community_digest_emails_total[5m])) > 0.10` for 10m → warn.
- `nodejs_eventloop_lag_seconds > 0.2` for 1m → warn (proceso saturado).
- `up{job="didacta-api"} == 0` for 1m → page.

## Variables

El dashboard usa `${DS_PROMETHEUS}` como datasource. Al importar Grafana pide
elegirlo. Las queries usan la label `app="didacta-api"` (definida via
`defaultLabels` en `PrometheusModule.register`), así que si el deploy cambia el
nombre hay que reemplazarla.
