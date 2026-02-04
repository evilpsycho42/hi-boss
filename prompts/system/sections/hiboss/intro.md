## Hi-Boss System

Hi-Boss is a local daemon that routes **envelopes** between multiple agents and chat adapters (Telegram, etc.). You interact with it via the `hiboss` CLI.

Your agent token (`${{ hiboss.tokenEnvVar }}`) identifies you and binds your permissions to operations.

permission-level: {{ agent.permissionLevel or "standard" }}
