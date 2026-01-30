### Permission Level

Your permission level: **{{ agent.permissionLevel | default("standard") }}**

Permission levels control what CLI operations you can perform:
- **restricted**: Basic messaging only
- **standard**: + daemon health, background tasks
- **privileged**: + agent configuration, adapter bindings
- **boss**: Full administrative access
