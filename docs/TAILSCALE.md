# Tailnet-only deployment with Tailscale

The helper script runs Vite preview on loopback and configures one tailnet-only `tailscale serve` HTTPS listener. It does not enable Funnel and does not reset unrelated Tailscale handlers.

## Defaults

| Setting | Default |
| --- | --- |
| MagicDNS host | Auto-detected from `tailscale status --json` |
| Local host | `127.0.0.1` |
| Local preview port | `4173` |
| Tailscale HTTPS port | `8443` |
| Runtime metadata | `.room-studio/runtime`; custom ports receive a port-specific directory, while the default ports can reuse legacy `.omx/runtime/room-studio` PID metadata |

These defaults preserve installations created before the script was generalized.

## Start and inspect

```bash
npm ci
npm run build
./scripts/tailscale-private-serve.sh start
./scripts/tailscale-private-serve.sh status
```

The status command verifies all of the following:

- the exact Tailscale HTTPS listener and loopback proxy;
- ownership, working directory, command, and listening port of the preview PID;
- a local request using the MagicDNS Host header;
- a real HTTPS request through MagicDNS.

## Configure another device or port

Override only the values that differ:

```bash
ROOM_STUDIO_TAILSCALE_HOST=my-device.example-tailnet.ts.net \
ROOM_STUDIO_HTTPS_PORT=9444 \
ROOM_STUDIO_LOOPBACK_PORT=4174 \
./scripts/tailscale-private-serve.sh start
```

Available variables:

- `ROOM_STUDIO_TAILSCALE_HOST`
- `ROOM_STUDIO_HTTPS_PORT`
- `ROOM_STUDIO_LOOPBACK_HOST`
- `ROOM_STUDIO_LOOPBACK_PORT`
- `ROOM_STUDIO_RUNTIME_DIR`

The script passes the selected MagicDNS host to Vite as `ROOM_STUDIO_ALLOWED_HOSTS`. For a manually launched preview, set a comma-separated allowlist yourself:

```bash
ROOM_STUDIO_ALLOWED_HOSTS=my-device.example-tailnet.ts.net npm run preview
```

## Stop safely

Use the same overrides that were used to start the service:

```bash
ROOM_STUDIO_HTTPS_PORT=9444 \
ROOM_STUDIO_LOOPBACK_PORT=4174 \
./scripts/tailscale-private-serve.sh stop
```

The script disables only the selected HTTPS port and terminates only a preview process whose PID, working directory, command, and listener all match this checkout. It deliberately never runs `tailscale serve reset`.
