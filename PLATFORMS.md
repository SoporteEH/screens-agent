# Platform Specific Instructions

## Raspberry Pi (Headless / Lite)

If you are using Raspberry Pi OS Lite (without a desktop environment), you can provision the agent using the command line.

### 1. Requirements
Install `xvfb` to allow Electron to run in a virtual frame buffer:
```bash
sudo apt-get update
sudo apt-get install -y xvfb
```

### 2. Headless Provisioning
You can configure the agent by passing the server URL via the command line. The agent will automatically attempt to fetch its authentication token if the device has been linked in the Admin Dashboard.

1. Get your **Machine ID** (displayed when you run the agent).
2. Link the device in your Admin Dashboard using that ID.
3. Once linked, run the following command to finalize provisioning:

```bash
xvfb-run screens-web-agent --no-sandbox --server=https://your-portal.com
```

**Note:** If you already have the token and want to force it, you can use:
`--server=URL --token=JWT_TOKEN`

### 3. Running as a Service (Recommended)
To ensure the agent starts automatically on boot, create a systemd service:

```bash
sudo nano /etc/systemd/system/screens-web-agent.service
```

Paste the following content:
```ini
[Unit]
Description=ScreensWeb Agent
After=network.target

[Service]
ExecStart=/usr/bin/xvfb-run /usr/bin/screens-web-agent --no-sandbox
Restart=always
User=pi
Group=pi
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
```

Then enable and start it:
```bash
sudo systemctl enable screens-web-agent
sudo systemctl start screens-web-agent
```

## Windows
The agent works normally with its graphical interface. For specialized deployments, you can also use the `--server` and `--token` flags in a shortcut or terminal.
