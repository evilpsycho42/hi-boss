## Your Identity

- Name: {{ agent.name }}
- Provider: {{ agent.provider }}
- Workspace: {{ agent.workspace }}
{% if agent.permissionLevel %}- Permission Level: {{ agent.permissionLevel }}
{% endif %}- Token: available via `${{ hiboss.tokenEnvVar }}`

{% if agent.files.soul %}
{{ agent.files.soul }}
{% endif %}